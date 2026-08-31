import type { DeckSoundProfile } from '../deck.ts';
import type { DrumModel, VoiceLane, VoiceStatsSnapshot, VoiceCountSnapshot } from './contract.ts';
import { safeAutomationTime } from './envelope.ts';
import { IndependentVoiceRuntime, INDEPENDENT_NOTE_LANES, type IndependentNoteLane } from './independent-runtime.ts';
import { cloneAndFreezeProfile } from './profile-bus.ts';
import { createDrumNoiseBuffer, createDrumVoice, DRUM_NAMES, drumProfileFingerprint } from './patches/drums.ts';

type DrumLaneState = { lane: IndependentNoteLane; profile: Readonly<DeckSoundProfile>; openHats: Set<string> };
const zeroCounts = (): VoiceCountSnapshot => ({ groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 });
const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;

/** Independent procedural drum engine. Each hit is a common SynthVoice and
 * all lanes share only the runtime's immutable profile/lane buses. */
export class IndependentDrumEngine {
  readonly context: BaseAudioContext;
  readonly runtime: IndependentVoiceRuntime;
  private readonly lanes = new Map<IndependentNoteLane, DrumLaneState>();
  private hitNumber = 0;
  private noiseBuffer: AudioBuffer | undefined;
  private readonly noiseOffset?: number;
  private drumModel: DrumModel = 'layered';
  private disposed = false;

  constructor(options: { context: BaseAudioContext; destination?: AudioNode; defaultProfile?: DeckSoundProfile; drumModel?: DrumModel; noiseBuffer?: AudioBuffer; noiseOffset?: number }) {
    this.context = options.context;
    this.runtime = new IndependentVoiceRuntime({ context: options.context, instrument: 'drums', destination: options.destination, limit: 32 });
    this.drumModel = options.drumModel ?? 'layered';
    this.noiseBuffer = options.noiseBuffer;
    this.noiseOffset = options.noiseOffset;
    const profile = cloneAndFreezeProfile(options.defaultProfile ?? {
      presetId: 'Clean', controls: { punch: .5, tightness: .55, dirt: .05, room: .12 }, parameters: {}, volume: .7, drumModel: this.drumModel,
    })!;
    INDEPENDENT_NOTE_LANES.forEach((lane) => this.lanes.set(lane, { lane, profile, openHats: new Set() }));
  }

  async start() {
    const context = this.context as AudioContext;
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  }

  private laneState(lane: VoiceLane) { return this.lanes.get(this.runtime.laneState(lane).lane)!; }

  private profileFor(lane: DrumLaneState, supplied?: DeckSoundProfile) {
    if (supplied) return supplied;
    if (lane.lane === 'live') return { ...lane.profile, drumModel: this.drumModel, controls: { ...lane.profile.controls }, parameters: { ...lane.profile.parameters } };
    return lane.profile;
  }

  private closeOpenHats(lane: DrumLaneState, at: number) {
    for (const id of [...lane.openHats]) {
      const voice = this.runtime.pool.get(id);
      if (!voice || voice.state === 'stopped') { lane.openHats.delete(id); continue; }
      voice.choke(at, .012);
    }
  }

  drum(pad: number, at = this.context.currentTime, profile?: DeckSoundProfile, laneName: VoiceLane = 'live', velocity = 1) {
    if (this.disposed || !this.runtime.isEnabled() || !Number.isInteger(pad) || pad < 0 || pad >= DRUM_NAMES.length) return null;
    const lane = this.laneState(laneName);
    const timing = safeAutomationTime(at, this.context.currentTime, this.context.sampleRate, lane.lane === 'live');
    const startAt = timing.scheduledAt;
    const selected = cloneAndFreezeProfile(this.profileFor(lane, profile))!;
    const bus = this.runtime.profileBus(lane.lane, drumProfileFingerprint(selected), selected);
    const build = createDrumVoice({
      context: this.context,
      id: `drum-${lane.lane}-${++this.hitNumber}`,
      lane: lane.lane,
      pad,
      startAt,
      velocity: clamp(velocity),
      profile: selected,
      profileBus: bus,
      modelOverride: profile ? undefined : lane.lane === 'live' ? this.drumModel : undefined,
      noiseBuffer: this.noiseBuffer ??= typeof (this.context as BaseAudioContext & { createBufferSource?: () => AudioBufferSourceNode }).createBufferSource === 'function' ? createDrumNoiseBuffer(this.context) : undefined,
      noiseOffset: this.noiseOffset,
    });
    const releaseAt = startAt + build.durationSeconds;
    build.voice.release(releaseAt, .012, false);
    const allocation = this.runtime.addVoice(build.voice, bus);
    if (allocation.status === 'rejected') return null;
    build.voice.onStopped(() => {
      lane.openHats.delete(build.voice.id);
    });
    if (build.openHat) lane.openHats.add(build.voice.id);
    try {
      this.runtime.startVoice(build.voice, startAt);
    } catch {
      return null;
    }
    // Choke only after this hit has been accepted and started. A rejected
    // closed-hat allocation must not alter an existing open hat.
    if (pad === 2) this.closeOpenHats(lane, startAt);
    return build;
  }

