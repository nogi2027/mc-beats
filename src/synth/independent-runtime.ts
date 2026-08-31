import type { DeckSoundProfile } from '../deck.ts';
import type { Instrument, VoiceLane } from './contract.ts';
import { ProfileBus } from './profile-bus.ts';
import { VoicePool, type VoicePoolAddResult, type VoicePoolManyAddResult } from './voice-pool.ts';
import { SynthVoice } from './voice.ts';

export const INDEPENDENT_NOTE_LANES = ['live', 'deckA', 'deckB', 'solo', 'debug'] as const;
export type IndependentNoteLane = typeof INDEPENDENT_NOTE_LANES[number];

type LaneRuntime = {
  lane: IndependentNoteLane;
  output: GainNode;
  profileBuses: Map<string, ProfileBus>;
};

const asLane = (lane: VoiceLane): IndependentNoteLane => INDEPENDENT_NOTE_LANES.includes(lane as IndependentNoteLane) ? lane as IndependentNoteLane : 'live';

/**
 * Shared ownership and routing for the independent note engines. It keeps
 * profile buses cached and connected until disposal, while each SynthVoice
 * retains/releases its own bus user exactly once.
 */
export class IndependentVoiceRuntime {
  readonly context: BaseAudioContext;
  readonly destination: AudioNode;
  readonly instrument: Instrument;
  readonly enabledGain: GainNode;
  readonly pool: VoicePool;
  readonly lanes = new Map<IndependentNoteLane, LaneRuntime>();
  private enabled = true;
  private disposed = false;
  private disposalRequested = false;

  constructor(options: { context: BaseAudioContext; instrument: Instrument; destination?: AudioNode; limit: number }) {
    this.context = options.context;
    this.instrument = options.instrument;
    this.destination = options.destination ?? options.context.destination;
    this.enabledGain = options.context.createGain();
    this.enabledGain.gain.value = 1;
    this.enabledGain.connect(this.destination);
    this.pool = new VoicePool({ [options.instrument]: options.limit });
    INDEPENDENT_NOTE_LANES.forEach((lane) => {
      const output = options.context.createGain();
      output.gain.value = 1;
      output.connect(this.enabledGain);
      this.lanes.set(lane, { lane, output, profileBuses: new Map() });
    });
  }

  laneState(lane: VoiceLane) { return this.lanes.get(asLane(lane))!; }

  profileBus(laneName: VoiceLane, fingerprint: string, profile: DeckSoundProfile) {
    const lane = this.laneState(laneName);
    const existing = lane.profileBuses.get(fingerprint);
    if (existing) return existing;
    const bus = new ProfileBus(this.context, { fingerprint, profile });
    bus.output.connect(lane.output);
    lane.profileBuses.set(fingerprint, bus);
    return bus;
  }

  addVoice(voice: SynthVoice, bus: ProfileBus): VoicePoolAddResult {
    const result = this.pool.tryAdd(voice);
    if (result.status === 'rejected') {
      // No source has been started yet. This is a silent abort, not a choke.
      voice.abortBeforeStart();
      return result;
    }
    bus.retain();
    voice.onStopped((stopped) => {
      bus.release(stopped.cleanupAt);
      this.finishDisposalIfEmpty();
    });
    return result;
  }

  /** Allocate all children of a chord in one pool transaction. No profile
   * bus is retained until the pool has accepted the complete batch. */
  addVoicesAtomically(items: Array<{ voice: SynthVoice; bus: ProfileBus }>, at: number): VoicePoolManyAddResult {
    const result = this.pool.tryAddMany(items.map((item) => item.voice), at);
    if (result.status === 'rejected') {
      items.forEach(({ voice }) => voice.abortBeforeStart());
      return result;
    }
    items.forEach(({ voice, bus }) => {
      bus.retain();
      voice.onStopped((stopped) => {
        bus.release(stopped.cleanupAt);
        this.finishDisposalIfEmpty();
      });
    });
    return result;
  }

  startVoice(voice: SynthVoice, at: number) {
    try {
      voice.startSources(at);
    } catch (error) {
      // SynthVoice owns the started/unstarted source split. Dispose here so a
      // patch cannot retain a partially started voice after a start failure.
      voice.dispose();
      throw error;
    }
    return voice;
  }

  setEnabled(enabled: boolean, at = this.context.currentTime, updateState = true) {
    const parameter = this.enabledGain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(at);
    else {
      parameter.cancelScheduledValues(at);
      parameter.setValueAtTime(parameter.value, at);
    }
    parameter.linearRampToValueAtTime(enabled ? 1 : 0, at + .01);
    if (updateState) this.commitEnabled(enabled, at);
  }

  commitEnabled(enabled: boolean, at = this.context.currentTime) {
    this.enabled = enabled;
    if (!enabled) this.pool.stop(this.instrument, undefined, at);
  }

  cancelEnabledAutomation(at = this.context.currentTime) {
    const parameter = this.enabledGain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
  }

  profileBusCacheSize() {
    return [...this.lanes.values()].reduce((count, lane) => count + lane.profileBuses.size, 0);
  }

  retainedCount() { return this.pool.retainedCount(); }
  cleanupHorizon() { return Math.max(0, ...this.pool.all().map((voice) => voice.cleanupAt)); }

  setLaneGain(laneName: VoiceLane, value: number, at = this.context.currentTime, duration = .01) {
    const parameter = this.laneState(laneName).output.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const target = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    const span = Number.isFinite(duration) ? Math.max(.001, duration) : .01;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else {
      parameter.cancelScheduledValues(start);
      parameter.setValueAtTime(parameter.value, start);
    }
    parameter.linearRampToValueAtTime(target, start + span);
  }

  cancelLaneGainAutomation(laneName: VoiceLane, at = this.context.currentTime) {
    const parameter = this.laneState(laneName).output.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
  }

  laneGain(laneName: VoiceLane) { return this.laneState(laneName).output.gain.value; }

  isEnabled() { return this.enabled; }

  stopLane(lane: VoiceLane, at = this.context.currentTime) {
    this.pool.stop(this.instrument, asLane(lane), at);
  }

  stopAll(at = this.context.currentTime) { this.pool.stop(this.instrument, undefined, at); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposalRequested = true;
    this.pool.dispose();
    this.finishDisposalIfEmpty();
  }

  forceDispose() {
    this.pool.forceDispose();
    this.finishDisposalIfEmpty();
  }

  private finishDisposalIfEmpty() {
    if (!this.disposalRequested || this.pool.retainedCount() !== 0) return;
    this.lanes.forEach((lane) => {
      lane.profileBuses.forEach((bus) => bus.disconnect(Number.POSITIVE_INFINITY));
      lane.profileBuses.clear();
      try { lane.output.disconnect(); } catch { /* already disconnected */ }
    });
    try { this.enabledGain.disconnect(); } catch { /* already disconnected */ }
    this.disposalRequested = false;
  }

  isDisposed() { return this.disposed; }
}
