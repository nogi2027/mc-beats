import type { DeckInstrument, DeckSoundProfile } from './deck.ts';
import { LegacySynthEngine } from './legacy/audio.ts';
import type {
  AudioEngine,
  BassReleaseDiagnosticSnapshot,
  BassLaneSnapshot,
  Controls,
  DebugToneResult,
  DrumModel,
  Instrument,
  NoteInstrument,
  OutputControls,
  Parameter,
  ReleaseNoteResult,
  SynthSnapshot,
  VoiceLane,
  VoiceStatsSnapshot,
} from './synth/contract.ts';
import { BASS_PRESETS, IndependentBassEngine } from './synth/independent-bass.ts';
import { CHORD_PRESETS, IndependentChordEngine } from './synth/independent-chords.ts';
import { IndependentLeadEngine, LEAD_PRESETS } from './synth/independent-lead.ts';
import { IndependentDrumEngine } from './synth/independent-drums.ts';
import { IndependentMetronomeEngine } from './synth/independent-metronome.ts';
import { DRUM_PRESET_IDS } from './synth/patches/drum-presets.ts';

type Lane = Exclude<VoiceLane, 'deck'>;
const HYBRID_LANES: readonly Lane[] = ['live', 'deckA', 'deckB', 'solo', 'debug'];
const DEFAULT_LANE_TARGETS: Record<Lane, number> = {
  live: 1,
  deckA: 1,
  deckB: 0,
  solo: 1,
  debug: 1,
};

const presetIds: Record<Instrument, string[]> = {
  drums: DRUM_PRESET_IDS,
  bass: BASS_PRESETS.map((profile) => profile.presetId),
  chords: CHORD_PRESETS.map((profile) => profile.presetId),
  lead: LEAD_PRESETS.map((profile) => profile.presetId),
  metronome: ['Classic Click', 'Bright Click', 'Soft Tick', 'Wood Block', 'Digital', 'Low Tick'],
};

const migrated = (instrument: Instrument): instrument is 'bass' | 'lead' | 'chords' | 'drums' | 'metronome' =>
  instrument === 'bass' || instrument === 'lead' || instrument === 'chords' || instrument === 'drums' || instrument === 'metronome';

type IndependentInstrument = 'bass' | 'lead' | 'chords' | 'drums' | 'metronome';

/**
 * Production composition for the current migration phase.
 *
 * LegacySynthEngine owns the sole AudioContext and the post-master chain.
 * Independent instruments connect to legacy.master, so their output reaches
 * the same compressor, analyser, destination, and FrequencyHistory recorder.
 * The metronome now uses the same independent path; LegacySynthEngine still
 * owns the rollback implementation when the legacy mode is selected.
 */
export class HybridAudioEngine implements AudioEngine {
  readonly mode = 'hybrid' as const;
  readonly legacy: LegacySynthEngine;
  readonly heldNotes = new Map<string, OscillatorNode[]>();
  readonly heldNoteKinds = new Map<string, NoteInstrument | 'chords' | 'metronome'>();
  /** The hybrid owns these targets before the shared AudioContext exists. */
  private readonly laneTargets = new Map<Lane, number>(Object.entries(DEFAULT_LANE_TARGETS) as Array<[Lane, number]>);
  private readonly heldNoteLanes = new Map<string, Lane>();
  private bass: IndependentBassEngine | null = null;
  private lead: IndependentLeadEngine | null = null;
  private chords: IndependentChordEngine | null = null;
  private drums: IndependentDrumEngine | null = null;
  private metronomeEngine: IndependentMetronomeEngine | null = null;
  private readonly laneProfiles = new Map<string, DeckSoundProfile>();
  private disposed = false;
  private legacyDisposeTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyDisposeFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyDisposeDeadline = 0;

  constructor(legacy = new LegacySynthEngine()) {
    this.legacy = legacy;
  }

  get context() { return this.legacy.context; }
  get master() { return this.legacy.master; }
  get compressor() { return this.legacy.compressor; }
  get analyser() { return this.legacy.analyser; }
  get destination() { return this.legacy.destination; }
  get controls() { return this.legacy.controls; }
  get volumes() { return this.legacy.volumes; }
  get outputControls() { return this.legacy.outputControls; }
  get parameters() { return this.legacy.parameters; }
  get tempo() { return this.legacy.tempo; }
  set tempo(value: number) { this.legacy.tempo = value; }
  get drumModel() { return this.legacy.drumModel; }
  set drumModel(value: DrumModel) { this.legacy.drumModel = value; }