  debugDrum(pad: number, at: number, profile?: DeckSoundProfile, lane: VoiceLane = 'debug', velocity = 1) { return this.drum(pad, at, profile, lane, velocity); }
  setDrumModel(model: DrumModel) { this.drumModel = model; }
  updateDrumLaneProfile(laneName: VoiceLane, profile: DeckSoundProfile, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    const next = cloneAndFreezeProfile(profile)!;
    const changed = drumProfileFingerprint(lane.profile) !== drumProfileFingerprint(next);
    lane.profile = next;
    return { applied: true, deferred: false, changed, at };
  }
  profile(lane: VoiceLane = 'live') { return this.laneState(lane).profile; }
  setPreset(lane: VoiceLane, _index: number) { return { applied: false, deferred: false, changed: false, at: this.context.currentTime }; }
  setInstrumentEnabled(enabled: boolean, at = this.context.currentTime, updateState = true) { this.runtime.setEnabled(enabled, at, updateState); if (updateState && !enabled) this.lanes.forEach((lane) => lane.openHats.clear()); }
  commitInstrumentEnabled(enabled: boolean, at = this.context.currentTime) { this.runtime.commitEnabled(enabled, at); if (!enabled) this.lanes.forEach((lane) => lane.openHats.clear()); }
  cancelInstrumentAutomation(at = this.context.currentTime) { this.runtime.cancelEnabledAutomation(at); }
  isInstrumentEnabled() { return this.runtime.isEnabled(); }
  setLaneGain(lane: VoiceLane, value: number, at = this.context.currentTime, duration = .01) { this.runtime.setLaneGain(lane, value, at, duration); }
  cancelLaneGainAutomation(lane: VoiceLane, at = this.context.currentTime) { this.runtime.cancelLaneGainAutomation(lane, at); }
  laneGain(lane: VoiceLane) { return this.runtime.laneGain(lane); }
  stopLane(lane: VoiceLane, at = this.context.currentTime) { this.laneState(lane).openHats.clear(); this.runtime.stopLane(lane, at); }
  stopAll(at = this.context.currentTime) { this.lanes.forEach((lane) => lane.openHats.clear()); this.runtime.stopAll(at); }
  stopDeckVoices(lane?: VoiceLane) { if (lane === 'deckA' || lane === 'deckB') this.stopLane(lane); else { this.stopLane('deckA'); this.stopLane('deckB'); } }
  panic() { this.stopAll(); }

  getVoiceStats(): VoiceStatsSnapshot {
    const voices = this.runtime.pool.byInstrument('drums');
    const drums = { groups: this.runtime.pool.retainedCount('drums'), active: this.runtime.pool.activeCount('drums'), releasing: this.runtime.pool.retiringCount('drums'), voices: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0), musicalVoices: this.runtime.pool.allocatedCount('drums') };
    return { bass: zeroCounts(), lead: zeroCounts(), chords: zeroCounts(), activeSources: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0), drums } as VoiceStatsSnapshot & { drums: VoiceCountSnapshot };
  }
  getVoiceSnapshots() { return this.runtime.pool.snapshot(); }
  retainedCount() { return this.runtime.retainedCount(); }
  cleanupHorizon() { return this.runtime.cleanupHorizon(); }
  getProfileBusSnapshots(lane: VoiceLane = 'live') { return [...this.runtime.laneState(lane).profileBuses.values()].map((bus) => bus.snapshot()); }
  profileDestinationCacheSize() { return this.runtime.profileBusCacheSize(); }
  dispose() { if (this.disposed) return; this.disposed = true; this.lanes.forEach((lane) => lane.openHats.clear()); this.runtime.dispose(); }
  forceDispose() { this.runtime.forceDispose(); }
}

export { IndependentDrumEngine as IndependentDrumsEngine };
