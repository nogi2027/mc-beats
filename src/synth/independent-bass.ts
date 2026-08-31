import type { DeckSoundProfile } from '../deck.ts';
import { safeAutomationTime } from './envelope.ts';
import type { IndependentBassTransitionSnapshot, ReleaseNoteResult, VoiceLane, VoiceStatsSnapshot, VoiceCountSnapshot } from './contract.ts';
import { cloneAndFreezeProfile, ProfileBus } from './profile-bus.ts';
import { VoicePool } from './voice-pool.ts';
import { bassProfileFingerprint, BASS_PRESETS, DEFAULT_BASS_PROFILE, createBassVoice, type BassPatchProfile, type BassVoiceBuild } from './patches/bass.ts';

export { BASS_PRESETS } from './patches/bass.ts';

export const INDEPENDENT_BASS_LANES = ['live', 'deckA', 'deckB', 'solo', 'debug'] as const;
export type IndependentBassLane = typeof INDEPENDENT_BASS_LANES[number];

/** Physical key state must outlive the short-lived voice that renders it. */
type HeldBass = { id: string; midi: number; order: number; profile: BassPatchProfile; voice: import('./voice.ts').SynthVoice };
type CurrentBass = { voice: import('./voice.ts').SynthVoice; midi: number; frequency: number; heldId?: string; token: number };
type LaneState = {
  lane: IndependentBassLane;
  output: GainNode;
  profile: Readonly<DeckSoundProfile>;
  held: Map<string, HeldBass>;
  current: CurrentBass | null;
  profileBuses: Map<string, ProfileBus>;
};

export type IndependentBassTransition = IndependentBassTransitionSnapshot;

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const safeDuration = (duration: number) => Number.isFinite(duration) ? Math.max(.001, duration) : .001;
const safeRelease = (profile: BassPatchProfile) => Math.max(.012, profile.releaseSeconds);

const zeroCounts = (): VoiceCountSnapshot => ({ groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 });

/**
 * A bass-only engine used by Phase 2 tests and later integration. It shares
 * only the neutral Phase 1 runtime classes with the legacy engine.
 */
export class IndependentBassEngine {
  readonly context: BaseAudioContext;
  readonly destination: AudioNode;
  readonly enabledGain: GainNode;
  readonly pool: VoicePool;
  private readonly lanes = new Map<IndependentBassLane, LaneState>();
  private readonly transitions: IndependentBassTransition[] = [];
  private enabled = true;
  private heldOrder = 0;
  private noteToken = 0;
  private voiceToken = 0;
  private disposed = false;
  private graphsDisconnected = false;
  private lastRejectedVoice: import('./voice.ts').SynthVoice | null = null;
  private lastStartFailureVoice: import('./voice.ts').SynthVoice | null = null;

  constructor(options: { context: BaseAudioContext; destination?: AudioNode; defaultProfile?: DeckSoundProfile }) {
    this.context = options.context;
    this.destination = options.destination ?? options.context.destination;
    this.enabledGain = options.context.createGain();
    this.enabledGain.gain.value = 1;
    this.enabledGain.connect(this.destination);
    this.pool = new VoicePool({ bass: 8 });
    const profile = cloneAndFreezeProfile(options.defaultProfile ?? DEFAULT_BASS_PROFILE)!;
    INDEPENDENT_BASS_LANES.forEach((lane) => {
      const output = options.context.createGain();
      output.gain.value = 1;
      output.connect(this.enabledGain);
      this.lanes.set(lane, { lane, output, profile, held: new Map(), current: null, profileBuses: new Map() });
    });
  }

  async start() {
    const context = this.context as AudioContext;
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  }

  private laneState(lane: VoiceLane): LaneState {
    const selected = INDEPENDENT_BASS_LANES.includes(lane as IndependentBassLane) ? lane as IndependentBassLane : 'live';
    return this.lanes.get(selected)!;
  }

  private profileBus(lane: LaneState, profile: DeckSoundProfile) {
    const fingerprint = bassProfileFingerprint(profile);
    const existing = lane.profileBuses.get(fingerprint);
    if (existing) return existing;
    const bus = new ProfileBus(this.context, { fingerprint, profile });
    bus.output.connect(lane.output);
    lane.profileBuses.set(fingerprint, bus);
    return bus;
  }

  private cleanupBus(bus: ProfileBus, at: number) {
    bus.release(at);
  }

