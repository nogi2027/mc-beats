import { type DeckInstrument, type DeckSoundProfile, type DrumEvent, type NoteEvent, type ChordEvent, type RecordedTake, type RecordedTakeEvent, type QuantizeDivision, EIGHTH_NOTE_TICKS, DECK_TICKS, PPQ, BEATS_PER_BAR, SingleDeck, SharedDeckTransport, safeTempo, ticksToSeconds, playbackDurationSeconds } from './deck.ts';
import type { AudioEngine, Instrument, OutputControls, VoiceLane } from './synth/contract.ts';
import { FrequencyHistogramRecorder } from './frequency-history.ts';
import { skipMissedMetronomeBeats } from './metronome-scheduler.ts';
import { compileProgression, compileShorthandNotes, resolveSoundShorthand, type ProgressionBuildInput, type ShorthandNote, type SoundShorthand } from './music-agent.ts';
import { MUSIC_PRESETS, NOTE_NAMES, SCALE_INTERVALS } from './music-catalog.ts';
import { profileAtTransitionTick, profileTransitionProgress } from './profile-transition.ts';
import type { AddDeckEvent, Cue, CueAction, DeckId, DeckPreparationTrack, DeckProfileTransition, GlobalChordEvent, GlobalDrumEvent, GlobalNoteEvent, InstrumentControlState, LiveHeldState, LivePerformanceEvent, LivePerformanceState, LivePerformanceSummary, LiveSoundPatch, MusicClockSnapshot, MusicalContext, MusicInstrument, MusicResult, MusicStateSnapshot, MusicalTime, ProjectSettings, RelativeBoundary, RelativeSoloEvent, SoloEvent, SoloState, StoredSoloEvent, TransferState, TransferStyle } from './music-types.ts';

export const CYCLE_BARS = 24;
export const BAR_TICKS = PPQ * BEATS_PER_BAR;
export const SOLO_OPENING_BARS = 2;
export const SOLO_OPENING_TICKS = SOLO_OPENING_BARS * BAR_TICKS;
export const CYCLE_TICKS = CYCLE_BARS * BAR_TICKS;
export const MAX_MUSICAL_CYCLE = Math.floor(Number.MAX_SAFE_INTEGER / CYCLE_TICKS) - 1;
export const MAX_ABSOLUTE_TICK = MAX_MUSICAL_CYCLE * CYCLE_TICKS + CYCLE_TICKS - 1;
export const MAX_CUE_HORIZON_TICKS = CYCLE_TICKS * 64;
export const LOOKAHEAD_SECONDS = .1;
const CUE_INTERVAL_MS = 25;
const METRONOME_INTERVAL_MS = 25;
const MAX_HISTORY = 128;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const ok = <T>(data: T, message: string, code = 'OK'): MusicResult<T> => ({ ok: true, code, message, data });
type ValidationIssue = { path: string; code: string; message: string };
const fail = <T = never>(code: string, message: string, data?: unknown, issues?: ValidationIssue[]): MusicResult<T> => ({ ok: false, code, message, ...(data === undefined ? {} : { data: data as T }), ...(issues?.length ? { issues } : {}) });
const instruments: MusicInstrument[] = ['drums', 'bass', 'chords', 'lead'];
const isInstrument = (value: unknown): value is MusicInstrument => instruments.includes(value as MusicInstrument);
const laneForDeck = (deck: DeckId): 'deckA' | 'deckB' => deck === 'A' ? 'deckA' : 'deckB';
const isNoteInstrument = (value: unknown): value is 'bass' | 'lead' => value === 'bass' || value === 'lead';
const isVoicing = (value: unknown) => value === undefined || value === 'root' || value === 'open' || value === 'first-inversion' || value === 'second-inversion' || value === 'third-inversion';
const isGridTick = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= DECK_TICKS && value % EIGHTH_NOTE_TICKS === 0;
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const stringId = (value: unknown, max = 80) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isGridDuration = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= EIGHTH_NOTE_TICKS && value <= DECK_TICKS && value % EIGHTH_NOTE_TICKS === 0;
const isSoloGridDuration = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= EIGHTH_NOTE_TICKS && value <= CYCLE_TICKS && value % EIGHTH_NOTE_TICKS === 0;

export const absoluteTickOf = (time: MusicalTime) => (time.cycle * CYCLE_BARS + time.bar) * BAR_TICKS + time.tick;
export const fractionalMidiOf = (frequencyHz: number) => 69 + 12 * Math.log2(frequencyHz / 440);
export const musicalTimeOf = (absoluteTick: number): MusicalTime => {
  const safe = Math.min(MAX_ABSOLUTE_TICK, Math.max(0, Math.floor(absoluteTick)));
  const cycle = Math.floor(safe / CYCLE_TICKS);
  const cycleTick = safe % CYCLE_TICKS;
  return { cycle, bar: Math.floor(cycleTick / BAR_TICKS), tick: cycleTick % BAR_TICKS };
};
export const isMusicalTime = (value: unknown): value is MusicalTime => isObject(value)
  && Number.isInteger(value.cycle) && (value.cycle as number) >= 0 && (value.cycle as number) <= MAX_MUSICAL_CYCLE
  && Number.isInteger(value.bar) && (value.bar as number) >= 0 && (value.bar as number) < CYCLE_BARS
  && Number.isInteger(value.tick) && (value.tick as number) >= 0 && (value.tick as number) < BAR_TICKS;
export const quantizeMusicalTime = (time: MusicalTime, barBoundary = false): MusicalTime => musicalTimeOf(Math.ceil(absoluteTickOf(time) / (barBoundary ? BAR_TICKS : EIGHTH_NOTE_TICKS)) * (barBoundary ? BAR_TICKS : EIGHTH_NOTE_TICKS));
export type CueTimingInput = { at?: MusicalTime; when?: RelativeBoundary };
export type CueTimingResolution = { requestedAt: MusicalTime; resolvedAt: MusicalTime; normalisedAt: MusicalTime; earliestSafeTime: MusicalTime; earliestSafeAudioTime: number | null; boundary: RelativeBoundary | null };
export const nextBoundaryAbsoluteTick = (absoluteTick: number, boundary: RelativeBoundary) => {
  const step = boundary === 'next-safe' || boundary === 'next-eighth' ? EIGHTH_NOTE_TICKS : boundary === 'next-beat' ? PPQ : boundary === 'next-bar' ? BAR_TICKS : DECK_TICKS;
  return Math.floor(absoluteTick / step) * step + step;
};

type HumanRecording = { active: boolean; deck: DeckId; instrument: MusicInstrument };
type HumanRecordingInverse = {
  deck: DeckId;
  instrument: MusicInstrument;
  added: Array<DrumEvent | NoteEvent | ChordEvent>;
  removed: Array<DrumEvent | NoteEvent | ChordEvent>;
  previousProfile?: DeckSoundProfile;
  previousTransition?: { deck: DeckId; instrument: MusicInstrument; sourceProfile: DeckSoundProfile; targetProfile: DeckSoundProfile; startAbsoluteTick: number; endAbsoluteTick: number };
  expectedRevision: number;
};
type Inverse =
  | { kind: 'deck-add'; cueId: string; deck: DeckId; instrument: MusicInstrument; added: Array<DrumEvent | NoteEvent | ChordEvent>; replaced: Array<DrumEvent | NoteEvent | ChordEvent> }
  | { kind: 'deck-remove'; cueId: string; deck: DeckId; instrument: MusicInstrument; removed: Array<DrumEvent | NoteEvent | ChordEvent> }
  | { kind: 'deck-replace'; cueId: string; deck: DeckId; instrument: MusicInstrument; added: Array<DrumEvent | NoteEvent | ChordEvent>; removed: Array<DrumEvent | NoteEvent | ChordEvent> }
  | { kind: 'profile'; cueId: string; deck: DeckId; instrument: MusicInstrument; previous?: DeckSoundProfile; previousTransition?: { deck: DeckId; instrument: MusicInstrument; sourceProfile: DeckSoundProfile; targetProfile: DeckSoundProfile; startAbsoluteTick: number; endAbsoluteTick: number }; expectedRevision: number }
  | { kind: 'enabled'; cueId: string; instrument: MusicInstrument; previous: boolean; expectedRevision: number }
  | { kind: 'transfer'; cueId: string; previousActive: DeckId; previousTransfer: TransferState | null; expectedRevision: number }
  | { kind: 'solo-state'; cueId: string; previous: SoloState | null; previousPlayed: string[]; expectedRevision: number }
  | { kind: 'solo-add'; cueId: string; soloId: string; addedIds: string[]; expectedRevision: number }
  | { kind: 'deck-prepare'; cueId: string; deck: DeckId; previous: ReturnType<SingleDeck['snapshot']>; expectedRevisions: Record<MusicInstrument, number> };
type Transaction = { cueId: string; inverse: Inverse };
type ReleaseProbe = { probeId: string; instrument: 'bass' | 'lead'; events: Array<{ at: number; releaseAt: number; releaseEnd: number; frequencyHz: number; durationMs: number }>; capture: { status: 'not-implemented'; reason: string } };
export type HeldRetriggerOperation = { action: 'hold' | 'release'; id: string; intendedAudioTime: number; observedAudioTime?: number; driftMs?: number; before?: Record<string, unknown>; after?: Record<string, unknown>; result?: unknown };
export type HeldRetriggerProbeInput = { firstId: string; firstFrequencyHz: number; secondId: string; secondFrequencyHz: number; firstHoldMs: number; retriggerGapMs: number; secondHoldMs: number; bandIndices?: number[]; minFrequencyHz?: number; maxFrequencyHz?: number; captureLeadMs?: number; captureTailMs?: number; maxSamples?: number };
export const planHeldRetriggerProbe = (input: Pick<HeldRetriggerProbeInput, 'firstId' | 'secondId' | 'firstHoldMs' | 'retriggerGapMs' | 'secondHoldMs' | 'captureLeadMs' | 'captureTailMs'>, anchor: number) => {
  const firstRelease = anchor + input.firstHoldMs / 1000;
  const secondHold = firstRelease + input.retriggerGapMs / 1000;
  const secondRelease = secondHold + input.secondHoldMs / 1000;
  const tiePriority = (action: HeldRetriggerOperation['action']) => input.retriggerGapMs < 0 ? (action === 'hold' ? 0 : 1) : (action === 'release' ? 0 : 1);
  const operations: HeldRetriggerOperation[] = [
    { action: 'hold' as const, id: input.firstId, intendedAudioTime: anchor },
    ...(secondHold < firstRelease ? [{ action: 'hold' as const, id: input.secondId, intendedAudioTime: secondHold }] : []),
    { action: 'release' as const, id: input.firstId, intendedAudioTime: firstRelease },
    ...(secondHold >= firstRelease ? [{ action: 'hold' as const, id: input.secondId, intendedAudioTime: secondHold }] : []),
    { action: 'release' as const, id: input.secondId, intendedAudioTime: secondRelease },
  ].sort((left, right) => left.intendedAudioTime - right.intendedAudioTime || tiePriority(left.action) - tiePriority(right.action));
  const leadMs = input.captureLeadMs ?? 25;
  const tailMs = input.captureTailMs ?? 75;
  return { operations, firstRelease, secondHold, secondRelease, captureWindow: { start: Math.min(firstRelease, secondHold) - leadMs / 1000, end: Math.max(firstRelease, secondRelease) + tailMs / 1000 } };
};
type HeldRetriggerProbe = { probeId: string; status: 'scheduled' | 'complete' | 'degraded-timing' | 'failed' | 'cancelled'; requested: Record<string, unknown>; audioAnchor: number; operations: HeldRetriggerOperation[]; captureWindow: { start: number; end: number }; capture: { leadMs: number; tailMs: number; maxSamples?: number; bandIndices?: number[]; minFrequencyHz?: number; maxFrequencyHz?: number }; failure?: string };

let nextCueId = 1;
let nextProbeId = 1;
let nextSoloEventId = 1;
let nextAgentEventId = 1;
const makeCueId = () => `cue-${nextCueId++}`;
const makeAgentEventId = (kind: string) => `agent-${kind}-${nextAgentEventId++}`;

export class MusicController {
  readonly engine: AudioEngine;
  readonly decks: { A: SingleDeck; B: SingleDeck };
  readonly transport: SharedDeckTransport;
  readonly histogram: FrequencyHistogramRecorder;
  activeDeck: DeckId = 'A';
  private manualCrossfade = 0;
  private stateVersion = 0;
  private cueTimer: number | null = null;
  private cueTimers = new Map<string, number>();
  private preScheduledAudio = new Map<string, { kind: 'instrument'; instrument: MusicInstrument; enabled: boolean; at: number } | { kind: 'transfer'; from: DeckId; destination: DeckId; style: TransferStyle; duration: number; at: number } | { kind: 'solo-create'; eventIds: string[]; at: number }>();
  private pendingCues: Cue[] = [];
  private executedCues: Cue[] = [];
  private transactions: Transaction[] = [];
  private listeners = new Set<() => void>();
  private enabled: Record<MusicInstrument, boolean> = { drums: true, bass: true, chords: true, lead: true };
  private targetRevisions = new Map<string, number>();
  private humanTargetRevisions = new Map<string, number>();
  private globalRevisions: Record<MusicInstrument, number> = { drums: 0, bass: 0, chords: 0, lead: 0 };
  private transferRevision = 0;
  private soloRevision = 0;
  private anchorAudioTime = 0;
  private anchorAbsoluteTick = 0;
  private anchorTempo = 120;
  private clockRunning = false;
  private transfer: TransferState | null = null;
  private transferTimer: number | null = null;
  private solo: SoloState | null = null;
  private musicalContext: MusicalContext | null = null;
  private soloPlayed = new Set<string>();
  private humanRecording: HumanRecording = { active: false, deck: 'A', instrument: 'lead' };
  private humanRecordingInverse: HumanRecordingInverse | null = null;
  private profileTransitions = new Map<string, { deck: DeckId; instrument: MusicInstrument; sourceProfile: DeckSoundProfile; targetProfile: DeckSoundProfile; startAbsoluteTick: number; endAbsoluteTick: number }>();
  private liveSequence = 0;
  private liveEvents: LivePerformanceEvent[] = [];
  private liveHeld = new Map<string, LiveHeldState>();
  private releaseProbes = new Map<string, ReleaseProbe>();
  private heldRetriggerProbes = new Map<string, HeldRetriggerProbe>();
  private heldRetriggerTimers = new Map<string, number[]>();
  private disposed = false;
  private metronomeTimer: number | null = null;
  private projectSettings: ProjectSettings = { tempo: 120, keyRoot: 2, keyMode: 'minor', quantize: '1/8', metronomeEnabled: false, switchEffect: 'blend' };

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.engine.tempo = this.projectSettings.tempo;
    this.musicalContext = { label: 'Dm', root: 2, mode: 'minor', scalePitchClasses: SCALE_INTERVALS.minor.map((interval) => (2 + interval) % 12) };
    this.decks = { A: new SingleDeck(), B: new SingleDeck() };
    this.histogram = new FrequencyHistogramRecorder(engine);
    this.transport = new SharedDeckTransport(
      () => this.engine.context,
      () => this.engine.tempo,
      this.decks,
      {
        drum: (pad, velocity, at, profile, lane) => this.engine.drum(pad, at, profile, true, lane, velocity),
        note: (instrument, pitch, velocity, duration, at, profile, lane) => {
          if (instrument === 'bass') this.engine.updateBassLaneProfile(lane, profile, at);
          return this.engine.note(instrument, pitch, duration, at, profile, true, lane, velocity);
        },
        chord: (pitches, velocity, duration, at, profile, lane) => this.engine.chord(pitches, duration, at, profile, true, lane, velocity),
        stop: () => this.engine.stopDeckVoices(),
      },
      {
        onStart: (at, tempo, tickAnchor) => { this.anchorAudioTime = at; this.anchorAbsoluteTick = tickAnchor; this.anchorTempo = tempo; this.clockRunning = true; this.bump(); },
        onStop: (at, tick) => { this.anchorAudioTime = at; this.anchorAbsoluteTick = tick; this.clockRunning = false; this.pauseScheduledCues(); this.bump(); },
        scheduleView: (deckId, absoluteTick) => this.scheduledDeckView(deckId, absoluteTick),
      },
    );
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getActiveDeck() { return this.activeDeck; }
  private bump() { this.stateVersion += 1; this.listeners.forEach((listener) => listener()); }
  async startAudio(): Promise<MusicResult<{ started: boolean; state: AudioContextState | null }>> {
    try {
      await this.engine.start();
      // The controller owns active-deck selection, including selections made
      // before audio starts. Reassert both targets after the engine creates its
      // graph so legacy and independent lanes begin in the same state.
      const now = this.engine.context?.currentTime;
      if (now !== undefined) {
        this.engine.setLaneGain('deckA', this.manualCrossfade >= 1 ? 0 : Math.cos(this.manualCrossfade * Math.PI / 2), now, .01);
        this.engine.setLaneGain('deckB', this.manualCrossfade <= 0 ? 0 : Math.sin(this.manualCrossfade * Math.PI / 2), now, .01);
      }
      this.histogram.start();
      this.refreshMetronomeScheduler();
      this.bump();
      return ok({ started: Boolean(this.engine.context), state: this.engine.context?.state ?? null }, 'Audio started.', 'AUDIO_STARTED');
    } catch (error) {
      return fail('AUDIO_START_FAILED', error instanceof Error ? error.message : 'The AudioContext could not start.');
    }
  }

  async startTransport(): Promise<MusicResult<MusicClockSnapshot>> {
    const context = this.engine.context;
    if (!context) return fail('AUDIO_NOT_STARTED', 'Start audio before starting the musical transport.');
    try {
      if (typeof context.resume === 'function') await context.resume();
    } catch (error) {
      return fail('AUDIO_START_FAILED', error instanceof Error ? error.message : 'The AudioContext could not resume.');
    }
    if (!this.transport.start()) return fail('CLOCK_START_FAILED', 'The shared musical transport could not start.');
    return ok(this.clockSnapshot(), 'The shared musical transport is running.', 'TRANSPORT_STARTED');
  }

  stopTransport() {
    this.transport.stop();
    return ok(this.clockSnapshot(), 'The shared musical transport stopped and global time is frozen.', 'TRANSPORT_STOPPED');
  }

  setTransport(running: boolean) {
    return running ? this.startTransport() : Promise.resolve(this.stopTransport());
  }

  startRecordingTransport(startAt: number, instrument: MusicInstrument, replace: boolean) {
    if (!Number.isFinite(startAt) || !isInstrument(instrument)) return fail('INVALID_RECORDING_TRANSPORT', 'Recording transport timing or instrument is invalid.');
    this.transport.setMuted(instrument, replace);
    if (!this.transport.start(startAt)) {
      this.transport.setMuted(instrument, false);
      return fail('CLOCK_START_FAILED', 'The shared recording transport could not start.');
    }
    return ok({ startAt, instrument, muted: replace }, 'The shared recording transport is running.', 'RECORDING_TRANSPORT_STARTED');
  }

  retimeRecordingTransport(startAt: number) {
    if (!Number.isFinite(startAt)) return fail('INVALID_RECORDING_TRANSPORT', 'Recording transport timing is invalid.');
    this.transport.retime(startAt);
    return ok({ startAt }, 'The recording transport was retimed.', 'RECORDING_TRANSPORT_RETIMED');
  }

  setRecordingInstrumentMuted(instrument: MusicInstrument, muted: boolean) {
    if (!isInstrument(instrument)) return fail('INVALID_INSTRUMENT', 'The recording instrument is invalid.');
    this.transport.setMuted(instrument, muted);
    return ok({ instrument, muted }, 'Recording track mute updated.', 'RECORDING_TRACK_MUTE_UPDATED');
  }

  catchUpRecordingEvents(deck: DeckId, instrument: MusicInstrument, events: Array<DrumEvent | NoteEvent | ChordEvent>) {
    if (!this.validateDeck(deck) || !isInstrument(instrument)) return fail('INVALID_RECORDING_TRANSPORT', 'The recording deck or instrument is invalid.');
    return ok({ scheduled: this.transport.catchUpCommittedEvents(deck, instrument, events) }, 'Committed recording events were scheduled.', 'RECORDING_EVENTS_SCHEDULED');
  }

  getEarliestSafeTime() {
    const context = this.engine.context;
    const clock = this.clockSnapshot();
    if (!context || !clock.running) return ok({ earliestSafeTime: clock.current, earliestSafeAudioTime: null, absoluteTick: clock.absoluteTick, tempo: clock.tempo }, 'Audio or transport has not started.', 'EARLIEST_SAFE_TIME');
    const ticksPerSecond = PPQ * clock.tempo / 60;
    const safeAudio = context.currentTime + LOOKAHEAD_SECONDS;
    const safeTick = Math.ceil(this.anchorAbsoluteTick + (safeAudio - this.anchorAudioTime) * ticksPerSecond);
    if (safeTick > MAX_ABSOLUTE_TICK) return fail('CUE_TOO_FAR', 'The earliest safe time exceeds the supported musical clock range.');
    const nextSafeTick = nextBoundaryAbsoluteTick(safeTick - 1, 'next-safe');
    const nextBeatTick = nextBoundaryAbsoluteTick(clock.absoluteTick, 'next-beat');
    const nextBarTick = nextBoundaryAbsoluteTick(clock.absoluteTick, 'next-bar');
    return ok({ earliestSafeTime: musicalTimeOf(safeTick), earliestSafeAudioTime: safeAudio, absoluteTick: safeTick, tempo: clock.tempo, boundaries: { nextSafe: musicalTimeOf(nextSafeTick), nextBeat: musicalTimeOf(nextBeatTick), nextBar: musicalTimeOf(nextBarTick) }, normalSoloStart: musicalTimeOf(nextBarTick), latestSoloStart: musicalTimeOf(nextBarTick) }, 'Earliest safe scheduling time.', 'EARLIEST_SAFE_TIME');
  }

