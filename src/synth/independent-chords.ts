import type { DeckSoundProfile } from '../deck.ts';
import type { ReleaseNoteResult, VoiceLane, VoiceStatsSnapshot, VoiceCountSnapshot } from './contract.ts';
import { safeAutomationTime } from './envelope.ts';
import { IndependentVoiceRuntime, INDEPENDENT_NOTE_LANES, type IndependentNoteLane } from './independent-runtime.ts';
import { cloneAndFreezeProfile } from './profile-bus.ts';
import { createChordVoice, CHORD_PRESETS, chordProfileFingerprint, DEFAULT_CHORD_PROFILE } from './patches/chords.ts';
import { VoiceGroup } from './voice-group.ts';
import type { SynthVoice } from './voice.ts';

export { CHORD_PRESETS } from './patches/chords.ts';

type HeldChord = { id: string; pitches: number[]; order: number; group: VoiceGroup };
type ChordLaneState = { lane: IndependentNoteLane; profile: Readonly<DeckSoundProfile>; held: Map<string, HeldChord> };

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const zeroCounts = (): VoiceCountSnapshot => ({ groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 });

/** Independent chord runtime for Phase 3. A chord is one group of ordinary
 * independent pitch voices; it is not merged with other chord events. */
export class IndependentChordEngine {
  readonly context: BaseAudioContext;
  readonly runtime: IndependentVoiceRuntime;
  private readonly lanes = new Map<IndependentNoteLane, ChordLaneState>();
  private readonly groups = new Set<VoiceGroup>();
  private heldOrder = 0;
  private groupNumber = 0;
  private voiceNumber = 0;
  private disposed = false;

  constructor(options: { context: BaseAudioContext; destination?: AudioNode; defaultProfile?: DeckSoundProfile }) {
    this.context = options.context;
    this.runtime = new IndependentVoiceRuntime({ context: options.context, instrument: 'chords', destination: options.destination, limit: 24 });
    const profile = cloneAndFreezeProfile(options.defaultProfile ?? DEFAULT_CHORD_PROFILE)!;
    INDEPENDENT_NOTE_LANES.forEach((lane) => this.lanes.set(lane, { lane, profile, held: new Map() }));
  }

  async start() {
    const context = this.context as AudioContext;
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  }

  private laneState(lane: VoiceLane) { return this.lanes.get(this.runtime.laneState(lane).lane)!; }

  private trigger(laneName: VoiceLane, pitches: number[], duration: number | null, requestedAt: number, profileInput: DeckSoundProfile | undefined, velocity: number) {
    if (this.disposed || !this.runtime.isEnabled() || pitches.length === 0) return null;
    const lane = this.laneState(laneName);
    const timing = safeAutomationTime(requestedAt, this.context.currentTime, this.context.sampleRate, lane.lane === 'live');
    const startAt = timing.scheduledAt;
    const profile = profileInput ? cloneAndFreezeProfile(profileInput)! : lane.profile;
    const builds = pitches.map((midi, index) => {
      const bus = this.runtime.profileBus(lane.lane, chordProfileFingerprint(profile), profile);
      return createChordVoice({ context: this.context, id: `chord-${lane.lane}-${++this.voiceNumber}`, lane: lane.lane, midi, startAt, velocity: clamp(velocity), profile, profileBus: bus });
    });
    // Set each child’s finite note-off before the atomic pool reservation so
    // out-of-order groups are checked against their full musical intervals.
    if (duration !== null) {
      const gate = Number.isFinite(duration) ? Math.max(.001, duration) : .001;
      builds.forEach((build) => build.voice.release(startAt + gate, build.profile.releaseSeconds, false));
    }
    const allocation = this.runtime.addVoicesAtomically(builds.map((build) => ({ voice: build.voice, bus: build.profileBus })), startAt);
    if (allocation.status === 'rejected') return null;
    const accepted = builds;
    const group = new VoiceGroup(`chord-group-${lane.lane}-${++this.groupNumber}`, accepted.map((build) => build.voice));
    this.groups.add(group);
    accepted.forEach((build) => {
      build.voice.onStopped(() => {
        if (group.state === 'stopped') this.groups.delete(group);
      });
    });
    try {
      accepted.forEach((build) => this.runtime.startVoice(build.voice, startAt));
    } catch {
      // A later child may fail after earlier children have started. Abort
      // every never-started child and choke the started children as one
      // group, leaving the pool and profile-bus ownership reachable.
      accepted.forEach((build) => {
        if (build.voice.startedSourceCount === 0) build.voice.abortBeforeStart();
        else build.voice.stop(this.context.currentTime);
      });
      return null;
    }
    return { group, builds: accepted, startAt, timing };
  }