  private profileKey(instrument: IndependentInstrument, lane: VoiceLane) { return `${instrument}:${lane}`; }

  private currentLiveProfile(instrument: IndependentInstrument) {
    const index = this.legacy.getPresetIndexes()[instrument];
    const presetId = presetIds[instrument][index] ?? presetIds[instrument][0];
    if (instrument === 'metronome') {
      const parameters = Object.fromEntries(Object.entries(this.legacy.parameters.metronome).map(([name, parameter]) => [name, parameter.value]));
      return {
        presetId,
        controls: { ...this.legacy.controls.metronome },
        parameters,
        volume: this.legacy.volumes.metronome,
      };
    }
    return this.legacy.getSoundProfile(instrument, presetId);
  }

  private profileFor(instrument: IndependentInstrument, lane: VoiceLane, supplied?: DeckSoundProfile) {
    if (supplied) return supplied;
    return this.laneProfiles.get(this.profileKey(instrument, lane))
      ?? this.currentLiveProfile(instrument);
  }

  private installProfile(instrument: IndependentInstrument, lane: VoiceLane, profile: DeckSoundProfile) {
    this.laneProfiles.set(this.profileKey(instrument, lane), profile);
    if (instrument === 'bass') this.bass?.updateBassLaneProfile(lane, profile);
    if (instrument === 'lead') this.lead?.updateLeadLaneProfile(lane, profile);
    if (instrument === 'chords') this.chords?.updateChordLaneProfile(lane, profile);
    if (instrument === 'drums') this.drums?.updateDrumLaneProfile(lane, profile);
    if (instrument === 'metronome') this.metronomeEngine?.updateMetronomeLaneProfile(lane, profile);
  }

  private syncLiveProfile(instrument: IndependentInstrument) {
    this.installProfile(instrument, 'live', this.currentLiveProfile(instrument));
  }

  private ensureIndependentEngines() {
    if (this.bass || !this.context || !this.master) return;
    const options = { context: this.context, destination: this.master };
    this.bass = new IndependentBassEngine({ ...options, defaultProfile: this.currentLiveProfile('bass') });
    this.lead = new IndependentLeadEngine({ ...options, defaultProfile: this.currentLiveProfile('lead') });
    this.chords = new IndependentChordEngine({ ...options, defaultProfile: this.currentLiveProfile('chords') });
    this.drums = new IndependentDrumEngine({ ...options, defaultProfile: this.currentLiveProfile('drums'), drumModel: this.legacy.drumModel });
    this.metronomeEngine = new IndependentMetronomeEngine({ ...options, defaultProfile: this.currentLiveProfile('metronome') });
    (['bass', 'lead', 'chords', 'drums', 'metronome'] as const).forEach((instrument) => this.syncLiveProfile(instrument));
    this.laneProfiles.forEach((profile, key) => {
      const separator = key.indexOf(':');
      if (separator < 0) return;
      const instrument = key.slice(0, separator) as IndependentInstrument;
      const lane = key.slice(separator + 1) as VoiceLane;
      if (migrated(instrument)) this.installProfile(instrument, lane, profile);
    });
    (['bass', 'lead', 'chords', 'drums', 'metronome'] as const).forEach((instrument) => {
      if (!this.legacy.isInstrumentEnabled(instrument)) this.setInstrumentEnabled(instrument, false);
    });
    this.applyCachedLaneTargets();
  }

  private applyCachedLaneTargets() {
    for (const lane of HYBRID_LANES) {
      const target = this.laneTargets.get(lane) ?? DEFAULT_LANE_TARGETS[lane];
      this.legacy.setLaneGain(lane, target);
      this.bass?.setLaneGain(lane, target);
      this.lead?.setLaneGain(lane, target);
      this.chords?.setLaneGain(lane, target);
      this.drums?.setLaneGain(lane, target);
      this.metronomeEngine?.setLaneGain(lane, target);
    }
  }