  selectActiveDeck(deck: DeckId) {
    if (deck === this.activeDeck) return;
    this.humanCancelTransfer();
    this.activeDeck = deck;
    this.manualCrossfade = deck === 'A' ? 0 : 1;
    const now = this.engine.context?.currentTime;
    if (now !== undefined) {
      this.engine.setLaneGainRamp(laneForDeck(deck), 1, now, .01);
      this.engine.setLaneGainRamp(laneForDeck(deck === 'A' ? 'B' : 'A'), 0, now, .01);
    }
    this.bump();
  }
  humanSetCrossfade(value: number, style: TransferStyle = 'blend') {
    this.clearTransferTimer();
    this.transfer = null;
    this.transferRevision += 1;
    this.pendingCues.filter((cue) => cue.action.type === 'transfer-deck').forEach((cue) => this.cancelCueInternal(cue, 'Cancelled by human crossfade.', 'human'));
    const raw = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : this.manualCrossfade;
    const audible = style === 'cut' ? (raw < .5 ? 0 : 1) : raw;
    const gains = style === 'dip'
      ? [Math.max(0, 1 - raw * 2), Math.max(0, raw * 2 - 1)]
      : style === 'overlap'
        ? [raw < .5 ? 1 : Math.cos((raw - .5) * Math.PI), raw < .5 ? Math.sin(raw * Math.PI) : 1]
        : [audible >= 1 ? 0 : Math.cos(audible * Math.PI / 2), audible <= 0 ? 0 : Math.sin(audible * Math.PI / 2)];
    const at = this.engine.context?.currentTime;
    if (at !== undefined) {
      this.engine.cancelLaneGainAutomation('deckA', at);
      this.engine.cancelLaneGainAutomation('deckB', at);
      this.engine.setLaneGainRamp('deckA', gains[0], at, .018);
      this.engine.setLaneGainRamp('deckB', gains[1], at, .018);
    }
    this.manualCrossfade = raw;
    this.activeDeck = audible < .5 ? 'A' : 'B';
    this.bump();
    return raw;
  }

  setHumanRecording(active: boolean, deck: DeckId = 'A', instrument: MusicInstrument = 'lead') {
    this.humanRecording = { active, deck, instrument };
    if (active) this.cancelConflictingCues(deck, instrument);
    this.bump();
  }
  humanDeckMutation(deck: DeckId, instrument?: MusicInstrument) {
    if (instrument) this.profileTransitions.delete(this.profileKey(deck, instrument));
    else instruments.forEach((name) => this.profileTransitions.delete(this.profileKey(deck, name)));
    if (instrument) this.bumpHumanTarget(deck, instrument);
    else instruments.forEach((name) => this.bumpHumanTarget(deck, name));
    this.cancelConflictingCues(deck, instrument);
    this.bump();
  }
  humanMutateDeck(deck: DeckId, mutation: (target: SingleDeck) => void, instrument?: MusicInstrument) {
    mutation(this.decks[deck]);
    this.humanDeckMutation(deck, instrument);
  }
  humanSetSoundProfile(deck: DeckId, instrument: MusicInstrument, profile: DeckSoundProfile) {
    this.decks[deck].setSoundProfile(instrument, profile);
    this.profileTransitions.delete(this.profileKey(deck, instrument));
    if (instrument === 'bass') this.engine.updateBassLaneProfile(laneForDeck(deck), profile);
    this.humanProfileMutation(deck, instrument);
  }
  humanSetInstrumentEnabled(instrument: MusicInstrument, enabled: boolean) {
    this.cancelPendingControlCue(instrument);
    this.enabled[instrument] = enabled;
    this.globalRevisions[instrument] += 1;
    if (!enabled) this.clearHumanHeld(instrument);
    this.engine.setInstrumentEnabled(instrument, enabled);
    this.bump();
    return ok({ instrument, enabled }, 'Human instrument state changed immediately.', 'HUMAN_INSTRUMENT_STATE_CHANGED');
  }
  commitHumanRecording(deck: DeckId, take: RecordedTake, profile: DeckSoundProfile): MusicResult<{ deck: DeckId; instrument: MusicInstrument; mode: 'overdub' | 'replace'; count: number; added: Array<DrumEvent | NoteEvent | ChordEvent>; removed: Array<DrumEvent | NoteEvent | ChordEvent> }> {
    if (deck !== this.activeDeck) return fail('RECORDING_TARGET_NOT_ACTIVE', 'Human recording must commit to the active deck.');
    const before = this.decks[deck].snapshot();
    const previousEvents = this.decks[deck].events(take.instrument);
    const previousProfile = this.decks[deck].profile(take.instrument);
    const transitionKey = this.profileKey(deck, take.instrument);
    const previousTransition = this.profileTransitions.get(transitionKey);
    try {
      if (take.count === 0) {
        this.humanRecording = { ...this.humanRecording, active: false };
        this.bump();
        return ok({ deck, instrument: take.instrument, mode: take.mode, count: 0, added: [], removed: [] }, 'Empty human recording made no changes.', 'HUMAN_RECORDING_EMPTY');
      }
      this.profileTransitions.delete(transitionKey);
      if (take.mode === 'replace') this.decks[deck].clearInstrument(take.instrument);
      take.events.forEach((event) => this.addRecordedTakeEvent(deck, take.instrument, event, take.quantizeTicks));
      this.decks[deck].setSoundProfile(take.instrument, profile);
      const currentEvents = this.decks[deck].events(take.instrument);
      const currentIds = new Set(currentEvents.map((event) => event.id));
      const takeIds = new Set(take.events.map((event) => event.id));
      const added = currentEvents.filter((event) => takeIds.has(event.id));
      const removed = previousEvents.filter((event) => !currentIds.has(event.id));
      this.bumpHumanTarget(deck, take.instrument);
      this.humanRecording = { ...this.humanRecording, active: false };
      this.humanRecordingInverse = { deck, instrument: take.instrument, added: clone(added), removed: clone(removed), ...(previousProfile ? { previousProfile: clone(previousProfile) } : {}), ...(previousTransition ? { previousTransition: clone(previousTransition) } : {}), expectedRevision: this.targetRevision(deck, take.instrument) };
      this.bump();
      return ok({ deck, instrument: take.instrument, mode: take.mode, count: take.count, added: clone(added), removed: clone(removed) }, 'Human recording committed atomically.', 'HUMAN_RECORDING_COMMITTED');
    } catch (error) {
      this.decks[deck].restore(before);
      if (previousTransition) this.profileTransitions.set(transitionKey, clone(previousTransition));
      else this.profileTransitions.delete(transitionKey);
      return fail('HUMAN_RECORDING_FAILED', error instanceof Error ? error.message : 'The human recording could not be committed.');
    }
  }
  undoLastHumanRecording(): MusicResult<{ deck: DeckId; instrument: MusicInstrument }> {
    const inverse = this.humanRecordingInverse;
    if (!inverse) return fail('NOTHING_TO_UNDO', 'There is no human recording to undo.');
    if (this.targetRevision(inverse.deck, inverse.instrument) !== inverse.expectedRevision) return fail('UNDO_CONFLICT', 'A later human or agent change touched the recorded deck lane.');
    const current = this.decks[inverse.deck].events(inverse.instrument);
    const exact = inverse.added.every((event) => current.some((candidate) => candidate.id === event.id && JSON.stringify(candidate) === JSON.stringify(event)));
    if (!exact) return fail('UNDO_CONFLICT', 'A later change modified the recorded events.');
    this.decks[inverse.deck].removeExactEvents(inverse.instrument, inverse.added);
    this.decks[inverse.deck].restoreEvents(inverse.instrument, inverse.removed);
    if (inverse.previousProfile) this.decks[inverse.deck].setSoundProfile(inverse.instrument, inverse.previousProfile);
    else this.decks[inverse.deck].removeSoundProfile(inverse.instrument);
    const transitionKey = this.profileKey(inverse.deck, inverse.instrument);
    if (inverse.previousTransition) this.profileTransitions.set(transitionKey, clone(inverse.previousTransition));
    else this.profileTransitions.delete(transitionKey);
    this.bumpHumanTarget(inverse.deck, inverse.instrument);
    this.humanRecordingInverse = null;
    this.bump();
    return ok({ deck: inverse.deck, instrument: inverse.instrument }, 'The latest human recording was undone.', 'HUMAN_RECORDING_UNDONE');
  }
  private addRecordedTakeEvent(deck: DeckId, instrument: MusicInstrument, event: RecordedTakeEvent, quantizeTicks?: number) {
    if (instrument === 'drums') {
      const drum = event as DrumEvent;
      return this.decks[deck].addDrum(drum.pad, drum.startTick, drum.velocity, drum.id, quantizeTicks);
    }
    if (instrument === 'chords') {
      const chord = event as ChordEvent;
      return this.decks[deck].addChord(chord.symbol, chord.pitches, chord.startTick, chord.durationTicks, chord.voicing ?? 'root', chord.articulation, chord.id, chord.velocity ?? 1, quantizeTicks);
    }
    const note = event as NoteEvent;
    return this.decks[deck].addNote(instrument, note.pitch, note.startTick, note.durationTicks, note.velocity, note.articulation, note.id, quantizeTicks);
  }
  humanProfileMutation(deck: DeckId, instrument: MusicInstrument) { this.profileTransitions.delete(this.profileKey(deck, instrument)); this.bumpHumanTarget(deck, instrument); this.cancelConflictingCues(deck, instrument); this.bump(); }

  humanDrumHit(pad: number, velocity = 1, at?: number) {
    this.recordLiveEvent({ type: 'drum-hit', instrument: 'drums', id: `drum-${this.liveSequence + 1}`, pad, velocity, at: this.liveTime(at) });
  }
  humanNoteOn(id: string, instrument: 'bass' | 'lead', pitch: number, velocity = 1, at?: number) {
    if (this.liveHeld.has(id)) return;
    const event = { type: 'note-on' as const, instrument, id, pitch, velocity, at: this.liveTime(at) };
    this.liveHeld.set(id, clone(event));
    this.recordLiveEvent(event);
  }
  humanNoteOff(id: string, at?: number) {
    const held = this.liveHeld.get(id);
    if (!held || (held.instrument !== 'bass' && held.instrument !== 'lead')) return;
    const end = this.liveTime(at);
    this.liveHeld.delete(id);
    this.recordLiveEvent({ type: 'note-off', instrument: held.instrument, id, pitch: held.pitch, velocity: held.velocity, at: end, durationTicks: Math.max(0, Math.round(absoluteTickOf(end) - absoluteTickOf(held.at))) });
  }
  humanChordOn(id: string, symbol: string, pitches: number[], voicing: ChordEvent['voicing'] = 'root', velocity = 1, at?: number) {
    if (this.liveHeld.has(id)) return;
    const event = { type: 'chord-on' as const, instrument: 'chords' as const, id, symbol, pitches: [...pitches], voicing, velocity, at: this.liveTime(at) };
    this.liveHeld.set(id, clone(event));
    this.recordLiveEvent(event);
  }
  humanChordOff(id: string, at?: number) {
    const held = this.liveHeld.get(id);
    if (!held || held.instrument !== 'chords') return;
    const end = this.liveTime(at);
    this.liveHeld.delete(id);
    this.recordLiveEvent({ type: 'chord-off', instrument: 'chords', id, symbol: held.symbol, pitches: held.pitches, voicing: held.voicing, velocity: held.velocity, at: end, durationTicks: Math.max(0, Math.round(absoluteTickOf(end) - absoluteTickOf(held.at))) });
  }
  clearHumanHeld(instrument?: MusicInstrument, at?: number) {
    const held = [...this.liveHeld.values()].filter((entry) => !instrument || entry.instrument === instrument);
    if (held.length === 0) return;
    const end = this.liveTime(at);
    held.forEach((entry) => {
      this.liveHeld.delete(entry.id);
      const durationTicks = Math.max(0, Math.round(absoluteTickOf(end) - absoluteTickOf(entry.at)));
      if (entry.instrument === 'chords') this.recordLiveEvent({ type: 'chord-off', instrument: 'chords', id: entry.id, symbol: entry.symbol, pitches: entry.pitches, voicing: entry.voicing, velocity: entry.velocity, at: end, durationTicks });
      else this.recordLiveEvent({ type: 'note-off', instrument: entry.instrument as 'bass' | 'lead', id: entry.id, pitch: entry.pitch, velocity: entry.velocity, at: end, durationTicks });
    });
  }
  clearHumanHeldSilently(instrument?: MusicInstrument) {
    const ids = [...this.liveHeld.entries()].filter(([, entry]) => !instrument || entry.instrument === instrument).map(([id]) => id);
    ids.forEach((id) => this.liveHeld.delete(id));
    if (ids.length > 0) this.bump();
  }
  private liveTime(at?: number): MusicalTime {
    const context = this.engine.context;
    if (at !== undefined && context && this.clockRunning) return musicalTimeOf(this.anchorAbsoluteTick + (at - this.anchorAudioTime) * PPQ * this.anchorTempo / 60);
    return musicalTimeOf(this.clockSnapshot().absoluteTick);
  }
  private recordLiveEvent(event: Omit<LivePerformanceEvent, 'sequence'>) {
    const recorded = { ...clone(event), sequence: ++this.liveSequence } as LivePerformanceEvent;
    this.liveEvents.push(recorded);
    if (this.liveEvents.length > 256) this.liveEvents.splice(0, this.liveEvents.length - 256);
    this.bump();
  }
  private targetKey(deck: DeckId, instrument: MusicInstrument) { return `${deck}:${instrument}`; }
  private targetRevision(deck: DeckId, instrument: MusicInstrument) { return this.targetRevisions.get(this.targetKey(deck, instrument)) ?? 0; }
  private bumpTarget(deck: DeckId, instrument: MusicInstrument) { this.targetRevisions.set(this.targetKey(deck, instrument), this.targetRevision(deck, instrument) + 1); }
  private humanTargetRevision(deck: DeckId, instrument: MusicInstrument) { return this.humanTargetRevisions.get(this.targetKey(deck, instrument)) ?? 0; }
  private bumpHumanTarget(deck: DeckId, instrument: MusicInstrument) {
    this.bumpTarget(deck, instrument);
    const key = this.targetKey(deck, instrument);
    this.humanTargetRevisions.set(key, this.humanTargetRevision(deck, instrument) + 1);
  }
  private cancelConflictingCues(deck: DeckId, instrument?: MusicInstrument) {
    this.pendingCues.filter((cue) => {
      const action = cue.action;
      return action.type !== 'add-deck-events' && action.type !== 'set-instrument-enabled' && action.type !== 'transfer-deck' && action.type !== 'start-solo' && action.type !== 'create-solo' && action.type !== 'add-solo-events' && action.type !== 'end-solo-early'
        && 'deck' in action && action.deck === deck && (!instrument || action.instrument === instrument);
    }).forEach((cue) => this.cancelCueInternal(cue, 'Cancelled by human input on the same target.', 'human'));
  }
  cancelPendingControlCue(instrument?: MusicInstrument) {
    this.pendingCues
      .filter((cue) => cue.action.type === 'set-instrument-enabled' && (!instrument || cue.action.instrument === instrument))
      .forEach((cue) => this.cancelCueInternal(cue, 'Cancelled by human control.', 'human'));
    this.bump();
  }

  clockSnapshot(): MusicClockSnapshot {
    const audioTime = this.engine.context?.currentTime ?? null;
    const absoluteTick = this.clockRunning && audioTime !== null ? Math.min(MAX_ABSOLUTE_TICK, Math.max(0, this.anchorAbsoluteTick + (audioTime - this.anchorAudioTime) * PPQ * this.anchorTempo / 60)) : Math.min(MAX_ABSOLUTE_TICK, Math.max(0, this.anchorAbsoluteTick));
    return { running: this.clockRunning, audioTime, current: musicalTimeOf(absoluteTick), absoluteBar: Math.floor(absoluteTick / BAR_TICKS), absoluteTick, deckPhaseTick: Math.floor(absoluteTick) % DECK_TICKS, tempo: safeTempo(this.engine.tempo) };
  }
  audioTimeAt(absoluteTick: number) { return this.anchorAudioTime + (absoluteTick - this.anchorAbsoluteTick) * 60 / (PPQ * this.anchorTempo); }

  private profileKey(deck: DeckId, instrument: MusicInstrument) { return `${deck}:${instrument}`; }
  private cleanupProfileTransitions(absoluteTick: number) {
    [...this.profileTransitions.entries()].forEach(([key, transition]) => { if (absoluteTick >= transition.endAbsoluteTick) this.profileTransitions.delete(key); });
  }
  private effectiveProfileAt(deck: DeckId, instrument: MusicInstrument, absoluteTick: number) {
    const transition = this.profileTransitions.get(this.profileKey(deck, instrument));
    const committed = this.decks[deck].profile(instrument) ?? this.engine.getSoundProfile(instrument, `deck-${deck}-${instrument}-current`);
    if (!transition) return committed;
    return profileAtTransitionTick(transition.sourceProfile, transition.targetProfile, transition.startAbsoluteTick, transition.endAbsoluteTick, absoluteTick);
  }
  private profileForDeckTick(deck: DeckId, instrument: MusicInstrument, absoluteTick: number) {
    const key = this.profileKey(deck, instrument);
    const active = this.profileTransitions.get(key);
    const committed = this.decks[deck].profile(instrument) ?? this.engine.getSoundProfile(instrument, `deck-${deck}-${instrument}-current`);
    let timeline: {
      profile: DeckSoundProfile;
      transition: { sourceProfile: DeckSoundProfile; targetProfile: DeckSoundProfile; startAbsoluteTick: number; endAbsoluteTick: number } | null;
    } = { profile: clone(committed), transition: active ? clone(active) : null };
    const evaluate = (tick: number) => timeline.transition
      ? profileAtTransitionTick(timeline.transition.sourceProfile, timeline.transition.targetProfile, timeline.transition.startAbsoluteTick, timeline.transition.endAbsoluteTick, tick)
      : clone(timeline.profile);
    const cues = this.pendingCues
      .filter((cue) => (cue.status === 'pending' || cue.status === 'scheduled') && cue.action.type === 'set-deck-sound-profile' && cue.action.deck === deck && cue.action.instrument === instrument && absoluteTickOf(cue.normalisedAt) <= absoluteTick)
      .sort((left, right) => absoluteTickOf(left.normalisedAt) - absoluteTickOf(right.normalisedAt) || left.id.localeCompare(right.id));
    cues.forEach((cue) => {
      const action = cue.action;
      if (action.type !== 'set-deck-sound-profile') return;
      const start = absoluteTickOf(cue.normalisedAt);
      const source = evaluate(start);
      timeline = action.transitionTicks && action.transitionTicks > 0
        ? { profile: clone(source), transition: { sourceProfile: clone(source), targetProfile: clone(action.profile), startAbsoluteTick: start, endAbsoluteTick: start + action.transitionTicks } }
        : { profile: clone(action.profile), transition: null };
    });
    return evaluate(absoluteTick);
  }
  private profileTransitionSnapshots(absoluteTick: number): DeckProfileTransition[] {
    this.cleanupProfileTransitions(absoluteTick);
    return [...this.profileTransitions.values()].map((transition) => ({
      deck: transition.deck,
      instrument: transition.instrument,
      sourceProfile: clone(transition.sourceProfile),
      targetProfile: clone(transition.targetProfile),
      start: musicalTimeOf(transition.startAbsoluteTick),
      end: musicalTimeOf(transition.endAbsoluteTick),
      startAbsoluteTick: transition.startAbsoluteTick,
      endAbsoluteTick: transition.endAbsoluteTick,
      progress: profileTransitionProgress(absoluteTick, transition.startAbsoluteTick, transition.endAbsoluteTick),
      status: absoluteTick >= transition.endAbsoluteTick ? 'complete' : 'active',
    }));
  }
  private instrumentControlSnapshot(clock: MusicClockSnapshot): Record<MusicInstrument, InstrumentControlState> {
    const result = {} as Record<MusicInstrument, InstrumentControlState>;
    instruments.forEach((instrument) => {
      const nextCue = this.pendingCues
        .filter((cue) => (cue.status === 'pending' || cue.status === 'scheduled') && cue.action.type === 'set-instrument-enabled' && cue.action.instrument === instrument && absoluteTickOf(cue.normalisedAt) >= clock.absoluteTick)
        .sort((left, right) => absoluteTickOf(left.normalisedAt) - absoluteTickOf(right.normalisedAt) || left.id.localeCompare(right.id))[0];
      result[instrument] = { enabled: this.enabled[instrument], nextCue: nextCue && nextCue.action.type === 'set-instrument-enabled' ? { cueId: nextCue.id, enabled: nextCue.action.enabled, at: clone(nextCue.normalisedAt), ticksUntil: Math.max(0, Math.ceil(absoluteTickOf(nextCue.normalisedAt) - clock.absoluteTick)) } : null };
    });
    return result;
  }
  private livePerformanceSnapshot(includeLiveEvents = true, sinceSequence?: number, maxLiveEvents = 64, currentAbsoluteTick = this.clockSnapshot().absoluteTick): LivePerformanceState {
    const oldestAvailableSequence = this.liveEvents[0]?.sequence ?? (this.liveSequence > 0 ? this.liveSequence + 1 : 0);
    const cursorTruncated = sinceSequence !== undefined && sinceSequence < oldestAvailableSequence - 1;
    const filtered = this.liveEvents.filter((event) => sinceSequence === undefined || event.sequence > sinceSequence);
    const limit = Math.max(0, Math.min(256, Math.floor(Number.isFinite(maxLiveEvents) ? maxLiveEvents : 64)));
    const recentEvents = includeLiveEvents ? filtered.slice(Math.max(0, filtered.length - limit)).map(clone) : [];
    const truncated = cursorTruncated || (includeLiveEvents && filtered.length > limit);
    const windowBars = 4 as const;
    const windowStart = Math.max(0, currentAbsoluteTick - windowBars * BAR_TICKS);
    const recentAttacks = this.liveEvents.filter((event) => {
      if (event.type !== 'drum-hit' && event.type !== 'note-on' && event.type !== 'chord-on') return false;
      const tick = absoluteTickOf(event.at);
      return tick >= windowStart && tick <= currentAbsoluteTick;
    });
    const leadPitches = recentAttacks.filter((event) => event.type === 'note-on' && event.instrument === 'lead' && event.pitch !== undefined).map((event) => event.pitch!);
    const labels = recentAttacks.filter((event) => event.type === 'chord-on' && event.symbol).map((event) => event.symbol!);
    const summary: LivePerformanceSummary = { summaryWindowBars: windowBars, recentEventDensity: recentAttacks.length / windowBars, leadRange: leadPitches.length ? { min: Math.min(...leadPitches), max: Math.max(...leadPitches) } : null, recentChordLabels: [...new Set(labels.slice(-8))] };
    return { latestSequence: this.liveSequence, oldestAvailableSequence, truncated, held: [...this.liveHeld.values()].map(clone), recentEvents, summary };
  }

