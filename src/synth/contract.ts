import type { DeckInstrument, DeckSoundProfile } from '../deck';

export type Instrument = 'drums' | 'bass' | 'chords' | 'lead' | 'metronome';
export type MusicalInstrument = Exclude<Instrument, 'metronome'>;
export type NoteInstrument = 'bass' | 'lead';
export type VoiceLane = 'live' | 'deck' | 'deckA' | 'deckB' | 'solo' | 'debug';
export type DrumModel = 'layered' | 'noisy' | 'electronic';
export type Controls = Record<string, number>;
export type OutputControls = {
  masterVolume: number;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  echoTimeMs: number;
  echoFeedback: number;
  echoMix: number;
};
export type Parameter = { label: string; min: number; max: number; step: number; value: number; unit: string };
export type VoiceGroupState = 'scheduled' | 'active' | 'releasing' | 'stopped';

/**
 * The small public surface shared by the UI, controller, histogram recorder,
 * deck transport, and future synth implementations.
 */
export interface AudioEngine {
  context: AudioContext | null;
  controls: Record<Instrument, Controls>;
  volumes: Record<Instrument, number>;
  outputControls: OutputControls;
  parameters: Record<Instrument, Record<string, Parameter>>;
  tempo: number;
  drumModel: DrumModel;
  heldNotes: Map<string, OscillatorNode[]>;
  heldNoteKinds: Map<string, NoteInstrument | 'chords' | 'metronome'>;

  start(): Promise<void>;
  setControl(instrument: Instrument, name: string, value: number): void;
  setDrumModel(model: DrumModel): void;
  setVolume(instrument: Instrument, value: number): void;
  setOutputControl(name: keyof OutputControls, value: number): void;
  setInstrumentEnabled(instrument: Instrument, enabled: boolean, at?: number, updateState?: boolean): void;
  /** Commit a previously scheduled enable state at its musical boundary. */
  commitInstrumentEnabled(instrument: Instrument, enabled: boolean, at?: number): void;
  isInstrumentEnabled(instrument: Instrument): boolean;
  setLaneGain(lane: Exclude<VoiceLane, 'deck'>, value: number, at?: number, duration?: number): void;
  setLaneGainRamp(lane: Exclude<VoiceLane, 'deck'>, value: number, at?: number, duration?: number): void;
  cancelLaneGainAutomation(lane: Exclude<VoiceLane, 'deck'>, at?: number): void;
  cancelInstrumentAutomation(instrument: Instrument, at?: number): void;
  laneGain(lane: Exclude<VoiceLane, 'deck'>): number;
  getSoundProfile(instrument: DeckInstrument, presetId: string): DeckSoundProfile;
  setParameter(instrument: Instrument, name: string, value: number): void;
  resetParameter(instrument: Instrument, presetIndex: number, name: string): void;
  loadPreset(instrument: Instrument, index: number): void;
  updateBassLaneProfile(lane: VoiceLane, profile?: DeckSoundProfile, at?: number): { applied: boolean; deferred: boolean; changed?: boolean; at?: number };
  note(instrument: Exclude<Instrument, 'drums'>, midi: number, duration?: number | null, at?: number, profile?: DeckSoundProfile, deckEvent?: boolean, lane?: VoiceLane, velocity?: number): OscillatorNode[];
  chord(pitches: number[], duration?: number | null, at?: number, profile?: DeckSoundProfile, deckEvent?: boolean, lane?: VoiceLane, velocity?: number): OscillatorNode[];
  drum(index: number, at?: number, profile?: DeckSoundProfile, deckEvent?: boolean, lane?: VoiceLane, velocity?: number): void;
  metronome(accent?: boolean, at?: number): void;
  hasHeldNote(id: string): boolean;
  holdNote(id: string, instrument: NoteInstrument | 'chords' | 'metronome', midi: number): OscillatorNode[];
  /** Hold a temporary diagnostic note on the debug lane, rather than live. */
  holdDebugNote(id: string, instrument: NoteInstrument, midi: number): OscillatorNode[];
  holdChord(id: string, pitches: number[], profile?: DeckSoundProfile): OscillatorNode[];
  releaseNote(id: string): ReleaseNoteResult | null;
  stopDeckVoices(lane?: VoiceLane): void;
  stopLaneVoices(lane: VoiceLane): void;
  panic(): void;
  debugTone(frequency: number, duration: number, waveform?: OscillatorType, gain?: number, attack?: number, release?: number, delay?: number): DebugToneResult;
  debugDrum(index: number, at: number, profile?: DeckSoundProfile, lane?: VoiceLane, velocity?: number): void;
  debugNote(instrument: NoteInstrument, midi: number, duration: number, at: number, profile?: DeckSoundProfile, lane?: VoiceLane, velocity?: number): OscillatorNode[];
  stopDebugVoices(): void;
  readOutputSpectrum(buffer: Float32Array<ArrayBuffer>): boolean;
  getBassReleaseDiagnostics(): BassReleaseDiagnosticSnapshot[];
  getPresetIndexes(): Record<Instrument, number>;
  getVoiceStats(): VoiceStatsSnapshot;
  getSynthSnapshot(): SynthSnapshot;
  profileDestinationCacheSize(): number;
  dispose(): void;
}

