import type { DeckSoundProfile } from '../deck.ts';
import type { ReleaseNoteResult, VoiceCountSnapshot, VoiceLane, VoiceStatsSnapshot } from './contract.ts';
import { safeAutomationTime } from './envelope.ts';
import { IndependentVoiceRuntime, INDEPENDENT_NOTE_LANES, type IndependentNoteLane } from './independent-runtime.ts';
import { cloneAndFreezeProfile } from './profile-bus.ts';
import { createMetronomeVoice, DEFAULT_METRONOME_PROFILE, METRONOME_PRESETS, metronomeProfileFingerprint, normalizeMetronomeProfile, type MetronomePatchProfile } from './patches/metronome.ts';

type HeldMetronome = { id: string; voice: ReturnType<typeof createMetronomeVoice>['voice']; profile: MetronomePatchProfile };
type MetronomeLaneState = { lane: IndependentNoteLane; profile: Readonly<DeckSoundProfile>; held: Map<string, HeldMetronome> };
const zeroCounts = (): VoiceCountSnapshot => ({ groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 });
const clamp = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Independent metronome clicks. It uses the same voice lifecycle as drums,
 * but keeps the existing click profile and preset values. */
export class IndependentMetronomeEngine {
  readonly context: BaseAudioContext;
  readonly runtime: IndependentVoiceRuntime;
  private readonly lanes = new Map<IndependentNoteLane, MetronomeLaneState>();
  private hitNumber = 0;
  private disposed = false;

  constructor(options: { context: BaseAudioContext; destination?: AudioNode; defaultProfile?: DeckSoundProfile }) {
    this.context = options.context;
    this.runtime = new IndependentVoiceRuntime({ context: options.context, instrument: 'metronome', destination: options.destination, limit: 4 });
    const profile = cloneAndFreezeProfile(options.defaultProfile ?? DEFAULT_METRONOME_PROFILE)!;
    INDEPENDENT_NOTE_LANES.forEach((lane) => this.lanes.set(lane, { lane, profile, held: new Map() }));
  }

  async start() {
    const context = this.context as AudioContext;
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  }

  private laneState(lane: VoiceLane) { return this.lanes.get(this.runtime.laneState(lane).lane)!; }

  private profileFor(lane: MetronomeLaneState, supplied?: DeckSoundProfile) {
    return supplied ? cloneAndFreezeProfile(supplied)! : lane.profile;
  }

  private trigger(laneName: VoiceLane, accent: boolean, requestedAt: number, durationSeconds: number | null, profileInput?: DeckSoundProfile, velocity = 1, frequencyOverride?: number, heldId?: string) {
    if (this.disposed || !this.runtime.isEnabled()) return null;
    const lane = this.laneState(laneName);
    const timing = safeAutomationTime(requestedAt, this.context.currentTime, this.context.sampleRate, lane.lane === 'live');
    const startAt = timing.scheduledAt;
    const profile = this.profileFor(lane, profileInput);
    const bus = this.runtime.profileBus(lane.lane, metronomeProfileFingerprint(profile), profile);
    const build = createMetronomeVoice({
      context: this.context,
      id: `metronome-${lane.lane}-${++this.hitNumber}`,
      lane: lane.lane,
      startAt,
      accent,
      durationSeconds,
      frequencyOverride,
      velocity: clamp(velocity),
      profile,
      profileBus: bus,
    });
    const allocation = this.runtime.addVoice(build.voice, bus);
    if (allocation.status === 'rejected') return null;
    try {
      this.runtime.startVoice(build.voice, startAt);
    } catch {
      return null;
    }
    return { ...build, startAt, timing, heldId };
  }

  metronome(accent = false, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    const selected = this.profileFor(this.laneState(lane), profile);
    const patch = normalizeMetronomeProfile(selected, this.context.sampleRate);
    return this.trigger(lane, accent, at, patch.durationSeconds, selected, velocity);
  }

  note(midi: number, duration: number | null = null, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const build = this.trigger(lane, false, at, duration, profile, velocity, frequency);
    return build?.sources ?? [];
  }

  holdNoteInLane(id: string, midi: number, profile?: DeckSoundProfile, laneName: VoiceLane = 'live') {
    this.releaseNoteInLane(id, laneName);
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const build = this.trigger(laneName, false, this.context.currentTime, null, profile, 1, frequency, id);
    if (!build) return [] as OscillatorNode[];
    const lane = this.laneState(laneName);
    lane.held.set(id, { id, voice: build.voice, profile: build.profile });
    return build.sources;
  }

