import type { DeckSoundProfile } from '../deck.ts';
import type { ReleaseNoteResult, VoiceLane, VoiceStatsSnapshot, VoiceCountSnapshot } from './contract.ts';
import { safeAutomationTime } from './envelope.ts';
import { IndependentVoiceRuntime, INDEPENDENT_NOTE_LANES, type IndependentNoteLane } from './independent-runtime.ts';
import { cloneAndFreezeProfile } from './profile-bus.ts';
import { createLeadVoice, DEFAULT_LEAD_PROFILE, leadProfileFingerprint, LEAD_PRESETS, type LeadPatchProfile } from './patches/lead.ts';
import type { SynthVoice } from './voice.ts';

export { LEAD_PRESETS } from './patches/lead.ts';

type HeldLead = { id: string; midi: number; order: number; voice: SynthVoice; profile: LeadPatchProfile };
type LeadLaneState = { lane: IndependentNoteLane; profile: Readonly<DeckSoundProfile>; held: Map<string, HeldLead> };

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const zeroCounts = (): VoiceCountSnapshot => ({ groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 });

/** Independent lead runtime for Phase 3. It is intentionally not wired into
 * the application yet; the legacy engine remains the public production path. */
export class IndependentLeadEngine {
  readonly context: BaseAudioContext;
  readonly runtime: IndependentVoiceRuntime;
  private readonly lanes = new Map<IndependentNoteLane, LeadLaneState>();
  private heldOrder = 0;
  private voiceNumber = 0;
  private disposed = false;

  constructor(options: { context: BaseAudioContext; destination?: AudioNode; defaultProfile?: DeckSoundProfile }) {
    this.context = options.context;
    this.runtime = new IndependentVoiceRuntime({ context: options.context, instrument: 'lead', destination: options.destination, limit: 8 });
    const profile = cloneAndFreezeProfile(options.defaultProfile ?? DEFAULT_LEAD_PROFILE)!;
    INDEPENDENT_NOTE_LANES.forEach((lane) => this.lanes.set(lane, { lane, profile, held: new Map() }));
  }

  async start() {
    const context = this.context as AudioContext;
    if (context.state === 'suspended' && typeof context.resume === 'function') await context.resume();
  }

  private laneState(lane: VoiceLane) { return this.lanes.get(this.runtime.laneState(lane).lane)!; }

  private trigger(laneName: VoiceLane, midi: number, duration: number | null, requestedAt: number, profileInput: DeckSoundProfile | undefined, velocity: number, heldId?: string) {
    if (this.disposed || !this.runtime.isEnabled()) return null;
    const lane = this.laneState(laneName);
    const timing = safeAutomationTime(requestedAt, this.context.currentTime, this.context.sampleRate, lane.lane === 'live');
    const startAt = timing.scheduledAt;
    const profile = profileInput ? cloneAndFreezeProfile(profileInput)! : lane.profile;
    const bus = this.runtime.profileBus(lane.lane, leadProfileFingerprint(profile), profile);
    const build = createLeadVoice({
      context: this.context,
      id: `lead-${lane.lane}-${++this.voiceNumber}`,
      lane: lane.lane,
      midi,
      startAt,
      velocity: clamp(velocity),
      profile,
      profileBus: bus,
    });
    // Publish the complete finite musical interval before pool admission. The
    // pool must be able to see a future note-off when scheduling out of order.
    if (duration !== null) {
      const gate = Number.isFinite(duration) ? Math.max(.001, duration) : .001;
      build.voice.release(startAt + gate, build.profile.releaseSeconds, false);
    }
    const added = this.runtime.addVoice(build.voice, bus);
    if (added.status === 'rejected') return null;
    try {
      this.runtime.startVoice(build.voice, startAt);
    } catch {
      return null;
    }
    return { ...build, startAt, timing, heldId };
  }

  note(midi: number, duration: number | null = null, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    return this.trigger(lane, midi, duration, at, profile, velocity)?.sources ?? [];
  }