  chord(pitches: number[], duration: number | null = null, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    return this.trigger(lane, pitches, duration, at, profile, velocity)?.builds.flatMap((build) => build.sources) ?? [];
  }

  holdChordInLane(id: string, pitches: number[], profile?: DeckSoundProfile, laneName: VoiceLane = 'live') {
    this.releaseChordInLane(id, laneName);
    const build = this.trigger(laneName, pitches, null, this.context.currentTime, profile, 1);
    if (!build) return [] as OscillatorNode[];
    this.laneState(laneName).held.set(id, { id, pitches: [...pitches], order: ++this.heldOrder, group: build.group });
    return build.builds.flatMap((item) => item.sources);
  }

  holdChord(id: string, pitches: number[], profile?: DeckSoundProfile) { return this.holdChordInLane(id, pitches, profile, 'live'); }

  /** Alias for callers that use the common hold naming. */
  holdNote(id: string, pitches: number[], profile?: DeckSoundProfile) { return this.holdChord(id, pitches, profile); }
  holdDebugChord(id: string, pitches: number[], profile?: DeckSoundProfile) { return this.holdChordInLane(id, pitches, profile, 'debug'); }
  hasHeldNoteInLane(id: string, laneName: VoiceLane = 'live') { return this.laneState(laneName).held.has(id); }
  hasHeldNote(id: string) { return this.hasHeldNoteInLane(id, 'live'); }

  releaseChordInLane(id: string, laneName: VoiceLane = 'live'): ReleaseNoteResult | null {
    const lane = this.laneState(laneName);
    const held = lane.held.get(id);
    if (!held) return null;
    lane.held.delete(id);
    const now = this.context.currentTime;
    const profile = held.group.children[0]?.profile.profile;
    const releaseSeconds = Number.isFinite(profile?.parameters.releaseMs) ? Math.max(.012, profile!.parameters.releaseMs / 1000) : .7;
    held.group.release(now, releaseSeconds, true);
    const release = held.group.children[0]?.timing.releaseEndAt === null || held.group.children[0]?.timing.releaseEndAt === undefined
      ? null
      : { start: held.group.children[0].timing.noteOffAt ?? now, end: held.group.children[0].timing.releaseEndAt };
    return { id, instrument: 'chords', requestedAt: now, voiceCount: held.group.children.length, ...(release ? { scheduledAt: release.start, safetyOffsetSeconds: release.start - now } : {}) };
  }

  releaseChord(id: string): ReleaseNoteResult | null { return this.releaseChordInLane(id, 'live'); }

  updateChordLaneProfile(laneName: VoiceLane, profile?: DeckSoundProfile, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    const next = cloneAndFreezeProfile(profile ?? DEFAULT_CHORD_PROFILE)!;
    const changed = chordProfileFingerprint(lane.profile) !== chordProfileFingerprint(next);
    lane.profile = next;
    return { applied: true, deferred: false, changed, at };
  }

  profile(lane: VoiceLane = 'live') { return this.laneState(lane).profile; }
  setPreset(lane: VoiceLane, index: number) { return this.updateChordLaneProfile(lane, CHORD_PRESETS[Math.max(0, Math.min(CHORD_PRESETS.length - 1, Math.floor(index)))]); }
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
  debugChord(pitches: number[], duration: number, at = this.context.currentTime, profile?: DeckSoundProfile, velocity = 1) { return this.chord(pitches, duration, at, profile, 'debug', velocity); }

  getVoiceStats(): VoiceStatsSnapshot {
    const voices = this.runtime.pool.all();
    const chords = {
      groups: this.groups.size,
      active: this.runtime.pool.activeCount('chords'),
      releasing: this.runtime.pool.retiringCount('chords'),
      voices: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0),
      musicalVoices: this.runtime.pool.allocatedCount('chords'),
    };
    return { bass: zeroCounts(), lead: zeroCounts(), chords, activeSources: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0) };
  }

  getGroups() { return [...this.groups]; }
  getVoiceSnapshots() { return this.runtime.pool.snapshot(); }
  retainedCount() { return this.runtime.retainedCount(); }
  cleanupHorizon() { return this.runtime.cleanupHorizon(); }
  getProfileBusSnapshots(lane: VoiceLane = 'live') { return [...this.runtime.laneState(lane).profileBuses.values()].map((bus) => bus.snapshot()); }
  profileDestinationCacheSize() { return this.runtime.profileBusCacheSize(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lanes.forEach((lane) => lane.held.clear());
    this.groups.clear();
    this.runtime.dispose();
  }

  forceDispose() { this.runtime.forceDispose(); }
}

export { IndependentChordEngine as IndependentChordsEngine };