  private clearHeldNotesForInstrument(instrument: Instrument) {
    for (const [id, kind] of this.heldNoteKinds) {
      if (kind !== instrument) continue;
      this.heldNotes.delete(id);
      this.heldNoteKinds.delete(id);
      this.heldNoteLanes.delete(id);
    }
  }

  async start() {
    if (this.disposed) return;
    await this.legacy.start();
    this.ensureIndependentEngines();
    await Promise.all([this.bass?.start(), this.lead?.start(), this.chords?.start(), this.drums?.start(), this.metronomeEngine?.start()]);
  }

  setControl(instrument: Instrument, name: string, value: number) {
    this.legacy.setControl(instrument, name, value);
    if (migrated(instrument)) this.syncLiveProfile(instrument);
  }

  setDrumModel(model: DrumModel) { this.legacy.setDrumModel(model); this.drums?.setDrumModel(model); this.syncLiveProfile('drums'); }

  setVolume(instrument: Instrument, value: number) {
    this.legacy.setVolume(instrument, value);
    if (migrated(instrument)) this.syncLiveProfile(instrument);
  }
  setOutputControl(name: keyof OutputControls, value: number) { this.legacy.setOutputControl(name, value); }

  setInstrumentEnabled(instrument: Instrument, enabled: boolean, at?: number, updateState = true) {
    // A future lookahead call is scheduling-only. It must not release a held
    // note, clear ownership, or change the admission state before the cue.
    if (updateState && !enabled) {
      for (const [id, kind] of [...this.heldNoteKinds]) {
        if (kind === instrument) this.releaseNote(id);
      }
    }
    this.legacy.setInstrumentEnabled(instrument, enabled, at, updateState);
    if (instrument === 'bass') this.bass?.setInstrumentEnabled(enabled, at, updateState);
    if (instrument === 'lead') this.lead?.setInstrumentEnabled(enabled, at, updateState);
    if (instrument === 'chords') this.chords?.setInstrumentEnabled(enabled, at, updateState);
    if (instrument === 'drums') this.drums?.setInstrumentEnabled(enabled, at, updateState);
    if (instrument === 'metronome') this.metronomeEngine?.setInstrumentEnabled(enabled, at, updateState);
  }

  commitInstrumentEnabled(instrument: Instrument, enabled: boolean, at?: number) {
    const when = at ?? this.context?.currentTime ?? 0;
    if (!enabled) this.clearHeldNotesForInstrument(instrument);
    this.legacy.commitInstrumentEnabled(instrument, enabled, when);
    if (instrument === 'bass') this.bass?.commitInstrumentEnabled(enabled, when);
    if (instrument === 'lead') this.lead?.commitInstrumentEnabled(enabled, when);
    if (instrument === 'chords') this.chords?.commitInstrumentEnabled(enabled, when);
    if (instrument === 'drums') this.drums?.commitInstrumentEnabled(enabled, when);
    if (instrument === 'metronome') this.metronomeEngine?.commitInstrumentEnabled(enabled, when);
  }

  isInstrumentEnabled(instrument: Instrument) { return this.legacy.isInstrumentEnabled(instrument); }

  setLaneGain(lane: Lane, value: number, at?: number, duration?: number) {
    const target = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;
    this.laneTargets.set(lane, target);
    this.legacy.setLaneGain(lane, value, at, duration);
    this.bass?.setLaneGain(lane, value, at, duration);
    this.lead?.setLaneGain(lane, value, at, duration);
    this.chords?.setLaneGain(lane, value, at, duration);
    this.drums?.setLaneGain(lane, value, at, duration);
    this.metronomeEngine?.setLaneGain(lane, value, at, duration);
  }

  setLaneGainRamp(lane: Lane, value: number, at?: number, duration?: number) {
    const target = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0;
    this.laneTargets.set(lane, target);
    this.legacy.setLaneGainRamp(lane, value, at, duration);
    this.bass?.setLaneGain(lane, value, at, duration);
    this.lead?.setLaneGain(lane, value, at, duration);
    this.chords?.setLaneGain(lane, value, at, duration);
    this.drums?.setLaneGain(lane, value, at, duration);
    this.metronomeEngine?.setLaneGain(lane, value, at, duration);
  }