export type VoiceProfileSnapshot = Readonly<{
  fingerprint: string;
  profile?: Readonly<DeckSoundProfile>;
}>;

export type VoiceState = 'scheduled' | 'active' | 'releasing' | 'stopped';

export type ReleaseNoteResult = {
  id: string;
  instrument: Exclude<Instrument, 'drums'> | null;
  requestedAt: number;
  voiceCount: number;
  scheduledAt?: number;
  safetyOffsetSeconds?: number;
};

export type DebugToneResult = {
  requestedAt: number;
  scheduledAt: number;
  end: number;
} | null;

export type VoiceCountSnapshot = {
  groups: number;
  active: number;
  releasing: number;
  voices: number;
  musicalVoices: number;
};

export type VoiceStatsSnapshot = {
  bass: VoiceCountSnapshot;
  lead: VoiceCountSnapshot;
  chords: VoiceCountSnapshot;
  activeSources: number;
  drums?: VoiceCountSnapshot;
  metronome?: VoiceCountSnapshot;
};

export type BassReleaseDiagnosticSnapshot = {
  releaseAt: number;
  requestedAt: number;
  scheduledAt: number;
  safetyOffsetSeconds: number;
  capturedAt: number;
  sampleRate: number;
  sampleCount: number;
  windowSeconds: number;
  peak: number;
  rms: number;
  maxAdjacentSampleDelta: number;
  cause?: 'natural-release' | 'retrigger' | 'choke' | 'deck-gate-off' | 'stop';
  lane?: VoiceLane;
  voiceId?: string;
  windowStartAudioTime: number;
  windowEndAudioTime: number;
  releaseFrameIndex: number | null;
  releaseFrameTime: number | null;
  releasePeak: number;
  releaseMaxAdjacentSampleDelta: number;
};

/** Scheduling metadata from an independent bass engine. This is not a PCM
 * measurement and must never be presented as one. */
export type IndependentBassTransitionSnapshot = {
  voiceId: string;
  lane: VoiceLane;
  cause: 'natural-release' | 'retrigger' | 'choke' | 'stop' | 'rejected';
  requestedAt: number;
  scheduledAt: number;
  end: number;
};

export type BassLaneSnapshot = {
  lane: VoiceLane;
  persistent: boolean;
  currentMidi: number | null;
  currentHeldId: string | null;
  profilePresetId: string | null;
  graphProfile: object | null;
  pendingProfilePresetId: string | null;
  pendingGraphProfile: object | null;
  envelopeSegments: ReadonlyArray<Record<string, number>>;
  vcaSegments: ReadonlyArray<Record<string, number>>;
  independentVoiceIds?: ReadonlyArray<string>;
};

export type SynthSnapshot = {
  context: { state: AudioContextState | null; currentTime: number | null; sampleRate: number | null };
  tempo: number;
  drumModel: DrumModel;
  presetIndexes: Record<Instrument, number>;
  instrumentEnabled: Record<Instrument, boolean>;
  controls: Record<Instrument, Controls>;
  volumes: Record<Instrument, number>;
  parameters: Record<Instrument, Record<string, Parameter>>;
  outputControls?: OutputControls;
  heldNotes: Array<{ id: string; kind: Exclude<Instrument, 'drums'> | null; voiceCount: number; lane?: VoiceLane }>;
  voiceStats: VoiceStatsSnapshot;
  bassLanes: BassLaneSnapshot[];
  bassReleaseDiagnostics: BassReleaseDiagnosticSnapshot[];
  independentBassTransitions?: IndependentBassTransitionSnapshot[];
};