  getState(options: { includeParameters?: boolean; includeExecutedCues?: boolean; includeLiveEvents?: boolean; liveSinceSequence?: number; maxLiveEvents?: number } = {}): MusicStateSnapshot {
    const clock = this.clockSnapshot();
    const profileTransitions = this.profileTransitionSnapshots(clock.absoluteTick);
    const contexts = { A: this.chordContext('A', clock.absoluteTick), B: this.chordContext('B', clock.absoluteTick) };
    const activeContext = contexts[this.activeDeck];
    const state: MusicStateSnapshot = {
      stateVersion: this.stateVersion,
      activeDeck: this.activeDeck,
      crossfadePosition: this.transfer ? (this.transfer.from === 'A' ? this.transferProgress(this.transfer) : 1 - this.transferProgress(this.transfer)) : this.manualCrossfade,
      clock,
      decks: { A: this.decks.A.snapshot(), B: this.decks.B.snapshot() },
      instrumentEnabled: { ...this.enabled },
      musicalKey: this.musicalContext?.label ?? null,
      musicalContext: this.musicalContext ? clone(this.musicalContext) : null,
      projectSettings: clone(this.projectSettings),
      audio: { ready: Boolean(this.engine.context), state: this.engine.context?.state ?? null },
      liveSound: { presetIndexes: this.engine.getPresetIndexes(), controls: clone(this.engine.controls), volumes: clone(this.engine.volumes), output: clone(this.engine.outputControls) },
      orchestration: { recommendedTargetDeck: this.activeDeck === 'A' ? 'B' : 'A', activeDeck: this.activeDeck, inactiveDeck: this.activeDeck === 'A' ? 'B' : 'A', normalSoloStart: 'next-bar', latestSoloStart: 'next-bar' },
      transfer: this.transfer ? { ...clone(this.transfer), progress: this.transferProgress(this.transfer) } : null,
      solo: this.solo ? clone(this.solo) : null,
      pendingCues: clone(this.pendingCues),
      currentChord: activeContext.current ? { deck: this.activeDeck, event: clone(activeContext.current.event) } : null,
      upcomingChord: activeContext.upcoming ? { deck: this.activeDeck, event: clone(activeContext.upcoming.event) } : null,
      chordContext: clone(contexts),
      profileTransitions,
      instrumentControls: this.instrumentControlSnapshot(clock),
      livePerformance: this.livePerformanceSnapshot(options.includeLiveEvents !== false, options.liveSinceSequence, options.maxLiveEvents ?? 64, clock.absoluteTick),
    };
    if (options.includeExecutedCues) state.executedCues = clone(this.executedCues);
    if (options.includeParameters) (state as MusicStateSnapshot & { synth?: unknown }).synth = this.engine.getSynthSnapshot();
    return state;
  }

  buildSnapshot(app: Record<string, unknown> = {}) { return { schemaVersion: 3, exportedAt: new Date().toISOString(), page: typeof window === 'undefined' ? null : window.location.href, app: clone(app), synth: this.engine.getSynthSnapshot(), music: this.getState({ includeExecutedCues: true, includeParameters: true }), frequencyHistory: this.histogram.snapshot(10, true) }; }

  setMusicalContext(context: MusicalContext) {
    const pitchClasses = [...new Set(context.scalePitchClasses.map((pitch) => ((Math.round(pitch) % 12) + 12) % 12))];
    this.musicalContext = { label: context.label, root: ((Math.round(context.root) % 12) + 12) % 12, mode: context.mode, scalePitchClasses: pitchClasses };
    this.bump();
  }

  getProjectSettings() { return clone(this.projectSettings); }

  setProjectSettings(patch: Partial<ProjectSettings>) {
    if (!isObject(patch) || !exactKeys(patch, ['tempo', 'keyRoot', 'keyMode', 'quantize', 'metronomeEnabled', 'switchEffect'])) return fail('INVALID_PROJECT_SETTINGS', 'Project settings contain unknown fields.');
    const next = { ...this.projectSettings, ...patch };
    const validQuantize: QuantizeDivision[] = ['off', '1/4', '1/8', '1/16'];
    const validStyle: TransferStyle[] = ['cut', 'blend', 'dip', 'overlap'];
    if (!Number.isFinite(next.tempo) || next.tempo <= 0 || next.tempo > 999) return fail('INVALID_TEMPO', 'Tempo must be greater than 0 and no more than 999 BPM.');
    if (!Number.isInteger(next.keyRoot) || next.keyRoot < 0 || next.keyRoot > 11) return fail('INVALID_KEY', 'keyRoot must be an integer from 0 to 11.');
    if (next.keyMode !== 'major' && next.keyMode !== 'minor') return fail('INVALID_KEY', 'keyMode must be major or minor.');
    if (!validQuantize.includes(next.quantize)) return fail('INVALID_QUANTIZE', 'quantize must be off, 1/4, 1/8, or 1/16.');
    if (typeof next.metronomeEnabled !== 'boolean') return fail('INVALID_METRONOME', 'metronomeEnabled must be boolean.');
    if (!validStyle.includes(next.switchEffect)) return fail('INVALID_SWITCH_EFFECT', 'switchEffect must be cut, blend, dip, or overlap.');
    const previous = clone(this.projectSettings);
    const tempoChanged = next.tempo !== previous.tempo;
    if (tempoChanged) {
      const before = this.clockSnapshot();
      this.engine.tempo = next.tempo;
      if (this.clockRunning && this.engine.context) {
        this.anchorAudioTime = this.engine.context.currentTime;
        this.anchorAbsoluteTick = before.absoluteTick;
        this.anchorTempo = next.tempo;
        this.transport.retime();
      }
    }
    this.projectSettings = next;
    const label = `${NOTE_NAMES[next.keyRoot]}${next.keyMode === 'minor' ? 'm' : ''}`;
    this.musicalContext = { label, root: next.keyRoot, mode: next.keyMode, scalePitchClasses: SCALE_INTERVALS[next.keyMode].map((interval) => (next.keyRoot + interval) % 12) };
    if (tempoChanged || next.metronomeEnabled !== previous.metronomeEnabled) this.refreshMetronomeScheduler();
    this.bump();
    return ok({ previous, current: clone(next) }, 'Project settings updated.', 'PROJECT_SETTINGS_UPDATED');
  }

  setCrossfader(position: number, style: TransferStyle = this.projectSettings.switchEffect) {
    if (!Number.isFinite(position) || position < 0 || position > 1) return fail('INVALID_CROSSFADER', 'position must be between 0 and 1.');
    if (!['cut', 'blend', 'dip', 'overlap'].includes(style)) return fail('INVALID_SWITCH_EFFECT', 'style must be cut, blend, dip, or overlap.');
    this.projectSettings = { ...this.projectSettings, switchEffect: style };
    const applied = this.humanSetCrossfade(position, style);
    return ok({ position: applied, style, activeDeck: this.activeDeck }, 'Crossfader updated immediately.', 'CROSSFADER_UPDATED');
  }

  clearDeck(deck: DeckId, selectedInstruments: MusicInstrument[] = instruments) {
    if (!this.validateDeck(deck)) return fail('INVALID_DECK', 'Deck must be A or B.');
    if (!Array.isArray(selectedInstruments) || selectedInstruments.length < 1 || new Set(selectedInstruments).size !== selectedInstruments.length || selectedInstruments.some((instrument) => !isInstrument(instrument))) return fail('INVALID_INSTRUMENTS', 'Provide one or more unique musical instruments.');
    const previous = this.decks[deck].snapshot();
    if (selectedInstruments.length === instruments.length) this.decks[deck].clear();
    else selectedInstruments.forEach((instrument) => this.decks[deck].clearInstrument(instrument));
    selectedInstruments.forEach((instrument) => { this.profileTransitions.delete(this.profileKey(deck, instrument)); this.bumpTarget(deck, instrument); });
    const operationId = makeCueId();
    const expectedRevisions = Object.fromEntries(instruments.map((instrument) => [instrument, this.targetRevision(deck, instrument)])) as Record<MusicInstrument, number>;
    this.transactions.push({ cueId: operationId, inverse: { kind: 'deck-prepare', cueId: operationId, deck, previous, expectedRevisions } });
    this.trimHistory(this.transactions);
    this.bump();
    return ok({ operationId, deck, instruments: [...selectedInstruments] }, `Deck ${deck} cleared.`, 'DECK_CLEARED');
  }

  setLiveSound(patch: LiveSoundPatch) {
    if (!isObject(patch) || !exactKeys(patch, ['instrument', 'presetId', 'controls', 'parameters', 'volume', 'drumModel'])) return fail('INVALID_SOUND_PATCH', 'Sound settings contain unknown fields.');
    const instrument = patch.instrument;
    if (!['drums', 'bass', 'chords', 'lead', 'metronome'].includes(instrument)) return fail('INVALID_INSTRUMENT', 'instrument is invalid.');
    const presetIndex = patch.presetId === undefined ? undefined : MUSIC_PRESETS[instrument].findIndex((preset) => preset.toLowerCase() === patch.presetId!.toLowerCase());
    if (presetIndex === -1) return fail('INVALID_PRESET', `Unknown ${instrument} preset.`);
    if (patch.controls !== undefined && (!isObject(patch.controls) || Object.entries(patch.controls).some(([name, value]) => !(name in this.engine.controls[instrument]) || !this.validNumber(value, 0, 1)))) return fail('INVALID_CONTROLS', 'Every control must be known and between 0 and 1.');
    if (patch.parameters !== undefined && (!isObject(patch.parameters) || Object.entries(patch.parameters).some(([name, value]) => { const parameter = this.engine.parameters[instrument][name]; return !parameter || !this.validNumber(value, parameter.min, parameter.max); }))) return fail('INVALID_PARAMETERS', 'Every parameter must be known and inside its declared range.');
    if (patch.volume !== undefined && !this.validNumber(patch.volume, 0, 1)) return fail('INVALID_VOLUME', 'volume must be between 0 and 1.');
    if (patch.drumModel !== undefined && (instrument !== 'drums' || !['layered', 'noisy', 'electronic'].includes(patch.drumModel))) return fail('INVALID_DRUM_MODEL', 'drumModel is only valid for drums.');
    if (presetIndex !== undefined) this.engine.loadPreset(instrument, presetIndex);
    Object.entries(patch.controls ?? {}).forEach(([name, value]) => this.engine.setControl(instrument, name, value));
    Object.entries(patch.parameters ?? {}).forEach(([name, value]) => this.engine.setParameter(instrument, name, value));
    if (patch.volume !== undefined) this.engine.setVolume(instrument, patch.volume);
    if (patch.drumModel !== undefined) this.engine.setDrumModel(patch.drumModel);
    this.bump();
    return ok({ instrument, presetIndex: this.engine.getPresetIndexes()[instrument], presetId: MUSIC_PRESETS[instrument][this.engine.getPresetIndexes()[instrument]], controls: clone(this.engine.controls[instrument]), volume: this.engine.volumes[instrument] }, `${instrument} sound updated.`, 'LIVE_SOUND_UPDATED');
  }

  resetLiveParameter(instrument: Instrument, presetIndex: number, name: string) {
    if (!['drums', 'bass', 'chords', 'lead', 'metronome'].includes(instrument) || !Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= MUSIC_PRESETS[instrument].length || !(name in this.engine.parameters[instrument])) return fail('INVALID_PARAMETER', 'The parameter reset target is invalid.');
    this.engine.resetParameter(instrument, presetIndex, name);
    this.bump();
    return ok({ instrument, name, value: this.engine.parameters[instrument][name].value }, 'Parameter reset.', 'PARAMETER_RESET');
  }

  setOutput(patch: Partial<OutputControls>) {
    if (!isObject(patch) || !exactKeys(patch, ['masterVolume', 'eqLowDb', 'eqMidDb', 'eqHighDb', 'echoTimeMs', 'echoFeedback', 'echoMix'])) return fail('INVALID_OUTPUT', 'Output settings contain unknown fields.');
    const ranges: Record<keyof OutputControls, [number, number]> = { masterVolume: [0, 1], eqLowDb: [-12, 12], eqMidDb: [-12, 12], eqHighDb: [-12, 12], echoTimeMs: [40, 900], echoFeedback: [0, .75], echoMix: [0, 1] };
    const invalid = Object.entries(patch).find(([name, value]) => { const range = ranges[name as keyof OutputControls]; return !range || !this.validNumber(value, range[0], range[1]); });
    if (invalid) return fail('INVALID_OUTPUT', `${invalid[0]} is outside its allowed range.`);
    Object.entries(patch).forEach(([name, value]) => this.engine.setOutputControl(name as keyof OutputControls, value));
    this.bump();
    return ok({ output: clone(this.engine.outputControls) }, 'Output controls updated.', 'OUTPUT_UPDATED');
  }