  holdNote(id: string, midi: number, profile?: DeckSoundProfile) { return this.holdNoteInLane(id, midi, profile, 'live'); }

  releaseNoteInLane(id: string, laneName: VoiceLane = 'live'): ReleaseNoteResult | null {
    const lane = this.laneState(laneName);
    const held = lane.held.get(id);
    if (!held) return null;
    lane.held.delete(id);
    const now = this.context.currentTime;
    const release = held.voice.release(now, Math.max(.012, Number(held.profile.durationSeconds)), true);
    return { id, instrument: 'metronome', requestedAt: now, voiceCount: 1, ...(release ? { scheduledAt: release.start, safetyOffsetSeconds: release.start - now } : {}) };
  }

  releaseNote(id: string) { return this.releaseNoteInLane(id, 'live'); }

  updateMetronomeLaneProfile(laneName: VoiceLane, profile: DeckSoundProfile, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    const next = cloneAndFreezeProfile(profile)!;
    const changed = metronomeProfileFingerprint(lane.profile) !== metronomeProfileFingerprint(next);
    lane.profile = next;
    return { applied: true, deferred: false, changed, at };
  }

  profile(lane: VoiceLane = 'live') { return this.laneState(lane).profile; }
  setPreset(lane: VoiceLane, index: number) { return this.updateMetronomeLaneProfile(lane, METRONOME_PRESETS[Math.max(0, Math.min(METRONOME_PRESETS.length - 1, Math.floor(index)))]); }
  setInstrumentEnabled(enabled: boolean, at = this.context.currentTime, updateState = true) { this.runtime.setEnabled(enabled, at, updateState); if (updateState && !enabled) this.lanes.forEach((lane) => lane.held.clear()); }
  commitInstrumentEnabled(enabled: boolean, at = this.context.currentTime) { this.runtime.commitEnabled(enabled, at); if (!enabled) this.lanes.forEach((lane) => lane.held.clear()); }
  cancelInstrumentAutomation(at = this.context.currentTime) { this.runtime.cancelEnabledAutomation(at); }
  isInstrumentEnabled() { return this.runtime.isEnabled(); }
  setLaneGain(lane: VoiceLane, value: number, at = this.context.currentTime, duration = .01) { this.runtime.setLaneGain(lane, value, at, duration); }
  cancelLaneGainAutomation(lane: VoiceLane, at = this.context.currentTime) { this.runtime.cancelLaneGainAutomation(lane, at); }
  laneGain(lane: VoiceLane) { return this.runtime.laneGain(lane); }
  stopLane(lane: VoiceLane, at = this.context.currentTime) { this.laneState(lane).held.clear(); this.runtime.stopLane(lane, at); }
  stopAll(at = this.context.currentTime) { this.lanes.forEach((lane) => lane.held.clear()); this.runtime.stopAll(at); }
  stopDeckVoices(lane?: VoiceLane) { if (lane === 'deckA' || lane === 'deckB') this.stopLane(lane); else { this.stopLane('deckA'); this.stopLane('deckB'); } }
  panic() { this.stopAll(); }

  getVoiceStats(): VoiceStatsSnapshot {
    const voices = this.runtime.pool.byInstrument('metronome');
    const metronome = { groups: this.runtime.pool.retainedCount('metronome'), active: this.runtime.pool.activeCount('metronome'), releasing: this.runtime.pool.retiringCount('metronome'), voices: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0), musicalVoices: this.runtime.pool.allocatedCount('metronome') };
    return { bass: zeroCounts(), lead: zeroCounts(), chords: zeroCounts(), activeSources: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0), metronome };
  }

  getVoiceSnapshots() { return this.runtime.pool.snapshot(); }
  retainedCount() { return this.runtime.retainedCount(); }
  cleanupHorizon() { return this.runtime.cleanupHorizon(); }
  getProfileBusSnapshots(lane: VoiceLane = 'live') { return [...this.runtime.laneState(lane).profileBuses.values()].map((bus) => bus.snapshot()); }
  profileDestinationCacheSize() { return this.runtime.profileBusCacheSize(); }
  dispose() { if (this.disposed) return; this.disposed = true; this.lanes.forEach((lane) => lane.held.clear()); this.runtime.dispose(); }
  forceDispose() { this.runtime.forceDispose(); }
}

export { IndependentMetronomeEngine as IndependentMetronomeManager };
