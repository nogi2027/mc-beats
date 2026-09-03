import type { DeckInstrument, DeckSoundProfile, DrumEvent, NoteEvent, ChordEvent, DeckSnapshot, QuantizeDivision } from './deck.ts';
import type { Instrument, OutputControls } from './synth/contract.ts';

export type DeckId = 'A' | 'B';
export type MusicInstrument = DeckInstrument;
export type MusicalTime = { cycle: number; bar: number; tick: number };
export type TransferStyle = 'cut' | 'blend' | 'dip' | 'overlap';
export type CueStatus = 'pending' | 'scheduled' | 'executed' | 'cancelled' | 'failed';
export type RelativeBoundary = 'next-safe' | 'next-eighth' | 'next-beat' | 'next-bar' | 'next-four-bar-boundary';

export type MusicalContext = {
  label: string;
  root: number;
  mode: 'major' | 'minor';
  scalePitchClasses: number[];
};

export type ProjectSettings = {
  tempo: number;
  keyRoot: number;
  keyMode: 'major' | 'minor';
  quantize: QuantizeDivision;
  metronomeEnabled: boolean;
  switchEffect: TransferStyle;
};

export type LiveSoundPatch = {
  instrument: Instrument;
  presetId?: string;
  controls?: Record<string, number>;
  parameters?: Record<string, number>;
  volume?: number;
  drumModel?: 'layered' | 'noisy' | 'electronic';
};

export type GlobalDrumEvent = Omit<DrumEvent, 'startTick' | 'id'> & { type: 'drum'; id?: string; start: MusicalTime };
export type GlobalNoteEvent = Omit<NoteEvent, 'startTick' | 'id'> & { type: 'note'; id?: string; instrument: 'bass' | 'lead'; start: MusicalTime };
export type GlobalChordEvent = Omit<ChordEvent, 'startTick' | 'id'> & { type: 'chord'; id?: string; start: MusicalTime };
export type SoloEvent = GlobalDrumEvent | GlobalNoteEvent | GlobalChordEvent;
export type RelativeSoloEvent =
  | (Omit<GlobalDrumEvent, 'start'> & { offsetTicks: number })
  | (Omit<GlobalNoteEvent, 'start'> & { offsetTicks: number })
  | (Omit<GlobalChordEvent, 'start'> & { offsetTicks: number });

export type DeckPreparationTrack = {
  instrument: MusicInstrument;
  mode: 'add' | 'replace';
  events: AddDeckEvent[];
  profile?: DeckSoundProfile;
};
export type StoredSoloEvent =
  | (Omit<GlobalDrumEvent, 'id'> & { id: string })
  | (Omit<GlobalNoteEvent, 'id'> & { id: string })
  | (Omit<GlobalChordEvent, 'id'> & { id: string });

export type AddDeckEvent =
  | { type: 'drum'; id?: string; startTick: number; pad: number; velocity: number }
  | { type: 'note'; id?: string; instrument: 'bass' | 'lead'; startTick: number; durationTicks: number; pitch: number; velocity: number; articulation?: number }
  | { type: 'chord'; id?: string; startTick: number; durationTicks: number; symbol: string; pitches: number[]; velocity?: number; voicing?: ChordEvent['voicing']; articulation?: number };

export type CueAction =
  | { type: 'add-deck-events'; deck: DeckId; instrument: MusicInstrument; events: AddDeckEvent[] }
  | { type: 'remove-deck-events'; deck: DeckId; instrument: MusicInstrument; eventIds: string[] }
  | { type: 'replace-deck-events'; deck: DeckId; instrument: MusicInstrument; fromTick: number; toTick: number; events: AddDeckEvent[] }
  | { type: 'set-instrument-enabled'; instrument: MusicInstrument; enabled: boolean }
  | { type: 'set-deck-sound-profile'; deck: DeckId; instrument: MusicInstrument; profile: DeckSoundProfile; transitionTicks?: number }
  | { type: 'transfer-deck'; destination: DeckId; style: TransferStyle; durationTicks: number }
  | { type: 'start-solo'; soloId: string; instrument: MusicInstrument; description: string; lengthBars: number; soundProfile: DeckSoundProfile; initialEvents: RelativeSoloEvent[] }
  | { type: 'create-solo'; soloId: string; instrument: MusicInstrument; description: string; lengthBars: number; soundProfile: DeckSoundProfile; events: SoloEvent[] }
  | { type: 'add-solo-events'; soloId: string; events: SoloEvent[] }
  | { type: 'end-solo-early'; soloId: string };