  cancelLaneGainAutomation(lane: Lane, at?: number) {
    this.legacy.cancelLaneGainAutomation(lane, at);
    this.bass?.cancelLaneGainAutomation(lane, at);
    this.lead?.cancelLaneGainAutomation(lane, at);
    this.chords?.cancelLaneGainAutomation(lane, at);
    this.drums?.cancelLaneGainAutomation(lane, at);
    this.metronomeEngine?.cancelLaneGainAutomation(lane, at);
  }

  cancelInstrumentAutomation(instrument: Instrument, at?: number) {
    this.legacy.cancelInstrumentAutomation(instrument, at);
    if (instrument === 'bass') this.bass?.cancelInstrumentAutomation(at);
    if (instrument === 'lead') this.lead?.cancelInstrumentAutomation(at);
    if (instrument === 'chords') this.chords?.cancelInstrumentAutomation(at);
    if (instrument === 'drums') this.drums?.cancelInstrumentAutomation(at);
    if (instrument === 'metronome') this.metronomeEngine?.cancelInstrumentAutomation(at);
  }

  laneGain(lane: Lane) { return this.laneTargets.get(lane) ?? this.legacy.laneGain(lane); }

  getSoundProfile(instrument: DeckInstrument, presetId: string) {
    return this.legacy.getSoundProfile(instrument, presetId);
  }

  setParameter(instrument: Instrument, name: string, value: number) {
    this.legacy.setParameter(instrument, name, value);
    if (migrated(instrument)) this.syncLiveProfile(instrument);
  }

  resetParameter(instrument: Instrument, presetIndex: number, name: string) {
    this.legacy.resetParameter(instrument, presetIndex, name);
    if (migrated(instrument)) this.syncLiveProfile(instrument);
  }

  loadPreset(instrument: Instrument, index: number) {
    this.legacy.loadPreset(instrument, index);
    if (migrated(instrument)) this.syncLiveProfile(instrument);
  }

  updateBassLaneProfile(lane: VoiceLane, profile?: DeckSoundProfile, at?: number) {
    const selected = profile ?? (lane === 'live' ? this.currentLiveProfile('bass') : this.profileFor('bass', lane));
    this.laneProfiles.set(this.profileKey('bass', lane), selected);
    return this.bass?.updateBassLaneProfile(lane, selected, at)
      ?? { applied: false, deferred: false, changed: false, at };
  }

  note(instrument: Exclude<Instrument, 'drums'>, midi: number, duration: number | null = null, at?: number, profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1) {
    const selectedLane = lane ?? (deckEvent ? 'deckA' : 'live');
    if (instrument === 'bass') return this.bass?.note(midi, duration, at ?? this.context?.currentTime ?? 0, this.profileFor('bass', selectedLane, profile), selectedLane, velocity) ?? [];
    if (instrument === 'lead') return this.lead?.note(midi, duration, at ?? this.context?.currentTime ?? 0, this.profileFor('lead', selectedLane, profile), selectedLane, velocity) ?? [];
    if (instrument === 'chords') return this.chords?.chord([midi], duration, at ?? this.context?.currentTime ?? 0, this.profileFor('chords', selectedLane, profile), selectedLane, velocity) ?? [];
    if (instrument === 'metronome') return this.metronomeEngine?.note(midi, duration, at ?? this.context?.currentTime ?? 0, this.profileFor('metronome', selectedLane, profile), selectedLane, velocity) ?? [];
    return this.legacy.note(instrument, midi, duration, at, profile, deckEvent, lane, velocity);
  }

  chord(pitches: number[], duration: number | null = null, at?: number, profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1) {
    const selectedLane = lane ?? (deckEvent ? 'deckA' : 'live');
    return this.chords?.chord(pitches, duration, at ?? this.context?.currentTime ?? 0, this.profileFor('chords', selectedLane, profile), selectedLane, velocity) ?? [];
  }

  drum(index: number, at?: number, profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1) {
    const selectedLane = lane ?? (deckEvent ? 'deckA' : 'live');
    if (this.drums) this.drums.drum(index, at ?? this.context?.currentTime ?? 0, this.profileFor('drums', selectedLane, profile), selectedLane, velocity);
    else this.legacy.drum(index, at, profile, deckEvent, lane, velocity);
  }
  metronome(accent = false, at?: number) {
    if (this.metronomeEngine) this.metronomeEngine.metronome(accent, at ?? this.context?.currentTime ?? 0, this.profileFor('metronome', 'live'));
    else this.legacy.metronome(accent, at);
  }