  getCatalog() {
    const parameters = Object.fromEntries((Object.keys(MUSIC_PRESETS) as Instrument[]).map((instrument) => [instrument, Object.fromEntries(Object.entries(this.engine.parameters[instrument]).map(([name, parameter]) => [name, { label: parameter.label, min: parameter.min, max: parameter.max, step: parameter.step, unit: parameter.unit }]))]));
    return { presets: clone(MUSIC_PRESETS), controls: Object.fromEntries((Object.keys(MUSIC_PRESETS) as Instrument[]).map((instrument) => [instrument, Object.keys(this.engine.controls[instrument])])), parameters, shorthand: { degrees: [1, 2, 3, 4, 5, 6, 7], romanDegrees: ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii°'], durations: ['1/8', '1/4', '1/2', '1bar'], drumNames: ['kick', 'snare', 'closed-hat', 'open-hat', 'clap', 'low-tom', 'high-tom', 'perc', 'rim', 'shaker', 'cowbell', 'ride'], drumPatterns: ['none', 'backbeat', 'four-on-floor', 'half-time'], bassPatterns: ['none', 'roots', 'pulses'], chordPatterns: ['none', 'sustained', 'stabs'] }, project: { keyRoots: NOTE_NAMES, keyModes: ['major', 'minor'], quantize: ['off', '1/4', '1/8', '1/16'], switchEffects: ['cut', 'blend', 'dip', 'overlap'] }, output: { masterVolume: [0, 1], eqDb: [-12, 12], echoTimeMs: [40, 900], echoFeedback: [0, .75], echoMix: [0, 1] } };
  }

  getLivePerformance(options: { sinceSequence?: number; maxEvents?: number } = {}) {
    const clock = this.clockSnapshot();
    return this.livePerformanceSnapshot(true, options.sinceSequence, options.maxEvents ?? 32, clock.absoluteTick);
  }

  getAgentBrief(options: { liveSinceSequence?: number; maxLiveEvents?: number } = {}) {
    const state = this.getState({ includeLiveEvents: true, liveSinceSequence: options.liveSinceSequence, maxLiveEvents: options.maxLiveEvents ?? 12 });
    const nextBarTick = nextBoundaryAbsoluteTick(state.clock.absoluteTick, 'next-bar');
    const ticksUntilNextBar = Math.max(0, nextBarTick - state.clock.absoluteTick);
    const secondsUntilNextBar = ticksUntilNextBar * 60 / (PPQ * state.clock.tempo);
    const estimatedTokensPerBarAt30Tps = Math.round(7200 / state.clock.tempo);
    const activeChords = state.decks[state.activeDeck].events.chords.map((event) => event.symbol);
    const actions: Array<Record<string, unknown>> = [];
    if (!state.audio.ready) actions.push({ tool: 'music_initialize_audio', arguments: { startTransport: true }, reason: 'Audio must exist before timed actions.' });
    else if (!state.clock.running) actions.push({ tool: 'music_set_transport', arguments: { running: true }, reason: 'The musical clock is stopped.' });
    actions.push({ tool: 'music_fill_inactive_deck', arguments: { progression: [1, 4, 1, 5], drums: 'backbeat', bass: 'roots', chords: 'sustained' }, reason: `Build Deck ${state.orchestration.inactiveDeck} without calculating pitches or ticks.` });
    actions.push({ tool: 'music_start_guided_solo', arguments: { soloId: 'solo-1', instrument: 'lead', lengthBars: 4, when: 'next-bar', openingNotes: [{ bar: 1, degree: 1, duration: '1/4' }, { bar: 2, degree: 3, duration: '1/4' }] }, reason: 'For the fastest start, send only the first two bars. Later bars are accepted but take longer to stage.' });
    return {
      protocolVersion: 3,
      stateVersion: state.stateVersion,
      project: { tempo: state.clock.tempo, key: state.musicalKey, mode: state.projectSettings.keyMode, quantize: state.projectSettings.quantize, metronomeEnabled: state.projectSettings.metronomeEnabled },
      transport: { running: state.clock.running, current: state.clock.current, activeDeck: state.activeDeck, inactiveDeck: state.orchestration.inactiveDeck, crossfadePosition: state.crossfadePosition, nextBar: musicalTimeOf(nextBarTick) },
      timing: { secondsUntilNextBar: Number(secondsUntilNextBar.toFixed(3)), estimatedTokensPerBarAt30Tps, rule: 'Prepare arguments first. During timed work, call tools at once without narration or another state read.' },
      harmony: { currentChord: state.currentChord?.event.symbol ?? null, upcomingChord: state.upcomingChord?.event.symbol ?? null, activeDeckProgression: activeChords },
      humanPlaying: { latestSequence: state.livePerformance.latestSequence, held: state.livePerformance.held, summary: state.livePerformance.summary, recentEvents: state.livePerformance.recentEvents },
      solo: state.solo ? { soloId: state.solo.soloId, status: state.solo.status, instrument: state.solo.instrument, start: state.solo.start, lengthBars: state.solo.lengthBars } : null,
      pendingCues: state.pendingCues.map((cue) => ({ cueId: cue.id, at: cue.normalisedAt, action: cue.action.type, status: cue.status })),
      recommendedActions: actions,
    };
  }

  buildProgression(deck: DeckId, input: ProgressionBuildInput) {
    if (!this.validateDeck(deck)) return fail('INVALID_DECK', 'Deck must be A or B.', { retryWith: { tool: 'music_fill_inactive_deck', arguments: input } });
    for (const [instrument, shorthand] of Object.entries(input.sounds ?? {}) as Array<['drums' | 'bass' | 'chords', SoundShorthand]>) {
      if (!resolveSoundShorthand(instrument, shorthand)) return fail('INVALID_PRESET', `Unknown ${instrument} preset.`, { retryWith: { tool: 'music_get_agent_brief', arguments: {} } });
    }
    const compiled = compileProgression(input, this.projectSettings.keyRoot, this.projectSettings.keyMode);
    if (!compiled || compiled.tracks.length === 0) return fail('INVALID_PROGRESSION', 'Provide one to four valid scale degrees and at least one enabled arrangement lane.', { retryWith: { tool: 'music_build_progression', arguments: { deck, progression: [1, 4, 1, 5], drums: 'backbeat', bass: 'roots', chords: 'sustained' } } });
    const prepared = this.prepareDeck(deck, compiled.tracks);
    if (!prepared.ok) return { ...prepared, data: { ...(isObject(prepared.data) ? prepared.data : {}), retryWith: { tool: deck === this.activeDeck ? 'music_fill_inactive_deck' : 'music_build_progression', arguments: deck === this.activeDeck ? input : { deck, ...input } } } };
    return ok({ ...prepared.data, degrees: compiled.degrees, chords: compiled.chords.map((chord) => chord.symbol), generatedEvents: compiled.tracks.reduce((count, track) => count + track.events.length, 0), nextActions: [{ tool: 'music_cue_transfer', arguments: { destination: deck, style: this.projectSettings.switchEffect, durationTicks: BAR_TICKS, when: 'next-bar' } }] }, `Deck ${deck} built from scale degrees.`, 'PROGRESSION_BUILT');
  }

  fillInactiveDeck(input: ProgressionBuildInput) {
    const deck: DeckId = this.activeDeck === 'A' ? 'B' : 'A';
    return this.buildProgression(deck, input);
  }

  startGuidedSolo(input: { soloId: string; instrument: 'bass' | 'lead'; lengthBars: number; description?: string; when?: RelativeBoundary; sound?: SoundShorthand; openingNotes: ShorthandNote[] }) {
    const retryWith = { tool: 'music_start_guided_solo', arguments: { ...input, when: 'next-bar', openingNotes: [{ bar: 1, degree: 1, duration: '1/4' }, { bar: 2, degree: 3, duration: '1/4' }] } };
    const profile = resolveSoundShorthand(input.instrument, input.sound);
    if (!profile) return fail('INVALID_PRESET', `Unknown ${input.instrument} preset.`, { retryWith });
    const events = compileShorthandNotes(input.openingNotes, input.instrument, this.projectSettings.keyRoot, this.projectSettings.keyMode);
    if (!events) return fail('INVALID_SOLO_EVENTS', 'openingNotes contain invalid shorthand.', { retryWith });
    const opening = events.filter((event) => event.offsetTicks < SOLO_OPENING_TICKS);
    const later = events.filter((event) => event.offsetTicks >= SOLO_OPENING_TICKS);
    const started = this.queueAction({ when: input.when ?? 'next-bar' }, { type: 'start-solo', soloId: input.soloId, instrument: input.instrument, description: input.description ?? 'Guided solo', lengthBars: input.lengthBars, soundProfile: profile, initialEvents: opening });
    if (!started.ok) return { ...started, data: { ...(isObject(started.data) ? started.data : {}), retryWith } };
    if (later.length > 0) {
      const staged = this.stageSoloEvents(input.soloId, later);
      if (!staged.ok) {
        this.cancelCue(started.data!.cueId);
        return { ...staged, data: { ...(isObject(staged.data) ? staged.data : {}), retryWith } };
      }
    }
    return ok({ ...started.data, openingEventCount: opening.length, stagedEventCount: later.length, usedExtendedInput: later.length > 0 }, later.length > 0 ? 'Solo queued; the first two bars start it and later notes were staged.' : 'Solo queued from its two-bar opening.', 'CUE_ACCEPTED');
  }

  scheduleSection(input: { soloId: string; instrument: 'bass' | 'lead'; lengthBars: number; description?: string; when?: RelativeBoundary; sound?: SoundShorthand; notes: ShorthandNote[]; transfer?: { destination?: DeckId; afterBars: number; style?: TransferStyle; durationBeats?: number } }) {
    const retryWith = { tool: 'music_schedule_section', arguments: { ...input, when: 'next-bar' } };
    const profile = resolveSoundShorthand(input.instrument, input.sound);
    const events = compileShorthandNotes(input.notes, input.instrument, this.projectSettings.keyRoot, this.projectSettings.keyMode);
    if (!profile) return fail('INVALID_PRESET', `Unknown ${input.instrument} preset.`, { retryWith });
    if (!events) return fail('INVALID_SOLO_EVENTS', 'Section notes contain invalid shorthand.', { retryWith });
    const opening = events.filter((event) => event.offsetTicks < SOLO_OPENING_TICKS);
    const later = events.filter((event) => event.offsetTicks >= SOLO_OPENING_TICKS);
    const started = this.queueAction({ when: input.when ?? 'next-bar' }, { type: 'start-solo', soloId: input.soloId, instrument: input.instrument, description: input.description ?? 'Scheduled section', lengthBars: input.lengthBars, soundProfile: profile, initialEvents: opening });
    if (!started.ok) return { ...started, data: { ...(isObject(started.data) ? started.data : {}), retryWith } };
    if (later.length > 0) {
      const staged = this.stageSoloEvents(input.soloId, later);
      if (!staged.ok) { this.cancelCue(started.data!.cueId); return { ...staged, data: { ...(isObject(staged.data) ? staged.data : {}), retryWith } }; }
    }
    let transferCueId: string | null = null;
    if (input.transfer) {
      const afterBars = input.transfer.afterBars;
      const durationBeats = input.transfer.durationBeats ?? 1;
      if (!Number.isInteger(afterBars) || afterBars < 1 || afterBars > input.lengthBars || !Number.isFinite(durationBeats) || durationBeats < 0 || durationBeats > 16) { this.cancelCue(started.data!.cueId); return fail('INVALID_SECTION_TRANSFER', 'Transfer timing must lie inside the section and use 0-16 beats.', { retryWith }); }
      const destination = input.transfer.destination ?? (this.activeDeck === 'A' ? 'B' : 'A');
      const transferAt = musicalTimeOf(absoluteTickOf(started.data!.normalisedAt) + afterBars * BAR_TICKS);
      const transfer = this.queueAction(transferAt, { type: 'transfer-deck', destination, style: input.transfer.style ?? this.projectSettings.switchEffect, durationTicks: Math.round(durationBeats * PPQ) });
      if (!transfer.ok) { this.cancelCue(started.data!.cueId); return { ...transfer, data: { ...(isObject(transfer.data) ? transfer.data : {}), retryWith } }; }
      transferCueId = transfer.data!.cueId;
    }
    return ok({ soloCueId: started.data!.cueId, transferCueId, start: started.data!.normalisedAt, lengthBars: input.lengthBars, eventCount: events.length, openingEventCount: opening.length, stagedEventCount: later.length, nextActions: [{ tool: 'music_get_agent_brief', arguments: { liveSinceSequence: this.liveSequence } }] }, 'Section scheduled atomically.', 'SECTION_SCHEDULED');
  }

  private refreshMetronomeScheduler() {
    if (this.metronomeTimer !== null && typeof window !== 'undefined') window.clearInterval(this.metronomeTimer);
    this.metronomeTimer = null;
    const context = this.engine.context;
    if (!this.projectSettings.metronomeEnabled || !context || typeof window === 'undefined') return;
    let beat = 0;
    const beatLength = 60 / safeTempo(this.projectSettings.tempo);
    let nextBeat = context.currentTime + .05;
    const schedule = () => {
      const now = this.engine.context?.currentTime ?? 0;
      const recovered = skipMissedMetronomeBeats({ beat, nextBeat }, now, beatLength);
      beat = recovered.beat;
      nextBeat = recovered.nextBeat;
      while (nextBeat <= now + .1) { this.engine.metronome(beat % 4 === 0, nextBeat); beat += 1; nextBeat += beatLength; }
    };
    schedule();
    this.metronomeTimer = window.setInterval(schedule, METRONOME_INTERVAL_MS);
  }

  prepareDeck(deck: DeckId, tracks: DeckPreparationTrack[]) {
    if (!this.validateDeck(deck)) return fail('INVALID_DECK', 'Deck must be A or B.');
    const inactiveDeck: DeckId = this.activeDeck === 'A' ? 'B' : 'A';
    if (deck !== inactiveDeck) return fail('ACTIVE_DECK_REQUIRES_CUE', 'music_prepare_deck only changes the silent inactive deck. Use the timed cue tools for the active deck.', { activeDeck: this.activeDeck, recommendedTargetDeck: inactiveDeck, nextActions: [{ tool: 'music_prepare_deck', deck: inactiveDeck }, { tool: 'music_cue_replace_deck_events', deck: this.activeDeck, when: 'next-safe' }] });
    if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > instruments.length) return fail('INVALID_DECK_PREPARATION', 'Provide one to four deck tracks.');
    if (this.transfer?.status === 'active' || (deck === 'A' ? 1 - this.manualCrossfade : this.manualCrossfade) > .001) return fail('DECK_NOT_SILENT', 'The target deck is still audible. Wait until the crossfade reaches the other deck before preparing it.', { crossfadePosition: this.manualCrossfade, nextActions: [{ tool: 'music_get_state', reason: 'Check again after the transfer finishes.' }] });
    if (tracks.some((track) => !isObject(track) || !exactKeys(track, ['instrument', 'mode', 'events', 'profile']) || !Array.isArray(track.events))) return fail('INVALID_DECK_PREPARATION', 'Every track must contain only instrument, mode, events, and an optional profile.');
    const trackNames = tracks.map((track) => track.instrument);
    if (new Set(trackNames).size !== trackNames.length || trackNames.some((instrument) => !isInstrument(instrument))) return fail('INVALID_DECK_PREPARATION', 'Each instrument may appear at most once.');
    const previous = this.decks[deck].snapshot();
    const projected = new SingleDeck();
    projected.restore(previous);
    const prepared = tracks.map((track) => ({ ...clone(track), events: track.events.map((event) => ({ ...event, id: event.id ?? makeAgentEventId(event.type) })) }));
    for (let trackIndex = 0; trackIndex < prepared.length; trackIndex += 1) {
      const track = prepared[trackIndex];
      if ((track.mode !== 'add' && track.mode !== 'replace') || !Array.isArray(track.events) || track.events.length > 256) return fail('INVALID_DECK_PREPARATION', 'Each track needs add or replace mode and at most 256 events.', undefined, [{ path: `tracks[${trackIndex}]`, code: 'INVALID', message: 'Invalid track mode or event count.' }]);
      if (track.profile && !this.validateProfile(track.profile, track.instrument).ok) return fail('INVALID_PROFILE', 'A prepared track profile must be complete and match its instrument.', undefined, [{ path: `tracks[${trackIndex}].profile`, code: 'INVALID', message: 'Invalid sound profile.' }]);
      if (track.mode === 'replace') projected.clearInstrument(track.instrument);
      for (let eventIndex = 0; eventIndex < track.events.length; eventIndex += 1) {
        const event = track.events[eventIndex];
        const validation = this.validateDeckEvent(event, track.instrument);
        if (!validation.ok) return fail('INVALID_DECK_EVENTS', 'A prepared deck event is invalid.', undefined, this.eventIssues(eventIndex, validation, 'Invalid prepared event.').map((issue) => ({ ...issue, path: `tracks[${trackIndex}].${issue.path}` })));
        if (event.id && projected.hasAnyEventId(event.id)) return fail('DUPLICATE_EVENT_ID', `Event ID ${event.id} is already present in the prepared deck.`);
        this.addDeckEventTo(projected, track.instrument, event);
      }
      if (track.profile) projected.setSoundProfile(track.instrument, track.profile);
    }
    this.decks[deck].restore(projected.snapshot());
    prepared.forEach((track) => {
      this.profileTransitions.delete(this.profileKey(deck, track.instrument));
      this.bumpTarget(deck, track.instrument);
      if (track.instrument === 'bass' && track.profile) this.engine.updateBassLaneProfile(laneForDeck(deck), track.profile);
    });
    const cueId = makeCueId();
    const expectedRevisions = Object.fromEntries(instruments.map((instrument) => [instrument, this.targetRevision(deck, instrument)])) as Record<MusicInstrument, number>;
    this.transactions.push({ cueId, inverse: { kind: 'deck-prepare', cueId, deck, previous, expectedRevisions } });
    this.trimHistory(this.transactions);
    this.bump();
    return ok({ operationId: cueId, deck, tracks: prepared.map((track) => ({ instrument: track.instrument, mode: track.mode, eventCount: track.events.length, profile: track.profile?.presetId ?? null })), nextActions: [{ tool: 'music_prepare_deck', reason: 'Add or revise more inactive-deck tracks atomically.' }, { tool: 'music_cue_transfer', reason: 'Transfer only after the deck is ready.', destination: deck, when: 'next-bar' }] }, `Deck ${deck} prepared atomically.`, 'DECK_PREPARED');
  }

  stageSoloEvents(soloId: string, relativeEvents: RelativeSoloEvent[]) {
    const pending = this.pendingCues.find((cue) => (cue.action.type === 'start-solo' || cue.action.type === 'create-solo') && cue.action.soloId === soloId) as (Cue & { action: Extract<CueAction, { type: 'start-solo' | 'create-solo' }> }) | undefined;
    const active = this.solo?.soloId === soloId && this.solo.status === 'active' ? this.solo : null;
    if (!pending && !active) return fail('SOLO_NOT_FOUND', 'No pending or active solo has this ID.', { nextActions: [{ tool: 'music_cue_start_solo', when: 'next-bar' }] });
    if (!Array.isArray(relativeEvents) || relativeEvents.length < 1 || relativeEvents.length > 256) return fail('INVALID_SOLO_EVENTS', 'Provide 1-256 relative solo events.');
    const startAbsoluteTick = pending ? absoluteTickOf(pending.normalisedAt) : active!.startAbsoluteTick;
    const endAbsoluteTick = pending ? startAbsoluteTick + pending.action.lengthBars * BAR_TICKS : active!.endAbsoluteTick;
    const instrument = pending ? pending.action.instrument : active!.instrument;
    const events: SoloEvent[] = [];
    for (let index = 0; index < relativeEvents.length; index += 1) {
      const input = relativeEvents[index];
      if (!isObject(input) || !this.validInteger(input.offsetTicks, 0, CYCLE_TICKS) || input.offsetTicks % EIGHTH_NOTE_TICKS !== 0) return fail('INVALID_SOLO_OFFSET', 'Each offsetTicks value must be a nonnegative eighth-note grid offset.', undefined, [{ path: `events[${index}].offsetTicks`, code: 'INVALID', message: 'Use a multiple of 240 ticks.' }]);
      if (input.offsetTicks < SOLO_OPENING_TICKS) return fail('SOLO_OPENING_LOCKED', 'The first two solo bars are fixed by music_cue_start_solo. Stage later phrases from bar 3 onward.', { minimumOffsetTicks: SOLO_OPENING_TICKS }, [{ path: `events[${index}].offsetTicks`, code: 'OPENING_LOCKED', message: `Use an offset of at least ${SOLO_OPENING_TICKS} ticks.` }]);
      const start = startAbsoluteTick + input.offsetTicks;
      if (start < startAbsoluteTick || start >= endAbsoluteTick) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'A relative solo event starts outside the solo window.', undefined, [{ path: `events[${index}].offsetTicks`, code: 'OUTSIDE_WINDOW', message: 'Offset must land before the solo end.' }]);
      const { offsetTicks: _offsetTicks, ...rest } = input;
      const event = { ...clone(rest), id: input.id ?? makeAgentEventId('solo'), start: musicalTimeOf(start) } as SoloEvent;
      const validation = this.validateSoloEvent(event);
      if (!validation.ok) return fail('INVALID_SOLO_EVENTS', 'A relative solo event is invalid.', undefined, this.eventIssues(index, validation, 'Invalid relative solo event.'));
      if (!this.soloEventMatchesInstrument(event, instrument)) return fail('SOLO_INSTRUMENT_MISMATCH', 'Every staged event must match the solo instrument.', undefined, [{ path: `events[${index}]`, code: 'INSTRUMENT_MISMATCH', message: `Expected ${instrument}.` }]);
      if (event.type !== 'drum' && start + event.durationTicks > endAbsoluteTick) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'A staged note or chord may not cross the solo end.');
      events.push(event);
    }
    const existingIds = new Set(active?.events.map((event) => event.id) ?? (pending?.action.type === 'create-solo' ? pending.action.events.flatMap((event) => event.id ? [event.id] : []) : []));
    if (events.some((event) => event.id && existingIds.has(event.id)) || new Set(events.map((event) => event.id)).size !== events.length) return fail('DUPLICATE_EVENT_ID', 'Staged solo event IDs must be unique.');
    const clock = this.clockSnapshot();
    const minimumLegalAbsolute = Math.ceil((clock.absoluteTick + (this.clockRunning ? LOOKAHEAD_SECONDS * PPQ * clock.tempo / 60 : 0)) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
    const minimumLegalOffsetTicks = Math.max(0, minimumLegalAbsolute - startAbsoluteTick);
    if (events.some((event) => absoluteTickOf(event.start) < minimumLegalAbsolute)) return fail('SOLO_EVENT_TOO_LATE', 'One or more staged events have entered the audio safety window.', { minimumLegalEventTime: musicalTimeOf(minimumLegalAbsolute), minimumLegalOffsetTicks, nextActions: [{ tool: 'music_stage_solo_events', soloId, minimumOffsetTicks: minimumLegalOffsetTicks }] });
    if (pending) {
      const action = pending.action;
      pending.action = action.type === 'start-solo' ? { ...action, type: 'create-solo', events } : { ...action, events: [...action.events, ...events] };
      this.bump();
      return ok({ soloId, cueId: pending.id, state: 'pending', added: events.map((event) => event.id), start: pending.normalisedAt, minimumLegalOffsetTicks: 0, nextActions: [{ tool: 'music_stage_solo_events', reason: 'Add later phrases before they enter the safety window.', soloId }] }, 'Solo events staged before the solo starts.', 'SOLO_EVENTS_STAGED');
    }
    const stored = events.map((event) => this.normaliseSoloEvent(event).data!);
    this.solo = { ...active!, events: [...active!.events, ...stored].sort((left, right) => absoluteTickOf(left.start) - absoluteTickOf(right.start)) };
    this.soloRevision += 1;
    const operationId = makeCueId();
    this.transactions.push({ cueId: operationId, inverse: { kind: 'solo-add', cueId: operationId, soloId, addedIds: stored.map((event) => event.id), expectedRevision: this.soloRevision } });
    this.trimHistory(this.transactions);
    this.scheduleSolo((this.engine.context?.currentTime ?? 0) + LOOKAHEAD_SECONDS);
    this.bump();
    return ok({ soloId, operationId, state: 'active', added: stored.map((event) => event.id), minimumLegalOffsetTicks, nextActions: [{ tool: 'music_stage_solo_events', reason: 'Continue with the next phrase.', soloId, minimumOffsetTicks: minimumLegalOffsetTicks }] }, 'Solo events added to the active solo.', 'SOLO_EVENTS_STAGED');
  }

  private resolveCueTiming(input: MusicalTime | CueTimingInput, actionType: CueAction['type']): MusicResult<CueTimingResolution> {
    const timing = isMusicalTime(input) ? { at: input } : input;
    if (!isObject(timing)) return fail('INVALID_TIMING', 'Provide exactly one of at or when.', undefined, [{ path: 'timing', code: 'REQUIRED', message: 'Exactly one of at or when is required.' }]);
    const keys = Object.keys(timing);
    if (keys.some((key) => key !== 'at' && key !== 'when') || ('at' in timing && 'when' in timing) || !('at' in timing) && !('when' in timing)) return fail('INVALID_TIMING', 'Provide exactly one of at or when.', undefined, [{ path: 'timing', code: 'ONE_OF', message: 'Exactly one of at or when is required.' }]);
    const context = this.engine.context;
    const clock = this.clockSnapshot();
    const earliestSafeAudioTime = context && clock.running ? context.currentTime + LOOKAHEAD_SECONDS : null;
    const ticksPerSecond = PPQ * clock.tempo / 60;
    const earliestSafeAbsolute = context && clock.running ? Math.ceil(this.anchorAbsoluteTick + (earliestSafeAudioTime! - this.anchorAudioTime) * ticksPerSecond) : Math.floor(clock.absoluteTick);
    let boundary: RelativeBoundary | null = null;
    let requestedAt: MusicalTime;
    let rawTarget: number;
    if ('when' in timing) {
      if (timing.when !== 'next-safe' && timing.when !== 'next-eighth' && timing.when !== 'next-beat' && timing.when !== 'next-bar' && timing.when !== 'next-four-bar-boundary') return fail('INVALID_TIMING', 'when must be next-safe, next-eighth, next-beat, next-bar, or next-four-bar-boundary.', undefined, [{ path: 'when', code: 'ENUM', message: 'Unsupported relative boundary.' }]);
      boundary = timing.when;
      requestedAt = musicalTimeOf(Math.floor(clock.absoluteTick));
      rawTarget = nextBoundaryAbsoluteTick(boundary === 'next-safe' ? Math.max(clock.absoluteTick, earliestSafeAbsolute - 1) : clock.absoluteTick, boundary);
    } else {
      if (!isMusicalTime(timing.at)) return fail('INVALID_MUSICAL_TIME', 'at must contain a safe cycle, bar, and tick.', undefined, [{ path: 'at', code: 'INVALID', message: 'cycle, bar, and tick must be safe integers.' }]);
      requestedAt = clone(timing.at);
      rawTarget = absoluteTickOf(timing.at);
    }
    const defaultBarBoundary = ['set-instrument-enabled', 'set-deck-sound-profile', 'transfer-deck', 'start-solo', 'create-solo'].includes(actionType);
    const grid = boundary ? (boundary === 'next-four-bar-boundary' ? DECK_TICKS : boundary === 'next-bar' ? BAR_TICKS : boundary === 'next-beat' ? PPQ : EIGHTH_NOTE_TICKS) : defaultBarBoundary ? BAR_TICKS : EIGHTH_NOTE_TICKS;
    const normalisedAbsolute = Math.ceil(rawTarget / grid) * grid;
    if (normalisedAbsolute > MAX_ABSOLUTE_TICK || earliestSafeAbsolute > MAX_ABSOLUTE_TICK) return fail('CUE_TOO_FAR', 'The cue normalises beyond the supported musical clock range.', { requestedAt, resolvedAt: musicalTimeOf(Math.min(MAX_ABSOLUTE_TICK, Math.max(0, rawTarget))), earliestSafeTime: musicalTimeOf(MAX_ABSOLUTE_TICK), boundary });
    const normalisedAt = musicalTimeOf(normalisedAbsolute);
    const earliestSafeTime = musicalTimeOf(earliestSafeAbsolute);
    if (context && clock.running && this.audioTimeAt(normalisedAbsolute) < earliestSafeAudioTime!) return fail('CUE_TOO_LATE', 'The cue is inside the safe scheduling window and was not executed immediately.', { requestedAt, resolvedAt: normalisedAt, normalisedAt, earliestSafeTime, boundary, suggestedWhen: 'next-safe' });
    return ok({ requestedAt, resolvedAt: normalisedAt, normalisedAt, earliestSafeTime, earliestSafeAudioTime, boundary }, 'Cue timing resolved.');
  }