export type Cue = {
  id: string;
  at: MusicalTime;
  action: CueAction;
  status: CueStatus;
  requestedAt: MusicalTime;
  normalisedAt: MusicalTime;
  resolvedAt?: MusicalTime;
  targetRevision?: { deck?: DeckId; instrument?: MusicInstrument; revision: number; humanRevision?: number };
  undone?: boolean;
  error?: { code: string; message: string };
  cancelledReason?: string;
  cancelledBy?: 'agent' | 'human' | 'transport' | 'replacement';
};

export type TransferState = {
  from: DeckId;
  destination: DeckId;
  style: TransferStyle;
  durationTicks: number;
  startedAt: MusicalTime;
  progress: number;
  status: 'active' | 'complete' | 'cancelled';
};

export type DeckProfileTransition = {
  deck: DeckId;
  instrument: MusicInstrument;
  sourceProfile: DeckSoundProfile;
  targetProfile: DeckSoundProfile;
  start: MusicalTime;
  end: MusicalTime;
  startAbsoluteTick: number;
  endAbsoluteTick: number;
  progress: number;
  status: 'active' | 'complete';
};

export type InstrumentControlState = {
  enabled: boolean;
  nextCue: { cueId: string; enabled: boolean; at: MusicalTime; ticksUntil: number } | null;
};

export type LivePerformanceEvent = {
  sequence: number;
  type: 'drum-hit' | 'note-on' | 'note-off' | 'chord-on' | 'chord-off';
  instrument: MusicInstrument;
  id: string;
  at: MusicalTime;
  velocity?: number;
  pad?: number;
  pitch?: number;
  pitches?: number[];
  symbol?: string;
  voicing?: ChordEvent['voicing'];
  durationTicks?: number;
};

export type LiveHeldState = {
  id: string;
  instrument: MusicInstrument;
  at: MusicalTime;
  velocity?: number;
  pitch?: number;
  pitches?: number[];
  symbol?: string;
  voicing?: ChordEvent['voicing'];
  pad?: number;
};

export type LivePerformanceSummary = {
  /** Fixed lookback used for the summary, measured in musical bars. */
  summaryWindowBars: 4;
  recentEventDensity: number;
  leadRange: { min: number; max: number } | null;
  recentChordLabels: string[];
};

export type LivePerformanceState = {
  latestSequence: number;
  oldestAvailableSequence: number;
  truncated: boolean;
  held: LiveHeldState[];
  recentEvents: LivePerformanceEvent[];
  summary: LivePerformanceSummary;
};

export type SoloState = {
  soloId: string;
  instrument: MusicInstrument;
  description: string;
  start: MusicalTime;
  startAbsoluteTick: number;
  endAbsoluteTick: number;
  lengthBars: number;
  soundProfile: DeckSoundProfile;
  events: StoredSoloEvent[];
  status: 'pending' | 'active' | 'ended';
};

export type MusicClockSnapshot = {
  running: boolean;
  audioTime: number | null;
  current: MusicalTime;
  absoluteBar: number;
  absoluteTick: number;
  deckPhaseTick: number;
  tempo: number;
};

export type MusicStateSnapshot = {
  stateVersion: number;
  activeDeck: DeckId;
  crossfadePosition: number;
  clock: MusicClockSnapshot;
  decks: Record<DeckId, DeckSnapshot>;
  instrumentEnabled: Record<MusicInstrument, boolean>;
  musicalKey: string | null;
  musicalContext: MusicalContext | null;
  projectSettings: ProjectSettings;
  audio: { ready: boolean; state: AudioContextState | null };
  liveSound: {
    presetIndexes: Record<Instrument, number>;
    controls: Record<Instrument, Record<string, number>>;
    volumes: Record<Instrument, number>;
    output: OutputControls;
  };
  orchestration: {
    recommendedTargetDeck: DeckId;
    activeDeck: DeckId;
    inactiveDeck: DeckId;
    normalSoloStart: RelativeBoundary;
    latestSoloStart: RelativeBoundary;
  };
  transfer: TransferState | null;
  solo: SoloState | null;
  pendingCues: Cue[];
  executedCues?: Cue[];
  currentChord: { deck: DeckId; event: ChordEvent } | null;
  upcomingChord: { deck: DeckId; event: ChordEvent } | null;
  chordContext: Record<DeckId, {
    current: { deck: DeckId; event: ChordEvent; remainingTicks: number } | null;
    upcoming: { deck: DeckId; event: ChordEvent; ticksUntil: number } | null;
  }>;
  profileTransitions: DeckProfileTransition[];
  instrumentControls: Record<MusicInstrument, InstrumentControlState>;
  livePerformance: LivePerformanceState;
};

export type MusicResult<T = unknown> = {
  ok: boolean;
  code: string;
  message: string;
  data?: T;
  issues?: Array<{ path: string; code: string; message: string }>;
};