  private buildVoice(lane: LaneState, midi: number, startAt: number, profile: DeckSoundProfile, velocity: number, heldId?: string): BassVoiceBuild {
    const previous = lane.current;
    const patch = createBassVoice({
      context: this.context,
      id: `bass-${lane.lane}-${++this.voiceToken}`,
      lane: lane.lane,
      midi,
      startAt,
      velocity: clamp(velocity),
      profile,
      profileBus: this.profileBus(lane, profile),
      glideFromHz: previous?.frequency,
    });
    return { ...patch, profile: patch.profile };
  }

  private trigger(laneName: VoiceLane, midi: number, duration: number | null, requestedAt: number, profileInput: DeckSoundProfile | undefined, velocity: number, heldId?: string) {
    if (this.disposed || !this.enabled) return null;
    const lane = this.laneState(laneName);
    const live = lane.lane === 'live';
    const timing = safeAutomationTime(requestedAt, this.context.currentTime, this.context.sampleRate, live);
    const startAt = timing.scheduledAt;
    const profile = profileInput ? cloneAndFreezeProfile(profileInput)! : lane.profile;
    const build = this.buildVoice(lane, midi, startAt, profile, velocity, heldId);
    const added = this.pool.tryAdd(build.voice);
    if (added.status === 'rejected') {
      this.transitions.push({ voiceId: build.voice.id, lane: lane.lane, cause: 'rejected', requestedAt, scheduledAt: startAt, end: startAt });
      this.lastRejectedVoice = build.voice;
      build.voice.abortBeforeStart();
      return null;
    }

    const bus = build.profileBus;
    bus.retain();
    build.voice.onStopped((voice) => {
      const end = voice.timing.stopAt ?? this.context.currentTime;
      this.cleanupBus(bus, end);
      if (lane.current?.voice === voice) lane.current = null;
      this.maybeDisconnectGraphs();
    });

    // Only a held live voice has monophonic last-note priority. Release tails
    // and finite deck/solo voices stay independent and keep their own profile.
    const previous = lane.current;
    if (lane.lane === 'live' && heldId && previous && previous.voice.state !== 'releasing' && previous.voice.state !== 'stopped') {
      const fade = .02;
      previous.voice.choke(startAt, fade);
      this.transitions.push({ voiceId: previous.voice.id, lane: lane.lane, cause: 'choke', requestedAt, scheduledAt: startAt, end: startAt + fade });
    }

    try {
      build.voice.startSources(startAt);
    } catch (error) {
      this.lastStartFailureVoice = build.voice;
      this.pool.remove(build.voice.id);
      throw error;
    }
    const current: CurrentBass = { voice: build.voice, midi, frequency: build.frequency, heldId, token: ++this.noteToken };
    lane.current = current;
    if (duration !== null) {
      const gate = safeDuration(duration);
      const releaseAt = startAt + gate;
      const release = build.voice.release(releaseAt, safeRelease(build.profile));
      if (release) this.transitions.push({ voiceId: build.voice.id, lane: lane.lane, cause: 'natural-release', requestedAt: releaseAt, scheduledAt: release.start, end: release.end });
    }
    return { ...build, startAt, timing, current };
  }

  note(midi: number, duration: number | null = null, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    const build = this.trigger(lane, midi, duration, at, profile, velocity);
    return build?.sources ?? [];
  }

  holdNoteInLane(id: string, midi: number, profile?: DeckSoundProfile, laneName: VoiceLane = 'live') {
    this.releaseNoteInLane(id, laneName);
    const build = this.trigger(laneName, midi, null, this.context.currentTime, profile, 1, id);
    if (!build) return [] as OscillatorNode[];
    const lane = this.laneState(laneName);
    lane.held.set(id, { id, midi, order: ++this.heldOrder, profile: build.profile, voice: build.voice });
    return build.sources;
  }

  holdNote(id: string, midi: number, profile?: DeckSoundProfile) { return this.holdNoteInLane(id, midi, profile, 'live'); }
  holdDebugNote(id: string, midi: number, profile?: DeckSoundProfile) { return this.holdNoteInLane(id, midi, profile, 'debug'); }

  hasHeldNoteInLane(id: string, laneName: VoiceLane = 'live') { return this.laneState(laneName).held.has(id); }
  hasHeldNote(id: string) { return this.hasHeldNoteInLane(id, 'live'); }

