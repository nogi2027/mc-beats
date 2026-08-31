import type { Instrument, VoiceLane, VoiceProfileSnapshot, VoiceState } from './contract.ts';
import { VoiceEnvelope, type EnvelopeSchedule, safeAutomationTime, safeReleaseTime } from './envelope.ts';
import { cloneAndFreezeProfile } from './profile-bus.ts';

export const sourceStopGuardSeconds = (sampleRate: number) => (128 * 2) / (Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000);

export type VoiceTiming = {
  startAt: number;
  noteOffAt: number | null;
  releaseEndAt: number | null;
  stopAt: number | null;
};

export type VoiceSource = AudioScheduledSourceNode;
export type VoiceReleaseKind = 'natural' | 'choke';
export const CHOKE_EFFECT_TAIL_SECONDS = 0.02;

export class SynthVoice {
  readonly id: string;
  readonly instrument: Instrument;
  readonly lane: VoiceLane;
  readonly profile: VoiceProfileSnapshot;
  readonly finalGain: GainNode;
  readonly envelope: VoiceEnvelope;
  readonly sources = new Set<VoiceSource>();
  readonly nodes = new Set<AudioNode>();
  readonly timing: VoiceTiming;
  private stateValue: VoiceState = 'scheduled';
  private endedSources = new Set<VoiceSource>();
  private startedSources = new Set<VoiceSource>();
  private stopScheduledSources = new Set<VoiceSource>();
  private readonly sourceStartTimes = new Map<VoiceSource, number>();
  private disposed = false;
  private releaseResult: { start: number; end: number } | null = null;
  private releaseKind: VoiceReleaseKind | null = null;
  private stopAt: number | null = null;
  private finishedCallback = false;
  private disconnected = false;
  private started = false;
  private readonly stoppedListeners = new Set<(voice: SynthVoice) => void>();
  private readonly releaseListeners = new Set<(when: number, end: number, kind: VoiceReleaseKind) => void>();
  private readonly stoppedCallback?: (voice: SynthVoice) => void;
  private readonly context?: BaseAudioContext;
  private effectTailSecondsValue = 0;
  private effectTailEndAtValue = 0;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    id: string;
    instrument: Instrument;
    lane: VoiceLane;
    profile: VoiceProfileSnapshot;
    finalGain: GainNode;
    context?: BaseAudioContext;
    onStopped?: (voice: SynthVoice) => void;
  }) {
    this.id = options.id;
    this.instrument = options.instrument;
    this.lane = options.lane;
    this.profile = { fingerprint: options.profile.fingerprint, profile: cloneAndFreezeProfile(options.profile.profile as Parameters<typeof cloneAndFreezeProfile>[0]) };
    this.finalGain = options.finalGain;
    this.context = options.context;
    this.stoppedCallback = options.onStopped;
    this.finalGain.gain.value = 0;
    this.envelope = new VoiceEnvelope(this.finalGain.gain);
    this.timing = { startAt: 0, noteOffAt: null, releaseEndAt: null, stopAt: null };
    this.nodes.add(this.finalGain);
  }

  get state() { return this.stateAt(this.context?.currentTime ?? this.timing.startAt); }
  get audioTime() { return this.context?.currentTime ?? 0; }
  stateAt(audioTime: number): VoiceState {
    if (this.stateValue === 'stopped') return 'stopped';
    if (!this.started) return 'scheduled';
    const at = Number.isFinite(audioTime) ? audioTime : this.timing.startAt;
    if (at < this.timing.startAt) return 'scheduled';
    if (this.releaseResult && at >= this.releaseResult.start) return 'releasing';
    return 'active';
  }
  /** Musical capacity ends when the note's release reaches zero. A later
   * effect tail remains retained for cleanup but does not block a new note. */
  isMusicallyAllocatedAt(audioTime: number) {
    if (this.stateValue === 'stopped' || !this.started) return false;
    const at = Number.isFinite(audioTime) ? audioTime : this.timing.startAt;
    if (at < this.timing.startAt) return false;
    return this.releaseResult === null || at < this.releaseResult.end;
  }
  isRetiringAt(audioTime: number) {
    if (this.stateValue === 'stopped' || !this.releaseResult) return false;
    const at = Number.isFinite(audioTime) ? audioTime : this.timing.startAt;
    return at >= this.releaseResult.start && at < this.releaseResult.end;
  }
  isRetainedTailAt(audioTime: number) {
    if (this.stateValue === 'stopped' || !this.releaseResult) return false;
    const at = Number.isFinite(audioTime) ? audioTime : this.timing.startAt;
    // Keep the object counted until its sources report ended. The expected
    // cleanup deadline is useful for scheduling, but a delayed ended event
    // must not make the pool forget a still-connected tail.
    return at >= this.releaseResult.end;
  }
  get isAudible() {
    const state = this.state;
    if (state === 'active') return true;
    if (state !== 'releasing') return false;
    const now = this.context?.currentTime;
    return now === undefined || !Number.isFinite(now) || !this.releaseResult || now < this.releaseResult.end;
  }
  get remainingSourceCount() { return this.sources.size - this.endedSources.size; }
  get startedSourceCount() { return this.startedSources.size; }
  get effectTailSeconds() { return this.effectTailSecondsValue; }
  get effectTailEndAt() { return this.effectTailEndAtValue; }
  get cleanupAt() { return Math.max(this.timing.stopAt ?? 0, this.effectTailEndAtValue); }

  onStopped(listener: (voice: SynthVoice) => void) {
    if (this.finishedCallback) listener(this);
    else this.stoppedListeners.add(listener);
    return () => this.stoppedListeners.delete(listener);
  }

  onRelease(listener: (when: number, end: number, kind: VoiceReleaseKind) => void) {
    if (this.releaseResult) listener(this.releaseResult.start, this.releaseResult.end, this.releaseKind ?? 'natural');
    else this.releaseListeners.add(listener);
    return () => this.releaseListeners.delete(listener);
  }

  /** Declare the finite drain time of note-owned effects after the final
   * envelope reaches zero. It is deliberately a patch-owned value: the
   * common voice lifecycle only owns the cleanup deadline. */
  setEffectTailSeconds(seconds: number) {
    if (this.started || this.releaseResult) throw new Error('Effect tail must be declared before a voice starts.');
    this.effectTailSecondsValue = Number.isFinite(seconds) ? Math.max(0, Math.min(8, seconds)) : 0;
    return this;
  }

  addNode(node: AudioNode) { if (!this.disposed) this.nodes.add(node); return node; }

  addSource(source: VoiceSource, startAt?: number) {
    if (this.disposed || this.stateValue === 'stopped') throw new Error(`Cannot add a source to stopped voice ${this.id}.`);
    const firstSource = this.sources.size === 0;
    this.sources.add(source);
    this.nodes.add(source);
    this.sourceStartTimes.set(source, Number.isFinite(startAt) ? startAt as number : this.timing.startAt);
    source.addEventListener('ended', () => this.markSourceEnded(source));
    if (startAt !== undefined && firstSource) this.timing.startAt = startAt;
    if (this.stopAt !== null) this.scheduleSourceStop(source, this.stopAt);
    return source;
  }

  private markSourceEnded(source: VoiceSource) {
    if (this.endedSources.has(source)) return;
    this.endedSources.add(source);
    if (this.endedSources.size >= this.sources.size) this.finish();
  }

  /** Start all sources as one voice-owned operation. A partial start is
   * treated as a failed voice, never as a successful allocation. */
  startSources(at = this.timing.startAt) {
    if (this.disposed || this.stateValue === 'stopped') return this;
    const startAt = Number.isFinite(at) ? at : this.timing.startAt;
    try {
      for (const source of this.sources) {
        if (this.startedSources.has(source)) continue;
        source.start(this.sourceStartTimes.get(source) ?? startAt);
        this.startedSources.add(source);
        // Browsers reject stop() before start(). Finite drum and metronome
        // voices schedule their release before runtime starts their sources, so
        // reapply any stop that could not be accepted until the source is live.
        if (this.stopAt !== null && !this.stopScheduledSources.has(source)) this.scheduleSourceStop(source, this.stopAt);
      }
    } catch (error) {
      for (const source of this.sources) {
        if (!this.startedSources.has(source)) this.endedSources.add(source);
      }
      if (this.startedSources.size === 0) this.abortBeforeStart();
      else this.choke(this.context?.currentTime ?? startAt, 0.012);
      throw error;
    }
    return this;
  }

  /** Abort a voice whose sources have not started. Its gain starts at zero,
   * so immediate cleanup cannot cut audible audio. */
  abortBeforeStart() {
    if (this.disposed || this.finishedCallback) return;
    if (this.startedSources.size > 0) return;
    this.sources.forEach((source) => this.endedSources.add(source));
    // A voice that never started cannot have an audible effect tail. Do not
    // retain a rejected future finite voice until its planned release time.
    this.effectTailEndAtValue = 0;
    this.stopAt = null;
    this.timing.stopAt = null;
    this.finish();
  }

  start(startAt: number, schedule: EnvelopeSchedule, peak = 1, protectLate = false) {
    if (this.disposed || this.stateValue === 'stopped') return this;
    const currentTime = this.context?.currentTime ?? startAt;
    const sampleRate = this.context?.sampleRate ?? 48000;
    const timing = safeAutomationTime(startAt, currentTime, sampleRate, protectLate);
    this.timing.startAt = timing.scheduledAt;
    this.envelope.noteOn(timing.scheduledAt, schedule, peak);
    this.started = true;
    this.stateValue = timing.scheduledAt > currentTime ? 'scheduled' : 'active';
    return this;
  }

  release(at: number, duration: number, protectLate = false) {
    if (this.disposed || this.stateValue === 'stopped') return this.releaseResult;
    if (this.releaseResult) return this.releaseResult;
    const currentTime = this.context?.currentTime ?? at;
    const timing = safeAutomationTime(at, currentTime, this.context?.sampleRate ?? 48000, protectLate);
    const release = this.envelope.release(timing.scheduledAt, safeReleaseTime(duration));
    this.releaseResult = release;
    this.releaseKind = 'natural';
    this.stateValue = 'releasing';
    this.timing.noteOffAt = timing.scheduledAt;
    this.timing.releaseEndAt = release?.end ?? timing.scheduledAt;
    this.scheduleSourceStops(this.timing.releaseEndAt);
    this.effectTailEndAtValue = (this.timing.releaseEndAt ?? timing.scheduledAt) + this.effectTailSecondsValue;
    this.releaseListeners.forEach((listener) => listener(timing.scheduledAt, release?.end ?? timing.scheduledAt, 'natural'));
    if (this.sources.size === 0 || this.endedSources.size >= this.sources.size) this.finish();
    return release;
  }

  choke(at: number, duration = 0.02, protectLate = false) {
    if (this.disposed || this.stateValue === 'stopped') return this.releaseResult;
    const currentTime = this.context?.currentTime ?? at;
    const timing = safeAutomationTime(at, currentTime, this.context?.sampleRate ?? 48000, protectLate);
    if (this.releaseResult && this.releaseKind === 'choke' && timing.scheduledAt >= this.releaseResult.start && (this.releaseResult.end ?? Number.POSITIVE_INFINITY) <= timing.scheduledAt + Math.max(0.012, duration)) return this.releaseResult;
    const release = this.envelope.choke(timing.scheduledAt, Math.max(0.012, duration));
    this.releaseResult = release;
    this.releaseKind = 'choke';
    this.stateValue = 'releasing';
    this.timing.noteOffAt = timing.scheduledAt;
    this.timing.releaseEndAt = release?.end ?? timing.scheduledAt;
    this.scheduleSourceStops(this.timing.releaseEndAt);
    // A forced choke must replace a long natural effect tail. The patch's
    // release listener receives the kind and fades wet/feedback paths again.
    this.effectTailEndAtValue = (this.timing.releaseEndAt ?? timing.scheduledAt) + CHOKE_EFFECT_TAIL_SECONDS;
    this.releaseListeners.forEach((listener) => listener(timing.scheduledAt, release?.end ?? timing.scheduledAt, 'choke'));
    if (this.sources.size === 0 || this.endedSources.size >= this.sources.size) this.finish();
    return release;
  }

  private scheduleSourceStops(releaseEnd: number | null | undefined) {
    if (releaseEnd === null || releaseEnd === undefined) return;
    const stopAt = releaseEnd + sourceStopGuardSeconds(this.context?.sampleRate ?? 48000);
    if (this.stopAt !== null && stopAt >= this.stopAt) return;
    this.stopAt = stopAt;
    this.timing.stopAt = stopAt;
    this.sources.forEach((source) => this.scheduleSourceStop(source, stopAt));
  }

  private scheduleSourceStop(source: VoiceSource, stopAt: number) {
    try {
      source.stop(stopAt);
      this.stopScheduledSources.add(source);
    } catch { /* startSources retries browsers that reject stop-before-start */ }
  }

  stop(at?: number) {
    if (this.disposed || this.stateValue === 'stopped') return;
    const when = at ?? this.context?.currentTime ?? 0;
    this.choke(when, 0.012);
    if (this.sources.size === 0 || this.endedSources.size >= this.sources.size) this.finish();
  }

  /** Re-check cleanup after a fake/offline clock advances. Live contexts also
   * use the timer scheduled below because source `ended` does not carry an
   * effect-tail event. */
  finishIfSilent(at = this.context?.currentTime ?? 0) { this.finish(at); }

  private finish(at = this.context?.currentTime ?? 0) {
    if (this.finishedCallback) return;
    if (this.endedSources.size < this.sources.size) return;
    if (at < this.effectTailEndAtValue) {
      if (this.tailTimer === null) {
        const delayMs = Math.max(1, (this.effectTailEndAtValue - at) * 1000 + 2);
        this.tailTimer = setTimeout(() => {
          this.tailTimer = null;
          this.finish();
        }, delayMs);
        const timer = this.tailTimer as unknown as { unref?: () => void };
        timer.unref?.();
      }
      return;
    }
    this.finishedCallback = true;
    this.stateValue = 'stopped';
    this.envelope.markStopped();
    this.disconnectNodes();
    this.stoppedCallback?.(this);
    this.stoppedListeners.forEach((listener) => listener(this));
    this.stoppedListeners.clear();
    this.releaseListeners.clear();
  }

  private disconnectNodes() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.nodes.forEach((node) => { try { node.disconnect(); } catch { /* already disconnected */ } });
    this.nodes.clear();
    this.sourceStartTimes.clear();
    this.stopScheduledSources.clear();
  }

  private finalizeStop() {
    if (this.finishedCallback) return;
    this.finishedCallback = true;
    this.stateValue = 'stopped';
    this.envelope.markStopped();
    this.disconnectNodes();
    this.stoppedCallback?.(this);
    this.stoppedListeners.forEach((listener) => listener(this));
    this.stoppedListeners.clear();
    this.releaseListeners.clear();
  }

  /** Hard teardown used only when a suspended context cannot deliver source
   * ended events. The normal path always waits for the safe audio tail. */
  forceDispose() {
    if (this.finishedCallback) return;
    if (this.tailTimer !== null) {
      clearTimeout(this.tailTimer);
      this.tailTimer = null;
    }
    this.effectTailEndAtValue = 0;
    this.stopAt = null;
    this.timing.stopAt = null;
    this.disposed = true;
    this.finalizeStop();
  }

  dispose() {
    if (this.disposed) return;
    // stateValue records the latest scheduled lifecycle event, while state is
    // time-aware. A finite note can have a future release already scheduled
    // but still be active now, so disposal must use the present state rather
    // than treating that future event as a reason to skip the stop path.
    const presentState = this.state;
    if ((presentState === 'active' || presentState === 'scheduled' || presentState === 'releasing') && this.startedSources.size === 0) this.abortBeforeStart();
    else if (presentState === 'active' || presentState === 'scheduled' || presentState === 'releasing') this.stop();
    else if (presentState === 'stopped') this.disconnectNodes();
    this.disposed = true;
  }
}