  queueAction(timingInput: MusicalTime | CueTimingInput, action: CueAction): MusicResult<{ cueId: string; requestedAt: MusicalTime; resolvedAt: MusicalTime; normalisedAt: MusicalTime; earliestSafeTime: MusicalTime; boundary: RelativeBoundary | null; status: Cue['status']; summary: string; nextActions: Array<Record<string, unknown>> }> {
    const validation = this.validateAction(action);
    if (!validation.ok) return fail(validation.code, validation.message, undefined, validation.issues);
    if (!this.engine.context) return fail('AUDIO_NOT_STARTED', 'Start audio before queuing a musical cue.');
    if (!this.clockRunning || !this.transport.isPlaying()) return fail('CLOCK_NOT_RUNNING', 'Start the shared musical transport before queuing a cue.');
    if (this.conflictsWithHumanRecording(action)) return fail('HUMAN_RECORDING_CONFLICT', 'The cue would change the instrument currently being recorded.');
    const timing = this.resolveCueTiming(timingInput, action.type);
    if (!timing.ok) return fail(timing.code, timing.message, timing.data, timing.issues);
    const { requestedAt, resolvedAt, normalisedAt, earliestSafeTime, boundary } = timing.data!;
    const current = this.clockSnapshot().absoluteTick;
    const target = absoluteTickOf(normalisedAt);
    const materialisedAction: CueAction = action.type === 'start-solo'
      ? {
          type: 'create-solo',
          soloId: action.soloId,
          instrument: action.instrument,
          description: action.description,
          lengthBars: action.lengthBars,
          soundProfile: action.soundProfile,
          events: action.initialEvents.map(({ offsetTicks, ...event }) => ({ ...event, start: musicalTimeOf(target + offsetTicks) } as SoloEvent)),
        }
      : action;
    const preparedAction = this.normaliseActionIds(materialisedAction);
    if (this.hasPendingEventIdCollision(preparedAction)) return fail('DUPLICATE_EVENT_ID', 'An event ID is already committed or reserved by another pending cue on this deck.');
    if ((action.type === 'start-solo' || action.type === 'create-solo') && target + action.lengthBars * BAR_TICKS > MAX_ABSOLUTE_TICK) return fail('CUE_TOO_FAR', 'The solo would extend beyond the supported musical clock range.', { requestedAt, resolvedAt, earliestSafeTime });
    if (target - current > MAX_CUE_HORIZON_TICKS) return fail('CUE_TOO_FAR', 'The cue is beyond the supported scheduling horizon.');
    if (action.type === 'add-solo-events') {
      if (this.solo?.soloId === action.soloId && this.solo.status === 'active') {
        const mismatch = action.events.findIndex((event) => !this.soloEventMatchesInstrument(event, this.solo!.instrument));
        if (mismatch >= 0) return fail('SOLO_INSTRUMENT_MISMATCH', 'Every incremental solo event must match the active solo instrument.', undefined, [{ path: `events[${mismatch}]`, code: 'INSTRUMENT_MISMATCH', message: 'The event type or note instrument does not match the active solo instrument.' }]);
        const openingEnd = this.solo.startAbsoluteTick + SOLO_OPENING_TICKS;
        if (action.events.some((event) => absoluteTickOf(quantizeMusicalTime(event.start)) < openingEnd)) return fail('SOLO_OPENING_LOCKED', 'The first two solo bars are fixed by the atomic opening buffer.', { minimumLegalEventTime: musicalTimeOf(openingEnd) });
      }
      const minimumLegalAbsolute = Math.ceil((target + (timing.data?.earliestSafeAudioTime === null ? 0 : LOOKAHEAD_SECONDS * PPQ * this.engine.tempo / 60)) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
      const tooSoon = action.events.some((event) => absoluteTickOf(quantizeMusicalTime(event.start)) < minimumLegalAbsolute);
      if (tooSoon) return fail('SOLO_EVENT_TOO_LATE', 'Incremental solo events must start after the cue execution safety window.', { minimumLegalEventTime: musicalTimeOf(minimumLegalAbsolute), requestedAt, resolvedAt, earliestSafeTime });
    }
    if (preparedAction.type === 'create-solo') {
      const soloEnd = target + preparedAction.lengthBars * BAR_TICKS;
      for (const event of preparedAction.events) {
        const start = absoluteTickOf(quantizeMusicalTime(event.start));
        if (start < target || start >= soloEnd || (event.type !== 'drum' && start + event.durationTicks > soloEnd)) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'Atomic solo events must fit inside the solo window and may start at its boundary.');
      }
      const openingBars = new Set(preparedAction.events.map((event) => Math.floor((absoluteTickOf(quantizeMusicalTime(event.start)) - target) / BAR_TICKS)).filter((bar) => bar >= 0 && bar < SOLO_OPENING_BARS));
      if (openingBars.size < SOLO_OPENING_BARS) return fail('SOLO_OPENING_INCOMPLETE', 'The atomic solo must contain at least one event onset in each of its first two bars.');
    }
    // A later transfer replaces an earlier pending/scheduled transfer. Cancel
    // its timer and AudioParam ramps before accepting the replacement so two
    // crossfades cannot fight over the same deck buses.
    if (action.type === 'transfer-deck') {
      this.pendingCues
        .filter((cue) => cue.action.type === 'transfer-deck')
        .forEach((cue) => this.cancelCueInternal(cue, 'Replaced by a newer transfer cue.', 'replacement'));
      this.clearTransferTimer();
    }
    const cue: Cue = { id: makeCueId(), at: normalisedAt, action: clone(preparedAction), status: 'pending', requestedAt: clone(requestedAt), resolvedAt: clone(resolvedAt), normalisedAt: clone(normalisedAt) };
    this.captureTargetRevision(cue);
    this.pendingCues.push(cue);
    this.startCuePump();
    this.bump();
    const nextActions = action.type === 'start-solo' || action.type === 'create-solo'
      ? [{ tool: 'music_stage_solo_events', reason: 'The first two bars are already safe. Add later phrases from bar 3 onward without pausing to narrate or reread state.', soloId: action.soloId, minimumOffsetTicks: SOLO_OPENING_TICKS }]
      : action.type === 'transfer-deck' ? [{ tool: 'music_get_state', reason: 'Confirm the transfer and choose the newly inactive deck for the next build.' }] : [];
    return ok({ cueId: cue.id, requestedAt: clone(requestedAt), resolvedAt: clone(resolvedAt), normalisedAt: clone(normalisedAt), earliestSafeTime: clone(earliestSafeTime), boundary, status: cue.status, summary: this.actionSummary(action), nextActions }, 'Cue accepted.', 'CUE_ACCEPTED');
  }

  executeCueNow(cueIdValue: string, scheduledAudioAt?: number): MusicResult<unknown> {
    const cue = this.pendingCues.find((candidate) => candidate.id === cueIdValue);
    if (!cue) return fail('CUE_NOT_FOUND', `Cue ${cueIdValue} is not pending or scheduled.`);
    if (!this.clockRunning || !this.transport.isPlaying()) return fail('CLOCK_NOT_RUNNING', 'The shared musical clock is stopped; the cue remains pending.');
    if (this.conflictsWithHumanRecording(cue.action)) return this.failCue(cue, 'HUMAN_RECORDING_CONFLICT', 'The cue would change the instrument currently being recorded.');
    const stale = this.staleCue(cue);
    if (stale) return this.failCue(cue, 'STALE_TARGET', 'The cue was accepted before a human changed its target.');
    const audioAt = scheduledAudioAt ?? this.audioTimeAt(absoluteTickOf(cue.normalisedAt));
    try {
      const audioWasScheduled = this.preScheduledAudio.has(cue.id);
      const applied = this.applyAction(cue.action, cue, audioAt, audioWasScheduled);
      if (!('result' in applied)) return this.failCue(cue, applied.code, applied.message);
      this.preScheduledAudio.delete(cue.id);
      cue.status = 'executed';
      this.pendingCues = this.pendingCues.filter((candidate) => candidate !== cue);
      this.executedCues.push(clone(cue));
      this.trimHistory(this.executedCues);
      this.transactions.push({ cueId: cue.id, inverse: applied.inverse });
      this.trimHistory(this.transactions);
      this.bump();
      return applied.result;
    } catch (error) { return this.failCue(cue, 'CUE_EXECUTION_FAILED', error instanceof Error ? error.message : 'Cue execution failed.'); }
  }

  cancelCue(id: string): MusicResult<{ cueId: string; cancelled: boolean; cancelledReason: string; cancelledBy: 'agent' }> {
    const cue = this.pendingCues.find((candidate) => candidate.id === id);
    if (!cue) return fail('CUE_NOT_FOUND', `Cue ${id} is not pending or scheduled.`);
    const cancelledReason = 'Cancelled by agent.';
    this.cancelCueInternal(cue, cancelledReason, 'agent');
    this.bump();
    return ok({ cueId: id, cancelled: true, cancelledReason, cancelledBy: 'agent' }, `Cue ${id} cancelled.`, 'CUE_CANCELLED');
  }
  private cancelCueInternal(cue: Cue, cancelledReason = 'Cancelled by agent.', cancelledBy: Cue['cancelledBy'] = 'agent') {
    cue.status = 'cancelled';
    cue.cancelledReason = cancelledReason;
    cue.cancelledBy = cancelledBy;
    const timer = this.cueTimers.get(cue.id);
    if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
    this.cueTimers.delete(cue.id);
    this.cancelPreScheduledAudio(cue.id);
    this.pendingCues = this.pendingCues.filter((candidate) => candidate !== cue);
    this.executedCues.push(clone(cue));
    this.trimHistory(this.executedCues);
  }
  private cancelPreScheduledAudio(cueId: string) {
    const scheduled = this.preScheduledAudio.get(cueId);
    const now = this.engine.context?.currentTime;
    if (!scheduled || now === undefined) { this.preScheduledAudio.delete(cueId); return; }
    this.preScheduledAudio.delete(cueId);
    if (scheduled.kind === 'instrument') {
      this.engine.cancelInstrumentAutomation(scheduled.instrument, now);
      this.engine.setInstrumentEnabled(scheduled.instrument, this.enabled[scheduled.instrument], now);
    } else if (scheduled.kind === 'transfer') {
      this.engine.cancelLaneGainAutomation('deckA', now);
      this.engine.cancelLaneGainAutomation('deckB', now);
      this.engine.setLaneGainRamp('deckA', this.activeDeck === 'A' ? 1 : 0, now, .012);
      this.engine.setLaneGainRamp('deckB', this.activeDeck === 'B' ? 1 : 0, now, .012);
    } else {
      scheduled.eventIds.forEach((id) => this.soloPlayed.delete(id));
      this.engine.stopLaneVoices('solo');
    }
    // The AudioParam cancellation is broad by design. Re-install any other
    // future cue that shared the same parameter so cancelling one cue cannot
    // erase a later accepted cue.
    [...this.preScheduledAudio.values()]
      .filter((candidate) => candidate.at > now + .000001)
      .sort((left, right) => left.at - right.at)
      .forEach((candidate) => {
        if (candidate.kind === 'instrument') this.engine.setInstrumentEnabled(candidate.instrument, candidate.enabled, candidate.at, false);
        else if (candidate.kind === 'transfer' && candidate.from !== candidate.destination) this.scheduleTransferGains(candidate.from, candidate.destination, candidate.style, candidate.at, candidate.duration);
      });
  }

  undoLastAgentAction(): MusicResult<{ cueId: string; audioReversal: string }> {
    const transaction = this.transactions.pop();
    if (!transaction) return fail('NOTHING_TO_UNDO', 'There is no executed agent action to undo.');
    const result = this.applyInverse(transaction.inverse);
    if (!result.ok) { this.transactions.push(transaction); return fail<{ cueId: string; audioReversal: string }>(result.code, result.message); }
    const executed = this.executedCues.find((cue) => cue.id === transaction.cueId);
    if (executed) executed.undone = true;
    this.bump();
    return ok({ cueId: transaction.cueId, audioReversal: 'Logical state was reversed; audio already rendered cannot be erased.' }, 'The latest agent action was undone.', 'UNDO_APPLIED');
  }

  humanCancelTransfer() {
    this.clearTransferTimer();
    this.transfer = null;
    this.transferRevision += 1;
    this.manualCrossfade = this.activeDeck === 'A' ? 0 : 1;
    const now = this.engine.context?.currentTime;
    if (now !== undefined) {
      this.engine.cancelLaneGainAutomation('deckA', now);
      this.engine.cancelLaneGainAutomation('deckB', now);
      this.engine.setLaneGainRamp('deckA', this.activeDeck === 'A' ? 1 : 0, now, .012);
      this.engine.setLaneGainRamp('deckB', this.activeDeck === 'B' ? 1 : 0, now, .012);
    }
    this.pendingCues.filter((cue) => cue.action.type === 'transfer-deck').forEach((cue) => this.cancelCueInternal(cue, 'Cancelled by human transfer override.', 'human'));
    this.bump();
  }