  releaseNoteInLane(id: string, laneName: VoiceLane = 'live'): ReleaseNoteResult | null {
    if (laneName === 'live') return this.releaseNote(id);
    const lane = this.laneState(laneName);
    const held = lane.held.get(id);
    if (!held) return null;
    lane.held.delete(id);
    const now = this.context.currentTime;
    const release = held.voice.release(now, safeRelease(held.profile), true);
    return { id, instrument: 'bass', requestedAt: now, voiceCount: 1, ...(release ? { scheduledAt: release.start, safetyOffsetSeconds: release.start - now } : {}) };
  }

  releaseNote(id: string): ReleaseNoteResult | null {
    const lane = this.laneState('live');
    const held = lane.held.get(id);
    if (!held) return null;
    lane.held.delete(id);
    const now = this.context.currentTime;
    const current = lane.current;
    let fallback: HeldBass | undefined;
    if (current?.heldId === id) {
      fallback = [...lane.held.values()].sort((left, right) => right.order - left.order)[0];
      if (fallback) {
        const fallbackBuild = this.trigger('live', fallback.midi, null, now, fallback.profile.profile as DeckSoundProfile, 1, fallback.id);
        if (fallbackBuild) lane.held.set(fallback.id, { ...fallback, profile: fallbackBuild.profile, voice: fallbackBuild.voice });
        else {
          current.voice.release(now, safeRelease(held.profile), true);
          lane.current = null;
        }
      }
      else {
        const release = current.voice.release(now, safeRelease(held.profile), true);
        lane.current = null;
        if (release) this.transitions.push({ voiceId: current.voice.id, lane: 'live', cause: 'natural-release', requestedAt: now, scheduledAt: release.start, end: release.end });
      }
    }
    const releaseVoice = fallback ? null : current?.heldId === id ? current.voice : null;
    const release = fallback ? null : releaseVoice?.timing.releaseEndAt;
    return { id, instrument: 'bass', requestedAt: now, voiceCount: 1, ...(release === null || release === undefined ? {} : { scheduledAt: releaseVoice?.timing.noteOffAt ?? now, safetyOffsetSeconds: (releaseVoice?.timing.noteOffAt ?? now) - now }) };
  }

  updateBassLaneProfile(laneName: VoiceLane, profile?: DeckSoundProfile, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    const next = cloneAndFreezeProfile(profile ?? DEFAULT_BASS_PROFILE)!;
    const changed = bassProfileFingerprint(lane.profile) !== bassProfileFingerprint(next);
    lane.profile = next;
    return { applied: true, deferred: false, changed, at };
  }

  profile(lane: VoiceLane = 'live') { return this.laneState(lane).profile; }

  setPreset(lane: VoiceLane, index: number) {
    const preset = BASS_PRESETS[Math.max(0, Math.min(BASS_PRESETS.length - 1, Math.floor(index)))];
    return this.updateBassLaneProfile(lane, preset);
  }

  setLaneGain(laneName: VoiceLane, value: number, at = this.context.currentTime, duration = .01) {
    const lane = this.laneState(laneName);
    const target = clamp(value, 0, 2);
    const parameter = lane.output.gain;
    const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(at);
    else { controlled.cancelScheduledValues(at); controlled.setValueAtTime(parameter.value, at); }
    controlled.linearRampToValueAtTime(target, at + Math.max(.001, duration));
  }

  cancelLaneGainAutomation(laneName: VoiceLane, at = this.context.currentTime) {
    const parameter = this.laneState(laneName).output.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
  }

  laneGain(laneName: VoiceLane) { return this.laneState(laneName).output.gain.value; }

  setInstrumentEnabled(enabled: boolean, at = this.context.currentTime, updateState = true) {
    this.scheduleInstrumentEnabled(enabled, at);
    if (updateState) this.commitInstrumentEnabled(enabled, at);
  }

  private scheduleInstrumentEnabled(enabled: boolean, at: number) {
    const parameter = this.enabledGain.gain;
    const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(at);
    else { controlled.cancelScheduledValues(at); controlled.setValueAtTime(parameter.value, at); }
    controlled.linearRampToValueAtTime(enabled ? 1 : 0, at + .01);
  }