  hasHeldNote(id: string) { return this.heldNotes.has(id); }

  holdNote(id: string, instrument: NoteInstrument | 'chords' | 'metronome', midi: number) {
    this.releaseNote(id);
    if (instrument === 'bass') {
      const voices = this.bass?.holdNote(id, midi, this.profileFor('bass', 'live')) ?? [];
      if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, instrument); this.heldNoteLanes.set(id, 'live'); }
      return voices;
    }
    if (instrument === 'lead') {
      const voices = this.lead?.holdNote(id, midi, this.profileFor('lead', 'live')) ?? [];
      if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, instrument); this.heldNoteLanes.set(id, 'live'); }
      return voices;
    }
    if (instrument === 'chords') return this.holdChord(id, [midi]);
    if (instrument === 'metronome') {
      const voices = this.metronomeEngine?.holdNote(id, midi, this.profileFor('metronome', 'live')) ?? [];
      if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, instrument); this.heldNoteLanes.set(id, 'live'); }
      return voices;
    }
    const voices = this.legacy.holdNote(id, instrument, midi);
    if (voices.length) {
      this.heldNotes.set(id, voices);
      this.heldNoteKinds.set(id, instrument);
      this.heldNoteLanes.set(id, 'live');
    }
    return voices;
  }

  holdChord(id: string, pitches: number[], profile?: DeckSoundProfile) {
    this.releaseNote(id);
    const voices = this.chords?.holdChord(id, pitches, profile ?? this.profileFor('chords', 'live')) ?? [];
    if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, 'chords'); this.heldNoteLanes.set(id, 'live'); }
    return voices;
  }

  holdDebugNote(id: string, instrument: NoteInstrument, midi: number) {
    this.releaseNote(id);
    const profile = this.profileFor(instrument, 'debug');
    if (instrument === 'bass') {
      this.updateBassLaneProfile('debug', profile);
      const voices = this.bass?.holdDebugNote(id, midi, profile) ?? [];
      if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, instrument); this.heldNoteLanes.set(id, 'debug'); }
      return voices;
    }
    const voices = this.lead?.holdDebugNote(id, midi, profile) ?? [];
    if (voices.length) { this.heldNotes.set(id, voices); this.heldNoteKinds.set(id, instrument); this.heldNoteLanes.set(id, 'debug'); }
    return voices;
  }

  releaseNote(id: string): ReleaseNoteResult | null {
    const kind = this.heldNoteKinds.get(id);
    const lane = this.heldNoteLanes.get(id) ?? 'live';
    let result: ReleaseNoteResult | null = null;
    if (kind === 'bass') result = this.bass?.releaseNoteInLane(id, lane) ?? null;
    else if (kind === 'lead') result = this.lead?.releaseNoteInLane(id, lane) ?? null;
    else if (kind === 'chords') result = this.chords?.releaseChordInLane(id, lane) ?? null;
    else if (kind === 'metronome') result = this.metronomeEngine?.releaseNoteInLane(id, lane) ?? null;
    else result = this.legacy.releaseNote(id);
    this.heldNotes.delete(id);
    this.heldNoteKinds.delete(id);
    this.heldNoteLanes.delete(id);
    return result;
  }

  stopDeckVoices(lane?: VoiceLane) {
    this.legacy.stopDeckVoices(lane);
    if (lane === 'deckA' || lane === 'deckB') {
      this.bass?.stopDeckVoices(lane); this.lead?.stopDeckVoices(lane); this.chords?.stopDeckVoices(lane);
      this.drums?.stopDeckVoices(lane);
      this.metronomeEngine?.stopDeckVoices(lane);
    } else {
      this.bass?.stopDeckVoices(); this.lead?.stopDeckVoices(); this.chords?.stopDeckVoices();
      this.drums?.stopDeckVoices();
      this.metronomeEngine?.stopDeckVoices();
    }
    for (const [id, heldLane] of this.heldNoteLanes) {
      if (heldLane === 'deckA' || heldLane === 'deckB') { this.heldNoteLanes.delete(id); this.heldNoteKinds.delete(id); this.heldNotes.delete(id); }
    }
  }

  stopLaneVoices(lane: VoiceLane) {
    this.legacy.stopLaneVoices(lane);
    this.bass?.stopLane(lane); this.lead?.stopLane(lane); this.chords?.stopLane(lane);
    this.drums?.stopLane(lane);
    this.metronomeEngine?.stopLane(lane);
    const selectedLane = lane === 'deck' ? 'deckA' : lane;
    for (const [id, heldLane] of this.heldNoteLanes) {
      if (heldLane === selectedLane) {
        this.heldNoteLanes.delete(id); this.heldNoteKinds.delete(id); this.heldNotes.delete(id);
      }
    }
  }

  panic() {
    this.legacy.panic();
    this.bass?.panic(); this.lead?.panic(); this.chords?.panic(); this.drums?.panic(); this.metronomeEngine?.panic();
    this.heldNotes.clear(); this.heldNoteKinds.clear(); this.heldNoteLanes.clear();
  }

  debugTone(frequency: number, duration: number, waveform?: OscillatorType, gain?: number, attack?: number, release?: number, delay?: number): DebugToneResult { return this.legacy.debugTone(frequency, duration, waveform, gain, attack, release, delay); }
  debugDrum(index: number, at: number, profile?: DeckSoundProfile, lane: VoiceLane = 'debug', velocity = 1) {
    if (this.drums) this.drums.debugDrum(index, at, profile ?? this.profileFor('drums', lane), lane, velocity);
    else this.legacy.debugDrum(index, at, profile, lane, velocity);
  }
  debugNote(instrument: NoteInstrument, midi: number, duration: number, at: number, profile?: DeckSoundProfile, lane: VoiceLane = 'debug', velocity = 1) { return this.note(instrument, midi, duration, at, profile, lane === 'deckA' || lane === 'deckB', lane, velocity); }
  stopDebugVoices() {
    this.legacy.stopDebugVoices();
    this.bass?.stopLane('debug'); this.lead?.stopLane('debug'); this.chords?.stopLane('debug');
    this.drums?.stopLane('debug');
    this.metronomeEngine?.stopLane('debug');
    for (const [id, lane] of this.heldNoteLanes) {
      if (lane === 'debug') { this.heldNoteLanes.delete(id); this.heldNoteKinds.delete(id); this.heldNotes.delete(id); }
    }
  }

  readOutputSpectrum(buffer: Float32Array<ArrayBuffer>) { return this.legacy.readOutputSpectrum(buffer); }
  getBassReleaseDiagnostics(): BassReleaseDiagnosticSnapshot[] { return this.legacy.getBassReleaseDiagnostics(); }
  getPresetIndexes() { return this.legacy.getPresetIndexes(); }

  getVoiceStats(): VoiceStatsSnapshot {
    const legacy = this.legacy.getLegacyOnlyVoiceStats();
    const bass = this.bass?.getVoiceStats();
    const lead = this.lead?.getVoiceStats();
    const chords = this.chords?.getVoiceStats();
    const metronome = this.metronomeEngine?.getVoiceStats();
    return {
      bass: bass?.bass ?? legacy.bass,
      lead: lead?.lead ?? legacy.lead,
      chords: chords?.chords ?? legacy.chords,
      activeSources: legacy.activeSources + (bass?.activeSources ?? 0) + (lead?.activeSources ?? 0) + (chords?.activeSources ?? 0) + (metronome?.activeSources ?? 0),
      drums: this.drums?.getVoiceStats().drums,
      metronome: metronome?.metronome,
    };
  }

  getSynthSnapshot(): SynthSnapshot & Record<string, unknown> {
    const legacy = this.legacy.getSynthSnapshot() as SynthSnapshot;
    const bassSnapshot = this.bass?.getSynthSnapshot() as Record<string, unknown> | undefined;
    return {
      ...legacy,
      engineMode: this.mode,
      voiceStats: this.getVoiceStats(),
      heldNotes: [...this.heldNotes.entries()].map(([id, voices]) => ({ id, kind: this.heldNoteKinds.get(id) ?? null, lane: this.heldNoteLanes.get(id) ?? 'live', voiceCount: voices.length })),
      bassLanes: (bassSnapshot?.bassLanes as BassLaneSnapshot[]) ?? [],
      bassReleaseDiagnostics: this.getBassReleaseDiagnostics(),
      independentBassTransitions: (bassSnapshot?.independentBassTransitions as SynthSnapshot['independentBassTransitions']) ?? [],
      independentLeadVoices: this.lead?.getVoiceSnapshots() ?? [],
      independentChordVoices: this.chords?.getVoiceSnapshots() ?? [],
      independentChordGroups: this.chords?.getGroups().map((group) => ({ id: group.id, state: group.state, voiceIds: group.children.map((voice) => voice.id) })) ?? [],
      independentDrumVoices: this.drums?.getVoiceSnapshots() ?? [],
      independentMetronomeVoices: this.metronomeEngine?.getVoiceSnapshots() ?? [],
    };
  }

  profileDestinationCacheSize() {
    return this.legacy.profileDestinationCacheSize()
      + (this.bass?.profileDestinationCacheSize() ?? 0)
      + (this.lead?.profileDestinationCacheSize() ?? 0)
      + (this.chords?.profileDestinationCacheSize() ?? 0)
      + (this.drums?.profileDestinationCacheSize() ?? 0)
      + (this.metronomeEngine?.profileDestinationCacheSize() ?? 0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Dispose instrument graphs first; the legacy master remains the shared
    // destination until all independent pools have received their stop path.
    this.bass?.dispose(); this.lead?.dispose(); this.chords?.dispose(); this.drums?.dispose(); this.metronomeEngine?.dispose();
    this.heldNotes.clear(); this.heldNoteKinds.clear(); this.heldNoteLanes.clear();
    // Legacy owns the shared master/context. Keep it connected while the
    // independent pools drain their bounded choke/effect tails.
    this.legacy.panic();
    const context = this.context;
    if (!context || this.independentRetainedCount() === 0) {
      this.legacy.dispose();
      return;
    }
    this.legacyDisposeDeadline = Math.max(context.currentTime + .05, this.independentCleanupHorizon());
    const finish = () => {
      this.legacyDisposeTimer = null;
      if (this.independentRetainedCount() === 0 && (this.context?.currentTime ?? this.legacyDisposeDeadline) >= this.legacyDisposeDeadline) {
        this.finishDeferredDispose(false);
        return;
      }
      this.legacyDisposeTimer = setTimeout(finish, 10);
      const timer = this.legacyDisposeTimer as unknown as { unref?: () => void };
      timer.unref?.();
    };
    finish();
    // A suspended context may never advance currentTime or dispatch source
    // ended events. After the bounded safe window, force only this teardown;
    // running audio contexts continue to use the audio-clock drain path.
    if (context.state === 'suspended') {
      this.legacyDisposeFallbackTimer = setTimeout(() => this.finishDeferredDispose(true), 500);
      const timer = this.legacyDisposeFallbackTimer as unknown as { unref?: () => void };
      timer.unref?.();
    }
  }

  private finishDeferredDispose(force: boolean) {
    if (this.legacyDisposeFallbackTimer !== null) {
      clearTimeout(this.legacyDisposeFallbackTimer);
      this.legacyDisposeFallbackTimer = null;
    }
    if (this.legacyDisposeTimer !== null) {
      clearTimeout(this.legacyDisposeTimer);
      this.legacyDisposeTimer = null;
    }
    if (force) {
      this.bass?.forceDispose();
      this.lead?.forceDispose();
      this.chords?.forceDispose();
      this.drums?.forceDispose();
      this.metronomeEngine?.forceDispose();
    }
    this.legacy.dispose();
  }

  private independentRetainedCount() {
    return (this.bass?.retainedCount() ?? 0) + (this.lead?.retainedCount() ?? 0) + (this.chords?.retainedCount() ?? 0) + (this.drums?.retainedCount() ?? 0) + (this.metronomeEngine?.retainedCount() ?? 0);
  }

  private independentCleanupHorizon() {
    return Math.max(this.bass?.cleanupHorizon() ?? 0, this.lead?.cleanupHorizon() ?? 0, this.chords?.cleanupHorizon() ?? 0, this.drums?.cleanupHorizon() ?? 0, this.metronomeEngine?.cleanupHorizon() ?? 0);
  }
}

export { HybridAudioEngine as HybridSynthEngine };