  debugPlayTone(input: { frequencyHz: number; durationMs: number; waveform?: OscillatorType; gain?: number; attackMs?: number; releaseMs?: number; delayMs?: number }) {
    const result = this.engine.debugTone(input.frequencyHz, input.durationMs, input.waveform ?? 'sine', input.gain ?? .08, input.attackMs ?? 5, input.releaseMs ?? 30, input.delayMs ?? 0);
    return result ? ok({ ...input, waveform: input.waveform ?? 'sine', gain: input.gain ?? .08, attackMs: input.attackMs ?? 5, releaseMs: input.releaseMs ?? 30, delayMs: input.delayMs ?? 0, ...result }, 'Debug tone scheduled.', 'DEBUG_TONE_SCHEDULED') : fail('AUDIO_NOT_STARTED', 'Start audio before using a debug tone.');
  }
  debugPlayInstrumentFrequency(input: { instrument: 'bass' | 'lead'; frequencyHz: number; durationMs: number; velocity?: number; lane?: VoiceLane; profileSource?: 'live' | 'deckA' | 'deckB' | 'activeSolo' }) {
    const profile = this.debugProfile(input.instrument, input.profileSource ?? 'live');
    if (!profile) return fail('PROFILE_NOT_FOUND', 'The requested debug profile does not exist.');
    const lane = input.lane ?? 'live'; const velocity = input.velocity ?? 1; const at = (this.engine.context?.currentTime ?? 0) + .0059;
    if (input.instrument === 'bass') this.engine.updateBassLaneProfile(lane, profile, at);
    const voices = this.engine.debugNote(input.instrument, fractionalMidiOf(input.frequencyHz), input.durationMs / 1000, at, profile, lane, velocity);
    return voices.length ? ok({ ...input, velocity, lane, profileSource: input.profileSource ?? 'live', midi: fractionalMidiOf(input.frequencyHz), scheduledAt: at, expectedGateEnd: at + input.durationMs / 1000, expectedEnd: at + input.durationMs / 1000 + (profile.parameters.releaseMs ?? 0) / 1000 }, 'Debug instrument tone scheduled.', 'DEBUG_INSTRUMENT_SCHEDULED') : fail('AUDIO_NOT_STARTED', 'Start audio before using a debug instrument tone.');
  }
  debugPlayDrum(input: { pad: number; velocity?: number; lane?: VoiceLane; profileSource?: 'live' | 'deckA' | 'deckB' | 'activeSolo'; delayMs?: number }) {
    if (!this.engine.context) return fail('AUDIO_NOT_STARTED', 'Start audio before using a debug drum.');
    const profile = this.debugProfile('drums', input.profileSource ?? 'live');
    if (!profile) return fail('PROFILE_NOT_FOUND', 'The requested debug profile does not exist.');
    const lane = input.lane ?? 'live'; const at = this.engine.context.currentTime + .0059 + (input.delayMs ?? 0) / 1000; const velocity = input.velocity ?? 1;
    this.engine.debugDrum(input.pad, at, profile, lane, velocity);
    return ok({ ...input, velocity, lane, profileSource: input.profileSource ?? 'live', scheduledAt: at }, 'Debug drum hit scheduled.', 'DEBUG_DRUM_SCHEDULED');
  }
  debugStopAll(scope: 'debug' | 'all' = 'debug') { if (scope === 'all') this.engine.panic(); else this.engine.stopDebugVoices(); return ok({ scope }, scope === 'all' ? 'All sounding voices were stopped.' : 'Temporary debug voices were stopped.', 'DEBUG_STOPPED'); }
  async debugStartAudio() { const started = await this.startAudio(); return started.ok ? ok(started.data, 'Audio started for debugging.', 'DEBUG_AUDIO_STARTED') : started; }
  debugHoldInstrumentFrequency(input: { id: string; instrument: 'bass' | 'lead'; frequencyHz: number }) { if (!this.engine.context) return fail('AUDIO_NOT_STARTED', 'Start audio before holding a debug note.'); const profile = this.debugProfile(input.instrument, 'live'); if (!profile) return fail('PROFILE_NOT_FOUND', 'The live debug profile does not exist.'); if (input.instrument === 'bass') this.engine.updateBassLaneProfile('debug', profile); this.engine.holdDebugNote(input.id, input.instrument, fractionalMidiOf(input.frequencyHz)); return ok({ ...input, midi: fractionalMidiOf(input.frequencyHz), lane: 'debug' }, 'Debug note held.', 'DEBUG_NOTE_HELD'); }
  debugReleaseHeldNote(id: string) { if (!this.engine.context) return fail('AUDIO_NOT_STARTED', 'Start audio before releasing a debug note.'); if (!this.engine.hasHeldNote(id)) return fail('NOTE_NOT_FOUND', `Held debug note ${id} was not found.`); this.engine.releaseNote(id); return ok({ id }, 'Debug note released.', 'DEBUG_NOTE_RELEASED'); }
  debugRunHeldRetriggerProbe(input: HeldRetriggerProbeInput) {
    const context = this.engine.context;
    if (!context) return fail('AUDIO_NOT_STARTED', 'Start audio before running a held retrigger probe.');
    if (input.firstId === input.secondId) return fail('INVALID_INPUT', 'firstId and secondId must be different.');
    if (input.retriggerGapMs < 0 && input.firstHoldMs < Math.abs(input.retriggerGapMs)) return fail('INVALID_INPUT', 'Negative overlap cannot begin before the first hold.');
    const probeId = `held-retrigger-${nextProbeId++}`;
    const anchor = context.currentTime + .03;
    const plan = planHeldRetriggerProbe(input, anchor);
    const { operations, captureWindow } = plan;
    const leadMs = input.captureLeadMs ?? 25;
    const tailMs = input.captureTailMs ?? 75;
    const probe: HeldRetriggerProbe = { probeId, status: 'scheduled', requested: clone(input), audioAnchor: anchor, operations, captureWindow, capture: { leadMs, tailMs, maxSamples: input.maxSamples, bandIndices: input.bandIndices, minFrequencyHz: input.minFrequencyHz, maxFrequencyHz: input.maxFrequencyHz } };
    if (this.heldRetriggerProbes.size >= 16) { const oldest = this.heldRetriggerProbes.keys().next().value as string | undefined; if (oldest) this.heldRetriggerProbes.delete(oldest); }
    this.heldRetriggerProbes.set(probeId, probe);
    const timers: number[] = [];
    this.heldRetriggerTimers.set(probeId, timers);
    const setTimer = (callback: () => void, delay: number) => { const timer = typeof window !== 'undefined' ? window.setTimeout(callback, delay) : setTimeout(callback, delay) as unknown as number; timers.push(timer); return timer; };
    const clearTimer = (timer: number) => { if (typeof window !== 'undefined') window.clearTimeout(timer); else clearTimeout(timer as unknown as ReturnType<typeof setTimeout>); };
    const failProbe = (operation: HeldRetriggerOperation, error: unknown) => {
      const current = this.heldRetriggerProbes.get(probeId);
      if (!current) return;
      const message = error instanceof Error ? error.message : 'A live retrigger operation failed.';
      operation.result = { ok: false, code: 'PROBE_OPERATION_FAILED', message };
      current.status = 'failed';
      current.failure = message;
      timers.forEach(clearTimer);
      this.heldRetriggerTimers.delete(probeId);
      [input.firstId, input.secondId].forEach((id) => {
        try { if (this.engine.hasHeldNote(id)) this.engine.releaseNote(id); } catch { /* cleanup must continue for the other held ID */ }
      });
    };
    const snapshot = () => ({ firstHeld: this.engine.hasHeldNote(input.firstId), secondHeld: this.engine.hasHeldNote(input.secondId), voiceStats: this.engine.getVoiceStats(), bassReleaseDiagnostics: this.engine.getBassReleaseDiagnostics().slice(-4) });
    const dispatch = (index: number) => {
      const current = this.heldRetriggerProbes.get(probeId);
      if (!current || current.status === 'cancelled' || current.status === 'failed') return;
      if (index >= current.operations.length) {
        const finish = () => { const completed = this.heldRetriggerProbes.get(probeId); if (!completed || completed.status === 'cancelled') return; const drift = completed.operations.map((operation) => Math.abs(operation.driftMs ?? 0)); completed.status = drift.some((value) => value > 8) ? 'degraded-timing' : 'complete'; this.heldRetriggerTimers.delete(probeId); };
        const now = context.currentTime;
        const delay = Math.max(0, (current.captureWindow.end - now) * 1000);
        setTimer(() => { if (context.currentTime + .0002 < current.captureWindow.end) dispatch(index); else finish(); }, Math.min(4, delay));
        return;
      }
      const operation = current.operations[index];
      const now = context.currentTime;
      if (now + .0002 < operation.intendedAudioTime) { setTimer(() => dispatch(index), Math.min(4, Math.max(0, (operation.intendedAudioTime - now) * 1000))); return; }
      operation.observedAudioTime = context.currentTime;
      operation.driftMs = (operation.observedAudioTime - operation.intendedAudioTime) * 1000;
      try {
        operation.before = snapshot();
        operation.result = operation.action === 'hold'
          ? { id: operation.id, voiceCount: this.engine.holdNote(operation.id, 'bass', fractionalMidiOf(operation.id === input.firstId ? input.firstFrequencyHz : input.secondFrequencyHz)).length }
          : this.engine.releaseNote(operation.id);
        operation.after = snapshot();
        dispatch(index + 1);
      } catch (error) {
        failProbe(operation, error);
      }
    };
    dispatch(0);
    return ok({ probeId, status: probe.status, requested: clone(input), audioAnchor: anchor, operations: clone(operations), captureWindow: probe.captureWindow }, 'Held live retrigger probe scheduled.', 'DEBUG_HELD_RETRIGGER_SCHEDULED');
  }
  debugGetHeldRetriggerProbe(probeId: string) {
    const probe = this.heldRetriggerProbes.get(probeId);
    if (!probe) return fail('PROBE_NOT_FOUND', `Held retrigger probe ${probeId} was not found.`);
    const fullBands = this.histogram.snapshot(10, false).bandsHz;
    const requestedBands = probe.capture.bandIndices?.length
      ? probe.capture.bandIndices
      : fullBands.map((band, index) => band[1] >= (probe.capture.minFrequencyHz ?? 20) && band[0] <= (probe.capture.maxFrequencyHz ?? 20000) ? index : -1).filter((index) => index >= 0);
    const summaryBandIndices = fullBands.map((band, index) => band[1] >= 5000 && band[0] <= 8000 ? index : -1).filter((index) => index >= 0);
    const selectedBandIndices = [...new Set([...requestedBands, ...summaryBandIndices])].sort((left, right) => left - right);
    const rawHistogram = this.histogram.snapshot(10, true, { bandIndices: selectedBandIndices });
    const capturedSamples = rawHistogram.samples.filter((sample) => sample.audioTimeSeconds !== null && sample.audioTimeSeconds >= probe.captureWindow.start && sample.audioTimeSeconds <= probe.captureWindow.end);
    const maxSamples = probe.capture.maxSamples;
    const sampleIndexes = maxSamples !== undefined && capturedSamples.length > maxSamples
      ? Array.from({ length: maxSamples }, (_, index) => Math.round(index * (capturedSamples.length - 1) / Math.max(1, maxSamples - 1)))
      : capturedSamples.map((_, index) => index);
    const samples = sampleIndexes.map((index) => capturedSamples[index]);
    const histogram = {
      ...rawHistogram,
      samples,
      requestedTimeSpanSeconds: Number(((probe.captureWindow.end - probe.captureWindow.start)).toFixed(3)),
      returnedTimeSpanSeconds: samples.length > 1 ? Number(((samples[samples.length - 1].timestampMs - samples[0].timestampMs) / 1000).toFixed(3)) : 0,
      omitted: { ...rawHistogram.omitted, samples: rawHistogram.omitted.samples + rawHistogram.samples.length - capturedSamples.length + capturedSamples.length - samples.length, decimated: rawHistogram.omitted.decimated || samples.length < capturedSamples.length },
    };
    const summaryLocalIndices = summaryBandIndices.map((index) => selectedBandIndices.indexOf(index)).filter((index) => index >= 0);
    // Find the transient from every sample inside the requested audio window.
    // maxSamples only limits the returned payload and must not hide a peak.
    const values = capturedSamples.flatMap((sample) => summaryLocalIndices.map((index) => sample.levelsDb[index] ?? -100));
    const peakDb = values.length ? Math.max(...values) : -100;
    const peakSample = capturedSamples.find((sample) => summaryLocalIndices.some((index) => (sample.levelsDb[index] ?? -100) === peakDb));
    const peakIndex = peakSample ? capturedSamples.indexOf(peakSample) : -1;
    return ok({ ...clone(probe), operations: clone(probe.operations), histogram, summary5to8kHz: { peakDb, peakAudioTime: peakSample?.audioTimeSeconds ?? null, bandRangeHz: [5000, 8000], selectedBands: summaryBandIndices.map((index) => fullBands[index]), nearbySamples: peakIndex >= 0 ? capturedSamples.slice(Math.max(0, peakIndex - 2), peakIndex + 3) : [] }, synth: this.engine.getSynthSnapshot(), music: this.getState() }, 'Held retrigger probe returned.', 'DEBUG_HELD_RETRIGGER_PROBE');
  }
  debugClearHistogram() { this.histogram.clear(); return ok({ sampleCount: this.histogram.sampleCount() }, 'Frequency history cleared.', 'DEBUG_HISTOGRAM_CLEARED'); }
  debugExportSnapshot() { return ok(this.buildSnapshot(), 'Debug snapshot captured.', 'DEBUG_SNAPSHOT'); }
  debugRunReleaseProbe(input: { instrument: 'bass' | 'lead'; frequencyHz: number; holdMs: number; releaseMs: number; velocity: number; repetitions: number; gapMs: number }) {
    const ctx = this.engine.context; if (!ctx) return fail('AUDIO_NOT_STARTED', 'Start audio before running a release probe.');
    const probeId = `probe-${nextProbeId++}`; const start = ctx.currentTime + .02; const profile = this.debugProfile(input.instrument, 'live');
    if (!profile) return fail('PROFILE_NOT_FOUND', 'The live debug profile does not exist.');
    const probeProfile = { ...profile, parameters: { ...profile.parameters, releaseMs: input.releaseMs } };
    if (input.instrument === 'bass') this.engine.updateBassLaneProfile('live', probeProfile, start);
    const events = Array.from({ length: input.repetitions }, (_, index) => { const at = start + index * (input.holdMs + input.releaseMs + input.gapMs) / 1000; this.engine.debugNote(input.instrument, fractionalMidiOf(input.frequencyHz), input.holdMs / 1000, at, probeProfile, 'live', input.velocity); return { at, releaseAt: at + input.holdMs / 1000, releaseEnd: at + (input.holdMs + input.releaseMs) / 1000, frequencyHz: input.frequencyHz, durationMs: input.holdMs }; });
    const probe: ReleaseProbe = { probeId, instrument: input.instrument, events, capture: { status: 'not-implemented', reason: 'The MVP does not yet tap raw sample-aligned VCA output.' } }; if (this.releaseProbes.size >= 32) { const oldest = this.releaseProbes.keys().next().value as string | undefined; if (oldest) this.releaseProbes.delete(oldest); } this.releaseProbes.set(probeId, probe); return ok(probe, 'Release probe scheduled. Raw sample capture is not implemented.', 'DEBUG_PROBE_SCHEDULED');
  }
  debugGetReleaseProbe(probeId: string) { const probe = this.releaseProbes.get(probeId); return probe ? ok(clone(probe), 'Release probe returned.', 'DEBUG_PROBE') : fail('PROBE_NOT_FOUND', `Probe ${probeId} was not found.`); }

  dispose() {
    if (this.disposed) return; this.disposed = true; this.transport.stop(); this.histogram.stop(); this.clearHumanHeldSilently();
    if (this.metronomeTimer !== null && typeof window !== 'undefined') window.clearInterval(this.metronomeTimer); this.metronomeTimer = null;
    if (this.cueTimer !== null && typeof window !== 'undefined') window.clearInterval(this.cueTimer); this.cueTimer = null;
    this.cueTimers.forEach((timer) => { if (typeof window !== 'undefined') window.clearTimeout(timer); }); this.cueTimers.clear(); [...this.preScheduledAudio.keys()].forEach((cueId) => this.cancelPreScheduledAudio(cueId)); this.heldRetriggerTimers.forEach((timers, probeId) => { timers.forEach((timer) => { if (typeof window !== 'undefined') window.clearTimeout(timer); else clearTimeout(timer as unknown as ReturnType<typeof setTimeout>); }); const probe = this.heldRetriggerProbes.get(probeId); if (probe) { probe.status = 'cancelled'; probe.failure = 'Controller disposed during probe.'; } }); this.heldRetriggerTimers.clear(); this.heldRetriggerProbes.forEach((probe) => [probe.requested.firstId, probe.requested.secondId].forEach((id) => { if (typeof id === 'string' && this.engine.hasHeldNote(id)) this.engine.releaseNote(id); })); this.clearTransferTimer(); this.listeners.clear(); this.engine.dispose();
  }

  private captureTargetRevision(cue: Cue) { const action = cue.action; if (action.type === 'remove-deck-events' || action.type === 'replace-deck-events' || action.type === 'set-deck-sound-profile' || (action.type === 'add-deck-events' && action.instrument === 'bass')) cue.targetRevision = { deck: action.deck, instrument: action.instrument, revision: this.targetRevision(action.deck, action.instrument), humanRevision: this.humanTargetRevision(action.deck, action.instrument) }; }
  private staleCue(cue: Cue) { if (!cue.targetRevision?.deck || !cue.targetRevision.instrument) return false; return cue.targetRevision.humanRevision !== undefined && this.humanTargetRevision(cue.targetRevision.deck, cue.targetRevision.instrument) !== cue.targetRevision.humanRevision; }
  private failCue(cue: Cue, code: string, message: string): MusicResult<never> { this.cancelPreScheduledAudio(cue.id); cue.status = 'failed'; cue.error = { code, message }; this.pendingCues = this.pendingCues.filter((candidate) => candidate !== cue); this.executedCues.push(clone(cue)); this.trimHistory(this.executedCues); this.bump(); return fail(code, message); }
  private pauseScheduledCues() {
    this.pendingCues.filter((cue) => cue.status === 'scheduled').forEach((cue) => {
      const scheduled = this.preScheduledAudio.get(cue.id);
      if (scheduled) this.cancelPreScheduledAudio(cue.id);
      cue.status = 'pending';
      const timer = this.cueTimers.get(cue.id);
      if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
      this.cueTimers.delete(cue.id);
    });
  }
  private startCuePump() { if (this.cueTimer === null && typeof window !== 'undefined') this.cueTimer = window.setInterval(() => this.pump(), CUE_INTERVAL_MS); }
  private pump() {
    if (!this.clockRunning || !this.transport.isPlaying()) return;
    const now = this.engine.context?.currentTime; if (now === undefined) return;
    this.pendingCues.filter((cue) => cue.status === 'pending').forEach((cue) => { const at = this.audioTimeAt(absoluteTickOf(cue.normalisedAt)); if (at <= now + LOOKAHEAD_SECONDS && at >= now - .02) { try { this.scheduleCueAudio(cue, at); cue.status = 'scheduled'; const timer = window.setTimeout(() => { this.cueTimers.delete(cue.id); this.executeCueNow(cue.id, at); }, Math.max(0, (at - now) * 1000)); this.cueTimers.set(cue.id, timer); this.bump(); } catch (error) { this.failCue(cue, 'CUE_AUDIO_SCHEDULING_FAILED', error instanceof Error ? error.message : 'Cue audio could not be scheduled.'); } } });
    if (this.solo?.status === 'active') this.scheduleSolo(now + LOOKAHEAD_SECONDS);
    if (this.solo?.status === 'active' && now >= this.audioTimeAt(this.solo.endAbsoluteTick)) { this.engine.stopLaneVoices('solo'); this.solo = { ...this.solo, status: 'ended' }; this.soloRevision += 1; this.bump(); }
  }
  private scheduleSolo(until: number) {
    if (!this.solo || !this.clockRunning) return;
    const current = this.engine.context?.currentTime ?? 0;
    this.solo.events.forEach((event) => {
      if (this.soloPlayed.has(event.id)) return;
      const absolute = absoluteTickOf(event.start);
      const at = this.audioTimeAt(absolute);
      if (at > until || at < current - .02) return;
      if (event.type === 'drum') this.engine.drum(event.pad, at, this.solo!.soundProfile, false, 'solo', event.velocity);
      else if (event.type === 'chord') this.engine.chord(event.pitches, playbackDurationSeconds(event.durationTicks, event.articulation, this.engine.tempo), at, this.solo!.soundProfile, false, 'solo', event.velocity ?? 1);
      else {
        const instrument = this.solo!.instrument === 'bass' ? 'bass' : 'lead';
        if (instrument === 'bass') this.engine.updateBassLaneProfile('solo', this.solo!.soundProfile, at);
        this.engine.note(instrument, event.pitch, playbackDurationSeconds(event.durationTicks, event.articulation, this.engine.tempo), at, this.solo!.soundProfile, false, 'solo', event.velocity);
      }
      this.soloPlayed.add(event.id);
    });
  }