  commitInstrumentEnabled(enabled: boolean, at = this.context.currentTime) {
    this.enabled = enabled;
    if (!enabled) {
      INDEPENDENT_BASS_LANES.forEach((laneName) => {
        const lane = this.lanes.get(laneName)!;
        lane.held.clear();
        lane.current = null;
      });
      this.pool.stop('bass', undefined, at);
    }
  }

  cancelInstrumentAutomation(at = this.context.currentTime) {
    const parameter = this.enabledGain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
  }

  isInstrumentEnabled() { return this.enabled; }

  stopLane(laneName: VoiceLane, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    lane.held.clear();
    lane.current = null;
    this.pool.byLane(lane.lane).forEach((voice) => {
      this.transitions.push({ voiceId: voice.id, lane: lane.lane, cause: 'stop', requestedAt: at, scheduledAt: at, end: at + .012 });
    });
    this.pool.stop('bass', lane.lane, at);
  }

  stopDeckVoices(lane?: VoiceLane) {
    if (lane === 'deckA' || lane === 'deckB') this.stopLane(lane);
    else { this.stopLane('deckA'); this.stopLane('deckB'); }
  }

  panic() {
    INDEPENDENT_BASS_LANES.forEach((lane) => this.stopLane(lane));
  }

  debugNote(midi: number, duration: number, at = this.context.currentTime, profile?: DeckSoundProfile, velocity = 1) {
    return this.note(midi, duration, at, profile, 'debug', velocity);
  }

  releaseTransitions() { return this.transitions.map((transition) => ({ ...transition })); }
  retainedCount() { return this.pool.retainedCount(); }
  cleanupHorizon() { return Math.max(0, ...this.pool.all().map((voice) => voice.cleanupAt)); }
  getProfileBusSnapshots(lane: VoiceLane = 'live') { return [...this.laneState(lane).profileBuses.values()].map((bus) => bus.snapshot()); }
  profileDestinationCacheSize() { return [...this.lanes.values()].reduce((count, lane) => count + lane.profileBuses.size, 0); }
  getLastRejectedVoice() { return this.lastRejectedVoice; }
  getLastStartFailureVoice() { return this.lastStartFailureVoice; }

  getVoiceStats(): VoiceStatsSnapshot {
    const bass = {
      groups: this.pool.retainedCount('bass'),
      active: this.pool.activeCount('bass'),
      releasing: this.pool.retiringCount('bass'),
      voices: this.pool.all().reduce((count, voice) => count + voice.remainingSourceCount, 0),
      musicalVoices: this.pool.allocatedCount('bass'),
    };
    return { bass, lead: zeroCounts(), chords: zeroCounts(), activeSources: this.pool.all().reduce((count, voice) => count + voice.remainingSourceCount, 0) };
  }

  getSynthSnapshot() {
    return {
      bassLanes: INDEPENDENT_BASS_LANES.map((lane) => {
        const state = this.lanes.get(lane)!;
        return {
          lane,
          persistent: false,
          currentMidi: state.current?.midi ?? null,
          currentHeldId: state.current?.heldId ?? null,
          profilePresetId: state.profile.presetId,
          graphProfile: null,
          pendingProfilePresetId: null,
          pendingGraphProfile: null,
          envelopeSegments: [],
          vcaSegments: [],
          independentVoiceIds: this.pool.byLane(lane).map((voice) => voice.id),
        };
      }),
      voiceStats: this.getVoiceStats(),
      // Independent transitions are scheduling metadata only. The engine has
      // not captured PCM here, so measured diagnostics must stay empty.
      bassReleaseDiagnostics: [],
      independentBassTransitions: this.transitions.map((transition) => ({ ...transition })),
    };
  }

  private maybeDisconnectGraphs() {
    if (!this.disposed || this.graphsDisconnected || this.pool.retainedCount() > 0) return;
    this.lanes.forEach((lane) => {
      lane.profileBuses.forEach((bus) => bus.disconnect(Number.POSITIVE_INFINITY));
      try { lane.output.disconnect(); } catch { /* already disconnected */ }
    });
    try { this.enabledGain.disconnect(); } catch { /* already disconnected */ }
    this.graphsDisconnected = true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lanes.forEach((lane) => { lane.held.clear(); lane.current = null; });
    this.pool.dispose();
    this.maybeDisconnectGraphs();
    this.transitions.length = 0;
  }

  forceDispose() {
    this.pool.forceDispose();
    this.maybeDisconnectGraphs();
  }
}

export { IndependentBassEngine as IndependentBassManager };