  holdNoteInLane(id: string, midi: number, profile?: DeckSoundProfile, laneName: VoiceLane = 'live') {
    this.releaseNoteInLane(id, laneName);
    const build = this.trigger(laneName, midi, null, this.context.currentTime, profile, 1, id);
    if (!build) return [] as OscillatorNode[];
    const lane = this.laneState(laneName);
    lane.held.set(id, { id, midi, order: ++this.heldOrder, voice: build.voice, profile: build.profile });
    return build.sources;
  }

  holdNote(id: string, midi: number, profile?: DeckSoundProfile) { return this.holdNoteInLane(id, midi, profile, 'live'); }
  holdDebugNote(id: string, midi: number, profile?: DeckSoundProfile) { return this.holdNoteInLane(id, midi, profile, 'debug'); }

  hasHeldNoteInLane(id: string, laneName: VoiceLane = 'live') { return this.laneState(laneName).held.has(id); }
  hasHeldNote(id: string) { return this.hasHeldNoteInLane(id, 'live'); }

  releaseNoteInLane(id: string, laneName: VoiceLane = 'live'): ReleaseNoteResult | null {
    const lane = this.laneState(laneName);
    const held = lane.held.get(id);
    if (!held) return null;
    lane.held.delete(id);
    const now = this.context.currentTime;
    const release = held.voice.release(now, held.profile.releaseSeconds, true);
    return { id, instrument: 'lead', requestedAt: now, voiceCount: 1, ...(release ? { scheduledAt: release.start, safetyOffsetSeconds: release.start - now } : {}) };
  }

  releaseNote(id: string): ReleaseNoteResult | null {
    return this.releaseNoteInLane(id, 'live');
  }

  updateLeadLaneProfile(laneName: VoiceLane, profile?: DeckSoundProfile, at = this.context.currentTime) {
    const lane = this.laneState(laneName);
    const next = cloneAndFreezeProfile(profile ?? DEFAULT_LEAD_PROFILE)!;
    const changed = leadProfileFingerprint(lane.profile) !== leadProfileFingerprint(next);
    lane.profile = next;
    return { applied: true, deferred: false, changed, at };
  }

  profile(lane: VoiceLane = 'live') { return this.laneState(lane).profile; }
  setPreset(lane: VoiceLane, index: number) { return this.updateLeadLaneProfile(lane, LEAD_PRESETS[Math.max(0, Math.min(LEAD_PRESETS.length - 1, Math.floor(index)))]); }
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
  debugNote(midi: number, duration: number, at = this.context.currentTime, profile?: DeckSoundProfile, lane: VoiceLane = 'debug', velocity = 1) { return this.note(midi, duration, at, profile, lane, velocity); }

  getVoiceStats(): VoiceStatsSnapshot {
    const voices = this.runtime.pool.all();
    const lead = {
      groups: this.runtime.pool.retainedCount('lead'),
      active: this.runtime.pool.activeCount('lead'),
      releasing: this.runtime.pool.retiringCount('lead'),
      voices: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0),
      musicalVoices: this.runtime.pool.allocatedCount('lead'),
    };
    return { bass: zeroCounts(), lead, chords: zeroCounts(), activeSources: voices.reduce((count, voice) => count + voice.remainingSourceCount, 0) };
  }

  getVoiceSnapshots() { return this.runtime.pool.snapshot(); }
  retainedCount() { return this.runtime.retainedCount(); }
  cleanupHorizon() { return this.runtime.cleanupHorizon(); }
  getProfileBusSnapshots(lane: VoiceLane = 'live') { return [...this.runtime.laneState(lane).profileBuses.values()].map((bus) => bus.snapshot()); }
  profileDestinationCacheSize() { return this.runtime.profileBusCacheSize(); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lanes.forEach((lane) => lane.held.clear());
    this.runtime.dispose();
  }

  forceDispose() { this.runtime.forceDispose(); }
}

export { IndependentLeadEngine as IndependentLeadManager };