  private validateTime(value: MusicalTime): MusicResult<true> { return isMusicalTime(value) ? ok(true, 'Valid musical time.') : fail('INVALID_MUSICAL_TIME', `cycle must be 0-${MAX_MUSICAL_CYCLE}, bar 0-23, and tick 0-1919.`); }
  private validateAction(action: CueAction): MusicResult<true> {
    if (!isObject(action) || typeof action.type !== 'string') return fail('INVALID_ACTION', 'Cue action must be an object with a supported type.');
    if (action.type === 'set-instrument-enabled') return exactKeys(action, ['type', 'instrument', 'enabled']) && isInstrument(action.instrument) && typeof action.enabled === 'boolean' ? ok(true, 'Valid action.') : fail('INVALID_INSTRUMENT_STATE', 'Instrument and enabled state are required.');
    if (action.type === 'set-deck-sound-profile') { if (!exactKeys(action, ['type', 'deck', 'instrument', 'profile', 'transitionTicks']) || !this.validateDeck(action.deck) || !isInstrument(action.instrument) || !this.validateProfile(action.profile, action.instrument).ok || (action.transitionTicks !== undefined && !this.validInteger(action.transitionTicks, 0, CYCLE_TICKS))) return fail('INVALID_PROFILE', 'Deck, instrument, profile, or transition length is invalid.'); return ok(true, 'Valid action.'); }
    if (action.type === 'transfer-deck') return exactKeys(action, ['type', 'destination', 'style', 'durationTicks']) && this.validateDeck(action.destination) && (action.style === 'cut' || action.style === 'blend' || action.style === 'dip' || action.style === 'overlap') && this.validInteger(action.durationTicks, 0, CYCLE_TICKS) ? ok(true, 'Valid action.') : fail('INVALID_TRANSFER', 'Transfer destination, style, and integer duration are required.');
    if (action.type === 'start-solo') {
      if (!exactKeys(action, ['type', 'soloId', 'instrument', 'description', 'lengthBars', 'soundProfile', 'initialEvents']) || !stringId(action.soloId) || !isInstrument(action.instrument) || typeof action.description !== 'string' || action.description.length < 1 || action.description.length > 240 || !this.validInteger(action.lengthBars, SOLO_OPENING_BARS, CYCLE_BARS) || !this.validateProfile(action.soundProfile, action.instrument).ok || !Array.isArray(action.initialEvents) || action.initialEvents.length < SOLO_OPENING_BARS || action.initialEvents.length > 256) return fail('INVALID_SOLO', 'Solo details, profile, and a two-bar opening buffer are required.');
      const ids = new Set<string>();
      const coveredBars = new Set<number>();
      for (let index = 0; index < action.initialEvents.length; index += 1) {
        const input = action.initialEvents[index];
        if (!isObject(input) || !this.validInteger(input.offsetTicks, 0, SOLO_OPENING_TICKS - EIGHTH_NOTE_TICKS) || input.offsetTicks % EIGHTH_NOTE_TICKS !== 0) return fail('INVALID_SOLO_OPENING', 'Opening events must start on the eighth-note grid inside the first two bars.', undefined, [{ path: `initialEvents[${index}].offsetTicks`, code: 'OUTSIDE_OPENING', message: `Use a grid offset from 0 through ${SOLO_OPENING_TICKS - EIGHTH_NOTE_TICKS}.` }]);
        const { offsetTicks, ...relativeEvent } = input;
        const event = { ...relativeEvent, start: musicalTimeOf(offsetTicks) } as SoloEvent;
        const eventValidation = this.validateSoloEvent(event);
        if (!eventValidation.ok) return fail('INVALID_SOLO_OPENING', 'An opening event is invalid.', undefined, this.eventIssues(index, eventValidation, 'Invalid opening event.').map((issue) => ({ ...issue, path: issue.path.replace(/^events/, 'initialEvents') })));
        if (!this.soloEventMatchesInstrument(event, action.instrument)) return fail('SOLO_INSTRUMENT_MISMATCH', 'Every opening event must match the solo instrument.', undefined, [{ path: `initialEvents[${index}]`, code: 'INSTRUMENT_MISMATCH', message: `Expected ${action.instrument}.` }]);
        if (event.type !== 'drum' && offsetTicks + event.durationTicks > action.lengthBars * BAR_TICKS) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'An opening note or chord may not cross the solo end.');
        if (event.id && ids.has(event.id)) return fail('DUPLICATE_EVENT_ID', 'Opening event IDs must be unique.');
        if (event.id) ids.add(event.id);
        coveredBars.add(Math.floor(offsetTicks / BAR_TICKS));
      }
      return coveredBars.size === SOLO_OPENING_BARS ? ok(true, 'Valid action.') : fail('SOLO_OPENING_INCOMPLETE', 'The opening buffer must contain at least one event onset in each of the first two bars.');
    }
    if (action.type === 'create-solo') {
      if (!exactKeys(action, ['type', 'soloId', 'instrument', 'description', 'lengthBars', 'soundProfile', 'events']) || !stringId(action.soloId) || !isInstrument(action.instrument) || typeof action.description !== 'string' || action.description.length < 1 || action.description.length > 240 || !this.validInteger(action.lengthBars, SOLO_OPENING_BARS, CYCLE_BARS) || !this.validateProfile(action.soundProfile, action.instrument).ok || !Array.isArray(action.events) || action.events.length < SOLO_OPENING_BARS || action.events.length > 256) return fail('INVALID_SOLO', 'Atomic solo details, profile, and a two-bar opening buffer are required.');
      const invalidEvent = action.events.findIndex((event) => !this.validateSoloEvent(event).ok);
      if (invalidEvent >= 0) {
        const validation = this.validateSoloEvent(action.events[invalidEvent]);
        return fail('INVALID_SOLO_EVENTS', 'Atomic solo events failed exact-shape validation.', undefined, this.eventIssues(invalidEvent, validation, 'Every solo event must use one exact discriminated shape.'));
      }
      const mismatchedEvent = action.events.findIndex((event) => !this.soloEventMatchesInstrument(event, action.instrument));
      if (mismatchedEvent >= 0) return fail('SOLO_INSTRUMENT_MISMATCH', 'Every atomic solo event must match the solo instrument.', undefined, [{ path: `events[${mismatchedEvent}]`, code: 'INSTRUMENT_MISMATCH', message: 'The event type or note instrument does not match the solo instrument.' }]);
      const ids = action.events.flatMap((event) => event.id ? [event.id] : []);
      return new Set(ids).size === ids.length ? ok(true, 'Valid action.') : fail('DUPLICATE_EVENT_ID', 'Solo event IDs must be unique.');
    }
    if (action.type === 'end-solo-early') return exactKeys(action, ['type', 'soloId']) && stringId(action.soloId) ? ok(true, 'Valid action.') : fail('INVALID_SOLO_ID', 'soloId is required.');
    if (action.type === 'add-solo-events') {
      if (!exactKeys(action, ['type', 'soloId', 'events']) || !stringId(action.soloId) || !Array.isArray(action.events) || action.events.length < 1 || action.events.length > 256) return fail('INVALID_SOLO_EVENTS', 'soloId and 1-256 exact-shape events are required.');
      const invalidEvent = action.events.findIndex((event) => !this.validateSoloEvent(event).ok);
      if (invalidEvent >= 0) {
        const validation = this.validateSoloEvent(action.events[invalidEvent]);
        return fail('INVALID_SOLO_EVENTS', 'Solo events failed exact-shape validation.', undefined, this.eventIssues(invalidEvent, validation, 'Every solo event must use one exact discriminated shape.'));
      }
      const ids = action.events.flatMap((event) => event.id ? [event.id] : []);
      return new Set(ids).size === ids.length ? ok(true, 'Valid action.') : fail('DUPLICATE_EVENT_ID', 'Solo event IDs must be unique within one cue.');
    }
    if (action.type === 'remove-deck-events') return exactKeys(action, ['type', 'deck', 'instrument', 'eventIds']) && this.validateDeck(action.deck) && isInstrument(action.instrument) && Array.isArray(action.eventIds) && action.eventIds.length >= 1 && action.eventIds.length <= 256 && new Set(action.eventIds).size === action.eventIds.length && action.eventIds.every((id) => stringId(id)) ? ok(true, 'Valid action.') : fail('INVALID_REMOVE', 'A deck, instrument, and 1-256 unique event IDs are required.');
    if (action.type === 'replace-deck-events') {
      if (!exactKeys(action, ['type', 'deck', 'instrument', 'fromTick', 'toTick', 'events']) || !this.validateDeck(action.deck) || !isInstrument(action.instrument) || !isGridTick(action.fromTick) || !isGridTick(action.toTick) || action.fromTick >= action.toTick || !Array.isArray(action.events) || action.events.length < 1 || action.events.length > 256) return fail('INVALID_REPLACE', 'Replacement range must be nonempty and on the eighth-note grid.');
      const invalidEvent = action.events.findIndex((event) => { const validation = this.validateDeckEvent(event, action.instrument); return !validation.ok || event.startTick < action.fromTick || event.startTick >= action.toTick; });
      if (invalidEvent >= 0) {
        const event = action.events[invalidEvent];
        const validation = this.validateDeckEvent(event, action.instrument);
        if (!validation.ok) return fail('INVALID_REPLACE', 'Replacement event failed exact-shape validation.', undefined, this.eventIssues(invalidEvent, validation, 'Every replacement event must use one exact discriminated shape.'));
        return fail('INVALID_REPLACE', 'Every replacement event must lie inside the replacement range.', undefined, [{ path: `events[${invalidEvent}].startTick`, code: 'OUTSIDE_RANGE', message: 'The event start must be inside [fromTick, toTick).' }]);
      }
      const ids = action.events.flatMap((event) => event.id ? [event.id] : []);
      if (new Set(ids).size !== ids.length || ids.some((id) => this.decks[action.deck].hasAnyEventId(id))) return fail('DUPLICATE_EVENT_ID', 'Replacement event IDs must be unique and cannot collide with existing deck events.');
      return ok(true, 'Valid action.');
    }
    if (action.type === 'add-deck-events') {
      if (!exactKeys(action, ['type', 'deck', 'instrument', 'events']) || !this.validateDeck(action.deck) || !isInstrument(action.instrument) || !Array.isArray(action.events) || action.events.length < 1 || action.events.length > 256) return fail('INVALID_DECK_EVENTS', 'Deck events must contain 1-256 events.');
      const invalidEvent = action.events.findIndex((event) => !this.validateDeckEvent(event, action.instrument).ok);
      if (invalidEvent >= 0) {
        const validation = this.validateDeckEvent(action.events[invalidEvent], action.instrument);
        return fail('INVALID_DECK_EVENTS', 'Deck event failed exact-shape validation.', undefined, this.eventIssues(invalidEvent, validation, 'Every deck event must use one exact discriminated shape.'));
      }
      const ids = action.events.flatMap((event) => event.id ? [event.id] : []);
      if (new Set(ids).size !== ids.length) return fail('DUPLICATE_EVENT_ID', 'Deck event IDs must be unique.');
      if (ids.some((id) => this.decks[action.deck].hasAnyEventId(id))) return fail('DUPLICATE_EVENT_ID', 'Deck event IDs cannot collide with existing deck events.');
      return ok(true, 'Valid action.');
    }
    return fail('UNKNOWN_ACTION', `Unsupported cue action ${(action as { type: string }).type}.`);
  }
  private validateDeckEvent(event: AddDeckEvent, instrument: MusicInstrument): MusicResult<true> {
    if (!isObject(event) || (event.type !== 'drum' && event.type !== 'note' && event.type !== 'chord')) return fail('INVALID_EVENT', 'Event.type must be drum, note, or chord.', undefined, [{ path: 'event.type', code: 'REQUIRED', message: 'A supported event discriminator is required.' }]);
    if (event.type === 'note' && !('instrument' in event)) return fail('INVALID_NOTE', 'Note events require an instrument.', undefined, [{ path: 'event.instrument', code: 'REQUIRED', message: 'Note instrument is required.' }]);
    if (!exactKeys(event, event.type === 'drum' ? ['type', 'id', 'startTick', 'pad', 'velocity'] : event.type === 'note' ? ['type', 'id', 'instrument', 'startTick', 'durationTicks', 'pitch', 'velocity', 'articulation'] : ['type', 'id', 'startTick', 'durationTicks', 'symbol', 'pitches', 'velocity', 'voicing', 'articulation']) || !isGridTick(event.startTick) || event.startTick === DECK_TICKS) return fail('INVALID_EVENT', 'Event timing must be an eighth-note grid point inside the four-bar loop.');
    if (event.id !== undefined && !stringId(event.id)) return fail('INVALID_EVENT_ID', 'Event IDs must be nonempty and at most 80 characters.');
    if (event.type === 'drum') return instrument === 'drums' && Number.isInteger(event.pad) && this.validInteger(event.pad, 0, 11) && this.validNumber(event.velocity, 0, 1) ? ok(true, 'Valid drum.') : fail('INVALID_DRUM', 'Drum events need pad 0-11 and velocity 0-1.');
    if (event.type === 'note') return instrument === event.instrument && isNoteInstrument(event.instrument) && this.validInteger(event.pitch, 0, 127) && isGridDuration(event.durationTicks) && event.startTick + event.durationTicks <= DECK_TICKS && this.validNumber(event.velocity, 0, 1) && (event.articulation === undefined || this.validNumber(event.articulation, .05, 1)) ? ok(true, 'Valid note.') : fail('INVALID_NOTE', 'Note pitch, eighth-note duration, velocity, or articulation is invalid.');
    return instrument === 'chords' && typeof event.symbol === 'string' && event.symbol.trim().length > 0 && event.symbol.length <= 80 && Array.isArray(event.pitches) && event.pitches.length >= 1 && event.pitches.length <= 8 && event.pitches.every((pitch) => this.validInteger(pitch, 0, 127)) && isGridDuration(event.durationTicks) && event.startTick + event.durationTicks <= DECK_TICKS && (event.velocity === undefined || this.validNumber(event.velocity, 0, 1)) && isVoicing(event.voicing) && (event.articulation === undefined || this.validNumber(event.articulation, .05, 1)) ? ok(true, 'Valid chord.') : fail('INVALID_CHORD', 'Chord shape, eighth-note duration, pitches, velocity, or voicing is invalid.');
  }
  private validateSoloEvent(event: SoloEvent): MusicResult<true> {
    if (!isObject(event)) return fail('INVALID_SOLO_EVENT', 'Solo event must be an object.', undefined, [{ path: 'event', code: 'TYPE', message: 'Expected an object.' }]);
    if (event.type !== 'drum' && event.type !== 'note' && event.type !== 'chord') return fail('INVALID_SOLO_EVENT', 'Solo event.type must be drum, note, or chord.', undefined, [{ path: 'event.type', code: 'REQUIRED', message: 'A supported event discriminator is required.' }]);
    if (event.type === 'note' && !('instrument' in event)) return fail('INVALID_SOLO_NOTE', 'Solo note events require an instrument.', undefined, [{ path: 'event.instrument', code: 'REQUIRED', message: 'Note instrument is required.' }]);
    if (!exactKeys(event, event.type === 'drum' ? ['type', 'id', 'start', 'pad', 'velocity'] : event.type === 'note' ? ['type', 'id', 'start', 'instrument', 'durationTicks', 'pitch', 'velocity', 'articulation'] : ['type', 'id', 'start', 'durationTicks', 'symbol', 'pitches', 'velocity', 'voicing', 'articulation']) || !isMusicalTime(event.start) || (event.id !== undefined && !stringId(event.id))) return fail('INVALID_SOLO_EVENT', 'Solo events need exact keys and a valid global start.');
    if (event.type === 'drum') return Number.isInteger(event.pad) && this.validInteger(event.pad, 0, 11) && this.validNumber(event.velocity, 0, 1) ? ok(true, 'Valid solo drum.') : fail('INVALID_SOLO_DRUM', 'Solo drum pad or velocity is invalid.');
    if (event.type === 'note') return isNoteInstrument(event.instrument) && this.validInteger(event.pitch, 0, 127) && isSoloGridDuration(event.durationTicks) && this.validNumber(event.velocity, 0, 1) && (event.articulation === undefined || this.validNumber(event.articulation, .05, 1)) ? ok(true, 'Valid solo note.') : fail('INVALID_SOLO_NOTE', 'Solo note instrument, pitch, eighth-note duration, velocity, or articulation is invalid.');
    return typeof event.symbol === 'string' && event.symbol.trim().length > 0 && event.symbol.length <= 80 && Array.isArray(event.pitches) && event.pitches.length >= 1 && event.pitches.length <= 8 && event.pitches.every((pitch) => this.validInteger(pitch, 0, 127)) && isSoloGridDuration(event.durationTicks) && (event.velocity === undefined || this.validNumber(event.velocity, 0, 1)) && isVoicing(event.voicing) && (event.articulation === undefined || this.validNumber(event.articulation, .05, 1)) ? ok(true, 'Valid solo chord.') : fail('INVALID_SOLO_CHORD', 'Solo chord shape, eighth-note duration, pitches, velocity, or voicing is invalid.');
  }
  private eventIssues(index: number, validation: MusicResult<unknown>, fallback: string): ValidationIssue[] {
    if (!validation.issues?.length) return [{ path: `events[${index}]`, code: 'INVALID_EVENT', message: fallback }];
    return validation.issues.map((issue) => ({ ...issue, path: `events[${index}].${issue.path.replace(/^event\.?/, '')}`.replace(/\.$/, '') }));
  }
  private validateProfile(profile: unknown, instrument: MusicInstrument): MusicResult<true> {
    if (!isObject(profile) || !exactKeys(profile, instrument === 'drums' ? ['presetId', 'controls', 'parameters', 'volume', 'drumModel'] : ['presetId', 'controls', 'parameters', 'volume']) || !stringId(profile.presetId, 128) || !isObject(profile.controls) || !isObject(profile.parameters) || !this.exactProfileKeys(profile, instrument) || !this.validNumber(profile.volume, 0, 1) || (instrument === 'drums' && profile.drumModel !== undefined && !['layered', 'noisy', 'electronic'].includes(profile.drumModel as string))) return fail('INVALID_PROFILE', 'A complete profile with only known controls and parameters is required.');
    return ok(true, 'Valid profile.');
  }
  private exactProfileKeys(profile: Record<string, unknown>, instrument: MusicInstrument) { const controls = profile.controls as Record<string, unknown>; const parameters = profile.parameters as Record<string, unknown>; const controlNames = Object.keys(this.engine.controls[instrument]); const parameterNames = Object.keys(this.engine.parameters[instrument]); return Object.keys(controls).length === controlNames.length && controlNames.every((name) => this.validNumber(controls[name], 0, 1)) && Object.keys(parameters).length === parameterNames.length && parameterNames.every((name) => { const parameter = this.engine.parameters[instrument][name]; return Boolean(parameter) && this.validNumber(parameters[name], parameter.min, parameter.max); }); }
  private hasPendingEventIdCollision(action: CueAction) {
    if (action.type === 'create-solo' || action.type === 'add-solo-events') {
      const candidates = action.events.flatMap((event) => event.id ? [event.id] : []);
      if (this.solo?.events.some((event) => candidates.includes(event.id))) return true;
      return this.pendingCues.some((cue) => {
        if (cue.action.type !== 'create-solo' && cue.action.type !== 'add-solo-events') return false;
        const reserved = cue.action.events.flatMap((event) => event.id ? [event.id] : []);
        return candidates.some((id) => reserved.includes(id));
      });
    }
    if (action.type !== 'add-deck-events' && action.type !== 'replace-deck-events') return false;
    const candidates = action.events.flatMap((event) => event.id ? [event.id] : []);
    if (candidates.some((id) => this.decks[action.deck].hasAnyEventId(id))) return true;
    return this.pendingCues.some((cue) => {
      if (cue.action.type !== 'add-deck-events' && cue.action.type !== 'replace-deck-events') return false;
      if (cue.action.deck !== action.deck) return false;
      const reserved = cue.action.events.flatMap((event) => event.id ? [event.id] : []);
      return candidates.some((id) => reserved.includes(id));
    });
  }
  private normaliseActionIds(action: CueAction): CueAction {
    if (action.type === 'add-deck-events' || action.type === 'replace-deck-events') {
      return { ...clone(action), events: action.events.map((event) => ({ ...event, id: event.id ?? makeAgentEventId(event.type) })) } as CueAction;
    }
    if (action.type === 'add-solo-events') {
      return { ...clone(action), events: action.events.map((event) => ({ ...event, id: event.id ?? makeAgentEventId('solo') })) } as CueAction;
    }
    if (action.type === 'create-solo') {
      return { ...clone(action), events: action.events.map((event) => ({ ...event, id: event.id ?? makeAgentEventId('solo') })) } as CueAction;
    }
    return clone(action);
  }
  private validateDeck(value: unknown): value is DeckId { return value === 'A' || value === 'B'; }
  private validNumber(value: unknown, min: number, max: number) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
  private validInteger(value: unknown, min: number, max: number) { return this.validNumber(value, min, max) && Number.isInteger(value); }
  private conflictsWithHumanRecording(action: CueAction) { return this.humanRecording.active && (action.type === 'remove-deck-events' || action.type === 'replace-deck-events' || action.type === 'set-deck-sound-profile') && action.deck === this.humanRecording.deck && action.instrument === this.humanRecording.instrument; }
  private actionSummary(action: CueAction) { return action.type === 'add-deck-events' ? `Add ${action.events.length} ${action.instrument} event(s) to Deck ${action.deck}.` : action.type.replaceAll('-', ' '); }

  private applyAction(action: CueAction, cue: Cue, audioAt: number, audioAlreadyScheduled = false): { result: MusicResult<unknown>; inverse: Inverse } | MusicResult<never> {
    if (action.type === 'add-deck-events') { const before = this.decks[action.deck].events(action.instrument); action.events.forEach((event) => { if (event.id && this.decks[action.deck].hasAnyEventId(event.id)) throw new Error('Event ID already exists on this deck.'); }); action.events.forEach((event) => this.addDeckEvent(action.deck, action.instrument, event)); const after = this.decks[action.deck].events(action.instrument); const beforeIds = new Set(before.map((event) => event.id)); const added = after.filter((event) => !beforeIds.has(event.id)); const starts = new Set(added.map((event) => event.startTick)); const replaced = before.filter((event) => action.instrument === 'bass' && starts.has(event.startTick)); this.bumpTarget(action.deck, action.instrument); return { result: ok({ cueId: cue.id, added }, 'Deck events committed.', 'DECK_EVENTS_ADDED'), inverse: { kind: 'deck-add', cueId: cue.id, deck: action.deck, instrument: action.instrument, added, replaced } }; }
    if (action.type === 'remove-deck-events') { const removed = this.decks[action.deck].remove(action.instrument, action.eventIds); this.bumpTarget(action.deck, action.instrument); return { result: ok({ cueId: cue.id, removed: removed.removed, missing: removed.missing }, 'Deck events removed.', 'DECK_EVENTS_REMOVED'), inverse: { kind: 'deck-remove', cueId: cue.id, deck: action.deck, instrument: action.instrument, removed: removed.removed } }; }
    if (action.type === 'replace-deck-events') { const removed = this.decks[action.deck].replaceRange(action.instrument, action.fromTick, action.toTick); const added = action.events.map((event) => this.addDeckEvent(action.deck, action.instrument, event)); this.bumpTarget(action.deck, action.instrument); return { result: ok({ cueId: cue.id, removed, added }, 'Deck range replaced.', 'DECK_RANGE_REPLACED'), inverse: { kind: 'deck-replace', cueId: cue.id, deck: action.deck, instrument: action.instrument, added, removed } }; }
    if (action.type === 'set-instrument-enabled') { const previous = this.enabled[action.instrument]; this.enabled[action.instrument] = action.enabled; this.globalRevisions[action.instrument] += 1; if (!action.enabled) this.clearHumanHeld(action.instrument, audioAt); if (audioAlreadyScheduled) this.engine.commitInstrumentEnabled(action.instrument, action.enabled, audioAt); else this.engine.setInstrumentEnabled(action.instrument, action.enabled, audioAt); return { result: ok({ cueId: cue.id, instrument: action.instrument, enabled: action.enabled }, 'Global instrument state changed.', 'INSTRUMENT_STATE_CHANGED'), inverse: { kind: 'enabled', cueId: cue.id, instrument: action.instrument, previous, expectedRevision: this.globalRevisions[action.instrument] } }; }
    if (action.type === 'set-deck-sound-profile') {
      const previous = this.decks[action.deck].profile(action.instrument);
      const key = this.profileKey(action.deck, action.instrument);
      const previousTransition = this.profileTransitions.get(key);
      const boundary = absoluteTickOf(cue.normalisedAt);
      const source = this.effectiveProfileAt(action.deck, action.instrument, boundary) ?? action.profile;
      this.decks[action.deck].setSoundProfile(action.instrument, action.profile);
      if (action.transitionTicks && action.transitionTicks > 0) this.profileTransitions.set(key, { deck: action.deck, instrument: action.instrument, sourceProfile: clone(source), targetProfile: clone(action.profile), startAbsoluteTick: boundary, endAbsoluteTick: boundary + action.transitionTicks });
      else this.profileTransitions.delete(key);
      if (action.instrument === 'bass') this.engine.updateBassLaneProfile(laneForDeck(action.deck), action.profile, audioAt);
      this.bumpTarget(action.deck, action.instrument);
      return { result: ok({ cueId: cue.id, deck: action.deck, instrument: action.instrument, transitionTicks: action.transitionTicks ?? 0 }, action.transitionTicks ? 'Deck sound profile transition started.' : 'Deck sound profile changed.', 'PROFILE_CHANGED'), inverse: { kind: 'profile', cueId: cue.id, deck: action.deck, instrument: action.instrument, previous, previousTransition, expectedRevision: this.targetRevision(action.deck, action.instrument) } };
    }
    if (action.type === 'transfer-deck') return this.applyTransfer(action, cue, audioAt, audioAlreadyScheduled);
    if (action.type === 'start-solo') return this.applyStartSolo(action, cue);
    if (action.type === 'create-solo') return this.applyCreateSolo(action, cue, audioAlreadyScheduled);
    if (action.type === 'add-solo-events') return this.applyAddSoloEvents(action, cue);
    return this.applyEndSolo(action, cue);
  }
  private addDeckEvent(deckId: DeckId, instrument: MusicInstrument, event: AddDeckEvent) { const deck = this.decks[deckId]; if (event.type === 'drum') return deck.addDrum(event.pad, event.startTick, event.velocity, event.id); if (event.type === 'note') return deck.addNote(event.instrument, event.pitch, event.startTick, event.durationTicks, event.velocity, event.articulation, event.id); return deck.addChord(event.symbol, event.pitches, event.startTick, event.durationTicks, event.voicing ?? 'root', event.articulation, event.id, event.velocity); }
  private scheduleCueAudio(cue: Cue, audioAt: number) {
    const action = cue.action;
    if (action.type === 'create-solo') {
      if (this.solo?.status === 'active') throw new Error('SOLO_ALREADY_ACTIVE');
      const now = this.engine.context?.currentTime ?? audioAt;
      const eventIds: string[] = [];
      action.events.forEach((event) => {
        const eventAt = this.audioTimeAt(absoluteTickOf(quantizeMusicalTime(event.start)));
        if (eventAt < now - .02 || eventAt > now + LOOKAHEAD_SECONDS) return;
        if (event.type === 'drum') this.engine.drum(event.pad, eventAt, action.soundProfile, false, 'solo', event.velocity);
        else if (event.type === 'chord') this.engine.chord(event.pitches, playbackDurationSeconds(event.durationTicks, event.articulation, this.engine.tempo), eventAt, action.soundProfile, false, 'solo', event.velocity ?? 1);
        else { if (event.instrument === 'bass') this.engine.updateBassLaneProfile('solo', action.soundProfile, eventAt); this.engine.note(event.instrument, event.pitch, playbackDurationSeconds(event.durationTicks, event.articulation, this.engine.tempo), eventAt, action.soundProfile, false, 'solo', event.velocity); }
        if (event.id) eventIds.push(event.id);
      });
      this.preScheduledAudio.set(cue.id, { kind: 'solo-create', eventIds, at: audioAt });
      return;
    }
    if (action.type === 'set-instrument-enabled') {
      this.engine.setInstrumentEnabled(action.instrument, action.enabled, audioAt, false);
      this.preScheduledAudio.set(cue.id, { kind: 'instrument', instrument: action.instrument, enabled: action.enabled, at: audioAt });
      return;
    }
    if (action.type !== 'transfer-deck') return;
    const from = this.activeDeck;
    const destination = action.destination;
    if (from === destination) {
      this.preScheduledAudio.set(cue.id, { kind: 'transfer', from, destination, style: action.style, duration: .012, at: audioAt });
      return;
    }
    this.engine.cancelLaneGainAutomation(laneForDeck('A'), audioAt);
    this.engine.cancelLaneGainAutomation(laneForDeck('B'), audioAt);
    const duration = action.style === 'cut' ? .018 : ticksToSeconds(action.durationTicks, this.engine.tempo);
    this.scheduleTransferGains(from, destination, action.style, audioAt, duration);
    this.preScheduledAudio.set(cue.id, { kind: 'transfer', from, destination, style: action.style, duration, at: audioAt });
  }
  private scheduleTransferGains(from: DeckId, destination: DeckId, style: TransferStyle, audioAt: number, duration: number) {
    const fromLane = laneForDeck(from);
    const destinationLane = laneForDeck(destination);
    const safeDuration = Math.max(.018, duration);
    if (style === 'dip') {
      const half = safeDuration / 2;
      this.engine.setLaneGainRamp(fromLane, 0, audioAt, half);
      this.engine.setLaneGainRamp(destinationLane, 0, audioAt, .018);
      this.engine.setLaneGainRamp(destinationLane, 1, audioAt + half, half);
      return;
    }
    if (style === 'overlap') {
      const half = safeDuration / 2;
      this.engine.setLaneGainRamp(destinationLane, 1, audioAt, half);
      this.engine.setLaneGainRamp(fromLane, 0, audioAt + half, half);
      return;
    }
    this.engine.setLaneGainRamp(fromLane, 0, audioAt, safeDuration);
    this.engine.setLaneGainRamp(destinationLane, 1, audioAt, safeDuration);
  }
  private scheduledDeckView(deckId: DeckId, absoluteTick: number) {
    const projected = new SingleDeck();
    projected.restore(this.decks[deckId].snapshot());
    const cues = this.pendingCues
      .filter((cue) => (cue.status === 'pending' || cue.status === 'scheduled') && 'deck' in cue.action && cue.action.deck === deckId)
      .filter((cue) => absoluteTickOf(cue.normalisedAt) <= absoluteTick)
      .sort((left, right) => absoluteTickOf(left.normalisedAt) - absoluteTickOf(right.normalisedAt) || left.id.localeCompare(right.id));
    cues.forEach((cue) => {
      const action = cue.action;
      if (action.type === 'add-deck-events') action.events.forEach((event) => this.addDeckEventTo(projected, action.instrument, event));
      else if (action.type === 'remove-deck-events') projected.remove(action.instrument, action.eventIds);
      else if (action.type === 'replace-deck-events') { projected.replaceRange(action.instrument, action.fromTick, action.toTick); action.events.forEach((event) => this.addDeckEventTo(projected, action.instrument, event)); }
      else if (action.type === 'set-deck-sound-profile') projected.setSoundProfile(action.instrument, action.profile);
    });
    const profiles = projected.soundProfiles();
    (instruments as MusicInstrument[]).forEach((instrument) => {
      const effective = this.profileForDeckTick(deckId, instrument, absoluteTick);
      if (effective) profiles[instrument] = effective;
    });
    return { events: projected.eventsAt(((absoluteTick % DECK_TICKS) + DECK_TICKS) % DECK_TICKS), profiles };
  }
  private addDeckEventTo(deck: SingleDeck, instrument: MusicInstrument, event: AddDeckEvent) { if (event.type === 'drum') return deck.addDrum(event.pad, event.startTick, event.velocity, event.id); if (event.type === 'note') return deck.addNote(event.instrument, event.pitch, event.startTick, event.durationTicks, event.velocity, event.articulation, event.id); return deck.addChord(event.symbol, event.pitches, event.startTick, event.durationTicks, event.voicing ?? 'root', event.articulation, event.id, event.velocity); }
  private applyTransfer(action: Extract<CueAction, { type: 'transfer-deck' }>, cue: Cue, audioAt: number, audioAlreadyScheduled = false) {
    const from = this.activeDeck; const previousTransfer = this.transfer ? clone(this.transfer) : null; if (from === action.destination) return { result: ok({ cueId: cue.id, from, destination: action.destination, status: 'complete' }, 'Transfer already targets the active deck.', 'TRANSFER_COMPLETE'), inverse: { kind: 'transfer', cueId: cue.id, previousActive: from, previousTransfer, expectedRevision: ++this.transferRevision } as Inverse };
    this.clearTransferTimer(); this.transferRevision += 1; const duration = ticksToSeconds(action.durationTicks, this.engine.tempo); const transfer: TransferState = { from, destination: action.destination, style: action.style, durationTicks: action.durationTicks, startedAt: cue.normalisedAt, progress: 0, status: 'active' }; this.transfer = transfer;
    if (action.style === 'cut' || duration === 0) { if (!audioAlreadyScheduled) { this.engine.cancelLaneGainAutomation(laneForDeck('A'), audioAt); this.engine.cancelLaneGainAutomation(laneForDeck('B'), audioAt); this.scheduleTransferGains(from, action.destination, 'cut', audioAt, .018); } this.activeDeck = action.destination; this.manualCrossfade = action.destination === 'A' ? 0 : 1; this.transfer = { ...transfer, progress: 1, status: 'complete' }; }
    else { if (!audioAlreadyScheduled) { this.engine.cancelLaneGainAutomation(laneForDeck('A'), audioAt); this.engine.cancelLaneGainAutomation(laneForDeck('B'), audioAt); this.scheduleTransferGains(from, action.destination, action.style, audioAt, duration); } const revision = this.transferRevision; if (typeof window !== 'undefined') this.transferTimer = window.setTimeout(() => { if (this.transfer && this.transferRevision === revision) { this.activeDeck = action.destination; this.manualCrossfade = action.destination === 'A' ? 0 : 1; this.transfer = { ...this.transfer, progress: 1, status: 'complete' }; this.bump(); } }, Math.max(0, (audioAt + duration - (this.engine.context?.currentTime ?? audioAt)) * 1000)); }
    return { result: ok({ cueId: cue.id, from, destination: action.destination, style: action.style, durationTicks: action.durationTicks, progress: this.transfer.progress }, 'Deck transfer started.', 'TRANSFER_STARTED'), inverse: { kind: 'transfer', cueId: cue.id, previousActive: from, previousTransfer, expectedRevision: this.transferRevision } as Inverse };
  }
  private applyStartSolo(action: Extract<CueAction, { type: 'start-solo' }>, cue: Cue) {
    const startAbsoluteTick = absoluteTickOf(cue.normalisedAt);
    return this.applyCreateSolo({
      type: 'create-solo',
      soloId: action.soloId,
      instrument: action.instrument,
      description: action.description,
      lengthBars: action.lengthBars,
      soundProfile: action.soundProfile,
      events: action.initialEvents.map(({ offsetTicks, ...event }) => ({ ...event, id: event.id ?? makeAgentEventId('solo'), start: musicalTimeOf(startAbsoluteTick + offsetTicks) } as SoloEvent)),
    }, cue);
  }
  private applyCreateSolo(action: Extract<CueAction, { type: 'create-solo' }>, cue: Cue, audioAlreadyScheduled = false) {
    if (this.solo?.status === 'active') return fail('SOLO_ALREADY_ACTIVE', 'Only one solo can be active.');
    const previous = this.solo ? clone(this.solo) : null;
    const previousPlayed = [...this.soloPlayed];
    const events: StoredSoloEvent[] = [];
    const ids = new Set<string>();
    for (const input of action.events) {
      const checked = this.normaliseSoloEvent(input);
      if (!checked.ok) return fail('INVALID_SOLO_EVENT', checked.message, undefined, checked.issues);
      const event = checked.data!;
      if (ids.has(event.id)) return fail('DUPLICATE_EVENT_ID', `Solo event ID ${event.id} is repeated.`);
      ids.add(event.id);
      if (!this.soloEventMatchesInstrument(event, action.instrument)) return fail('SOLO_INSTRUMENT_MISMATCH', 'Solo event type and note instrument must match the solo instrument.');
      events.push(event);
    }
    const startAbsoluteTick = absoluteTickOf(cue.normalisedAt);
    this.solo = { soloId: action.soloId, instrument: action.instrument, description: action.description, start: cue.normalisedAt, startAbsoluteTick, endAbsoluteTick: startAbsoluteTick + action.lengthBars * BAR_TICKS, lengthBars: action.lengthBars, soundProfile: clone(action.soundProfile), events, status: 'active' };
    const scheduled = this.preScheduledAudio.get(cue.id);
    this.soloPlayed = audioAlreadyScheduled && scheduled?.kind === 'solo-create' ? new Set(scheduled.eventIds) : new Set();
    this.soloRevision += 1;
    this.startCuePump();
    return { result: ok({ cueId: cue.id, soloId: action.soloId, start: cue.normalisedAt, endAbsoluteTick: this.solo.endAbsoluteTick, eventIds: events.map((event) => event.id) }, 'Atomic solo created.', 'SOLO_CREATED'), inverse: { kind: 'solo-state', cueId: cue.id, previous, previousPlayed, expectedRevision: this.soloRevision } as Inverse };
  }
  private soloEventMatchesInstrument(event: StoredSoloEvent | SoloEvent, instrument: MusicInstrument) { return instrument === 'drums' ? event.type === 'drum' : instrument === 'chords' ? event.type === 'chord' : event.type === 'note' && event.instrument === instrument; }
  private applyAddSoloEvents(action: Extract<CueAction, { type: 'add-solo-events' }>, cue: Cue) {
    if (!this.solo || this.solo.soloId !== action.soloId || this.solo.status !== 'active') return fail('SOLO_NOT_ACTIVE', 'The requested solo is not active.');
    const existingIds = new Set(this.solo.events.map((event) => event.id)); const ids = new Set<string>(); const events: StoredSoloEvent[] = [];
    for (const input of action.events) { const checked = this.normaliseSoloEvent(input); if (!checked.ok) return fail('INVALID_SOLO_EVENT', checked.message, undefined, checked.issues); const event = checked.data!; if (ids.has(event.id) || existingIds.has(event.id)) return fail('DUPLICATE_EVENT_ID', `Solo event ID ${event.id} is already present.`); ids.add(event.id); if (!this.soloEventMatchesInstrument(event, this.solo.instrument)) return fail('SOLO_INSTRUMENT_MISMATCH', 'Solo event type and note instrument must match the solo instrument.'); const start = absoluteTickOf(event.start); if (start < this.solo.startAbsoluteTick || start >= this.solo.endAbsoluteTick) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'Solo event starts outside the global solo window.'); if (event.type !== 'drum' && start + event.durationTicks > this.solo.endAbsoluteTick) return fail('SOLO_EVENT_OUTSIDE_WINDOW', 'A solo note or chord may not cross the natural solo end.'); events.push(event); }
    const now = this.engine.context?.currentTime; if (now !== undefined && events.some((event) => this.audioTimeAt(absoluteTickOf(event.start)) < now + LOOKAHEAD_SECONDS)) return fail('SOLO_EVENT_TOO_LATE', 'Solo events must be outside the safe scheduling window.');
    this.solo = { ...this.solo, events: [...this.solo.events, ...events].sort((a, b) => absoluteTickOf(a.start) - absoluteTickOf(b.start)) }; this.soloRevision += 1; return { result: ok({ cueId: cue.id, soloId: action.soloId, added: events.map((event) => event.id) }, 'Solo events committed.', 'SOLO_EVENTS_ADDED'), inverse: { kind: 'solo-add', cueId: cue.id, soloId: action.soloId, addedIds: [...ids], expectedRevision: this.soloRevision } as Inverse };
  }
  private applyEndSolo(action: Extract<CueAction, { type: 'end-solo-early' }>, cue: Cue) { if (!this.solo || this.solo.soloId !== action.soloId) return fail('SOLO_NOT_FOUND', 'The requested solo was not found.'); const previous = clone(this.solo); const previousPlayed = [...this.soloPlayed]; this.engine.stopLaneVoices('solo'); this.solo = { ...this.solo, status: 'ended' }; this.soloRevision += 1; return { result: ok({ cueId: cue.id, soloId: action.soloId, status: 'ended' }, 'Solo ended early.', 'SOLO_ENDED'), inverse: { kind: 'solo-state', cueId: cue.id, previous, previousPlayed, expectedRevision: this.soloRevision } as Inverse }; }
  private normaliseSoloEvent(event: SoloEvent): MusicResult<StoredSoloEvent> { const valid = this.validateSoloEvent(event); if (!valid.ok) return fail<StoredSoloEvent>(valid.code, valid.message, undefined, valid.issues); const start = quantizeMusicalTime(event.start); const id = event.id ?? `solo-event-${nextSoloEventId++}`; return ok({ ...clone(event), id, start } as StoredSoloEvent, 'Valid solo event.'); }

  private applyInverse(inverse: Inverse): MusicResult<unknown> {
    if (inverse.kind === 'deck-prepare') {
      const unchanged = instruments.every((instrument) => this.targetRevision(inverse.deck, instrument) === inverse.expectedRevisions[instrument]);
      if (!unchanged) return fail('UNDO_CONFLICT', 'A later change touched the prepared deck.');
      this.decks[inverse.deck].restore(inverse.previous);
      instruments.forEach((instrument) => { this.profileTransitions.delete(this.profileKey(inverse.deck, instrument)); this.bumpTarget(inverse.deck, instrument); });
      const bassProfile = inverse.previous.profiles.bass;
      if (bassProfile) this.engine.updateBassLaneProfile(laneForDeck(inverse.deck), bassProfile);
      return ok(true, 'Atomic deck preparation reversed.');
    }
    if (inverse.kind === 'deck-add') { const current = this.decks[inverse.deck].events(inverse.instrument); const conflicting = inverse.replaced.some((old) => current.some((event) => event.startTick === old.startTick && !inverse.added.some((added) => added.id === event.id))); if (conflicting) return fail('UNDO_CONFLICT', 'A later human event occupies a bass slot changed by the agent.'); const removed = this.decks[inverse.deck].removeExactEvents(inverse.instrument, inverse.added); if (removed.length !== inverse.added.length) return fail('UNDO_CONFLICT', 'A later change modified an agent event.'); this.decks[inverse.deck].restoreEvents(inverse.instrument, inverse.replaced); this.bumpTarget(inverse.deck, inverse.instrument); return ok(true, 'Agent deck additions reversed.'); }
    if (inverse.kind === 'deck-remove' || inverse.kind === 'deck-replace') {
      // Remove/replace inverses merge by exact event ID. A later human event
      // on another slot remains untouched; only reuse of an agent/removed ID,
      // or a conflicting monophonic bass slot, blocks a safe inverse.
      const current = this.decks[inverse.deck].events(inverse.instrument);
      if (inverse.kind === 'deck-replace') {
        const exactAdded = inverse.added.every((event) => current.some((candidate) => candidate.id === event.id && JSON.stringify(candidate) === JSON.stringify(event)));
        if (!exactAdded) return fail('UNDO_CONFLICT', 'A later change modified replacement events.');
      }
      const addedIds = new Set(inverse.kind === 'deck-replace' ? inverse.added.map((event) => event.id) : []);
      const laterCurrent = current.filter((candidate) => !addedIds.has(candidate.id));
      if (inverse.removed.some((event) => laterCurrent.some((candidate) => candidate.id === event.id))) return fail('UNDO_CONFLICT', 'A later event uses an ID needed by the inverse.');
      if (inverse.instrument === 'bass' && inverse.removed.some((event) => laterCurrent.some((candidate) => candidate.startTick === event.startTick))) return fail('UNDO_CONFLICT', 'A later bass event occupies a slot needed by the inverse.');
      if (inverse.kind === 'deck-replace') this.decks[inverse.deck].removeExactEvents(inverse.instrument, inverse.added);
      this.decks[inverse.deck].restoreEvents(inverse.instrument, inverse.removed);
      this.bumpTarget(inverse.deck, inverse.instrument);
      return ok(true, 'Agent deck mutation reversed.');
    }
    if (inverse.kind === 'profile') { if (this.targetRevision(inverse.deck, inverse.instrument) !== inverse.expectedRevision) return fail('UNDO_CONFLICT', 'A later human profile change touched this target.'); if (inverse.previous) this.decks[inverse.deck].setSoundProfile(inverse.instrument, inverse.previous); else this.decks[inverse.deck].removeSoundProfile(inverse.instrument); const key = this.profileKey(inverse.deck, inverse.instrument); if (inverse.previousTransition) this.profileTransitions.set(key, clone(inverse.previousTransition)); else this.profileTransitions.delete(key); if (inverse.instrument === 'bass' && inverse.previous) this.engine.updateBassLaneProfile(laneForDeck(inverse.deck), inverse.previous); this.bumpTarget(inverse.deck, inverse.instrument); return ok(true, 'Agent profile change reversed.'); }
    if (inverse.kind === 'enabled') { if (this.globalRevisions[inverse.instrument] !== inverse.expectedRevision) return fail('UNDO_CONFLICT', 'A later change touched this instrument state.'); this.enabled[inverse.instrument] = inverse.previous; this.engine.setInstrumentEnabled(inverse.instrument, inverse.previous); this.globalRevisions[inverse.instrument] += 1; return ok(true, 'Agent instrument state reversed.'); }
    if (inverse.kind === 'transfer') { if (this.transferRevision !== inverse.expectedRevision) return fail('UNDO_CONFLICT', 'A later transfer changed deck routing.'); this.clearTransferTimer(); this.activeDeck = inverse.previousActive; this.transfer = inverse.previousTransfer ? clone(inverse.previousTransfer) : null; const now = this.engine.context?.currentTime; if (now !== undefined) { this.engine.cancelLaneGainAutomation('deckA', now); this.engine.cancelLaneGainAutomation('deckB', now); this.engine.setLaneGainRamp('deckA', this.activeDeck === 'A' ? 1 : 0, now, .012); this.engine.setLaneGainRamp('deckB', this.activeDeck === 'B' ? 1 : 0, now, .012); } this.transferRevision += 1; return ok(true, 'Agent transfer reversed.'); }
    if (inverse.kind === 'solo-add') { if (this.soloRevision !== inverse.expectedRevision || !this.solo || this.solo.soloId !== inverse.soloId) return fail('UNDO_CONFLICT', 'A later solo change touched the solo buffer.'); const ids = new Set(inverse.addedIds); const remaining = this.solo.events.filter((event) => !ids.has(event.id)); if (remaining.length !== this.solo.events.length - ids.size) return fail('UNDO_CONFLICT', 'A later change modified an agent solo event.'); this.solo = { ...this.solo, events: remaining }; inverse.addedIds.forEach((id) => this.soloPlayed.delete(id)); this.soloRevision += 1; return ok(true, 'Agent solo additions reversed.'); }
    if (this.soloRevision !== inverse.expectedRevision) return fail('UNDO_CONFLICT', 'A later solo change touched the solo buffer.'); this.engine.stopLaneVoices('solo'); this.solo = inverse.previous ? clone(inverse.previous) : null; this.soloPlayed = new Set(inverse.previousPlayed); this.soloRevision += 1; return ok(true, 'Agent solo action reversed.');
  }
  private clearTransferTimer() { if (this.transferTimer !== null && typeof window !== 'undefined') window.clearTimeout(this.transferTimer); this.transferTimer = null; }
  private trimHistory<T>(items: T[]) { if (items.length > MAX_HISTORY) items.splice(0, items.length - MAX_HISTORY); }
  private chordContext(deckId: DeckId, absoluteTick: number) { const events = this.decks[deckId].snapshot().events.chords; if (events.length === 0) return { current: null, upcoming: null }; const phase = ((Math.floor(absoluteTick) % DECK_TICKS) + DECK_TICKS) % DECK_TICKS; const currentCandidates = events.map((event) => ({ event, distance: (phase - event.startTick + DECK_TICKS) % DECK_TICKS })).filter((item) => item.distance < eventDuration(item.event)); const current = currentCandidates.sort((a, b) => a.distance - b.distance)[0]; const upcoming = events.map((event) => ({ event, ticksUntil: (event.startTick - phase + DECK_TICKS) % DECK_TICKS })).filter((item) => item.ticksUntil > 0).sort((a, b) => a.ticksUntil - b.ticksUntil)[0]; return { current: current ? { deck: deckId, event: current.event, remainingTicks: Math.max(0, eventDuration(current.event) - current.distance) } : null, upcoming: upcoming ? { deck: deckId, event: upcoming.event, ticksUntil: upcoming.ticksUntil } : null }; }
  private transferProgress(transfer: TransferState) { if (transfer.status !== 'active') return transfer.progress; const elapsed = this.clockSnapshot().absoluteTick - absoluteTickOf(transfer.startedAt); return Math.max(0, Math.min(1, elapsed / Math.max(1, transfer.durationTicks))); }
  private debugProfile(instrument: MusicInstrument, source: 'live' | 'deckA' | 'deckB' | 'activeSolo') { if (source === 'deckA') return this.decks.A.profile(instrument); if (source === 'deckB') return this.decks.B.profile(instrument); if (source === 'activeSolo') return this.solo?.instrument === instrument ? clone(this.solo.soundProfile) : undefined; return this.engine.getSoundProfile(instrument, 'debug-live'); }
}

const eventDuration = (event: ChordEvent) => Math.min(DECK_TICKS, Math.max(EIGHTH_NOTE_TICKS, Math.round(event.durationTicks / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS));
