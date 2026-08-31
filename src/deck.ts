export const PPQ = 480;
export const BEATS_PER_BAR = 4;
export const DECK_BARS = 4;
export const DECK_TICKS = PPQ * BEATS_PER_BAR * DECK_BARS;
export const EIGHTH_NOTE_TICKS = PPQ / 2;
export type QuantizeDivision = 'off' | '1/4' | '1/8' | '1/16';
export const quantizeTicksFor = (division: QuantizeDivision) => division === 'off' ? 1 : division === '1/4' ? PPQ : division === '1/16' ? PPQ / 4 : EIGHTH_NOTE_TICKS;
const LOOKAHEAD_SECONDS = .1;
const SCHEDULER_INTERVAL_MS = 25;
const FIRST_BEAT_TOLERANCE_SECONDS = .12;
export const safeTempo = (tempo: number) => Number.isFinite(tempo) && tempo > 0 ? tempo : 120;

export type DeckInstrument = 'drums' | 'bass' | 'chords' | 'lead';
export type NoteInstrument = 'bass' | 'lead';

export type NoteEvent = {
  id: string;
  startTick: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
  articulation?: number;
};

export type DrumEvent = {
  id: string;
  startTick: number;
  pad: number;
  velocity: number;
};

export type ChordEvent = {
  id: string;
  startTick: number;
  durationTicks: number;
  symbol: string;
  pitches: number[];
  /** Optional for old decks; new callers can use it to scale the whole chord. */
  velocity?: number;
  voicing?: 'root' | 'open' | 'first-inversion' | 'second-inversion' | 'third-inversion';
  articulation?: number;
};

export type DeckSoundProfile = {
  presetId: string;
  controls: Record<string, number>;
  parameters: Record<string, number>;
  volume: number;
  drumModel?: 'layered' | 'noisy' | 'electronic';
};

export type DeckSnapshot = {
  lengthBars: number;
  events: {
    drums: DrumEvent[];
    bass: NoteEvent[];
    chords: ChordEvent[];
    lead: NoteEvent[];
  };
  profiles: Partial<Record<DeckInstrument, DeckSoundProfile>>;
};

const wrapTick = (tick: number) => ((tick % DECK_TICKS) + DECK_TICKS) % DECK_TICKS;
export const quantizeToGrid = (tick: number, gridTicks = EIGHTH_NOTE_TICKS) => wrapTick(Math.round(tick / Math.max(1, gridTicks)) * Math.max(1, gridTicks));
export const quantizeToEighth = (tick: number) => quantizeToGrid(tick, EIGHTH_NOTE_TICKS);
export const clampArticulation = (articulation?: number) => Number.isFinite(articulation) ? Math.min(1, Math.max(.05, articulation!)) : 1;
export const clampVelocity = (velocity?: number) => Number.isFinite(velocity) ? Math.min(1, Math.max(0, velocity!)) : 1;
export const preserveDuration = (durationTicks: number) => Number.isFinite(durationTicks) ? Math.max(EIGHTH_NOTE_TICKS, Math.min(DECK_TICKS, Math.round(durationTicks / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS)) : EIGHTH_NOTE_TICKS;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let nextEventId = 1;
const eventId = (kind: string) => `${kind}-${nextEventId++}`;

export class SingleDeck {
  readonly lengthBars = DECK_BARS;
  private state: DeckSnapshot = {
    lengthBars: DECK_BARS,
    events: { drums: [], bass: [], chords: [], lead: [] },
    profiles: {},
  };

  addDrum(pad: number, startTick: number, velocity = 1, id = eventId('drum'), gridTicks = EIGHTH_NOTE_TICKS) {
    const event: DrumEvent = { id, startTick: quantizeToGrid(startTick, gridTicks), pad, velocity };
    this.state.events.drums.push(event);
    this.state.events.drums.sort((a, b) => a.startTick - b.startTick);
    return clone(event);
  }

  addNote(instrument: NoteInstrument, pitch: number, startTick: number, durationTicks: number, velocity = 1, articulation = 1, id = eventId(instrument), gridTicks = EIGHTH_NOTE_TICKS) {
    const normalizedStartTick = quantizeToGrid(startTick, gridTicks);
    const event: NoteEvent = {
      id,
      startTick: normalizedStartTick,
      durationTicks: Math.max(gridTicks, Math.min(DECK_TICKS, Math.round(Math.min(durationTicks, DECK_TICKS - normalizedStartTick) / gridTicks) * gridTicks)),
      pitch,
      velocity,
      articulation: clampArticulation(articulation),
    };
    if (instrument === 'bass') {
      this.state.events.bass = this.state.events.bass.filter((existing) => existing.startTick !== normalizedStartTick);
    }
    this.state.events[instrument].push(event);
    this.state.events[instrument].sort((a, b) => a.startTick - b.startTick);
    return clone(event);
  }

  addChord(symbol: string, pitches: number[], startTick: number, durationTicks: number, voicing: ChordEvent['voicing'] = 'root', articulation = 1, id = eventId('chord'), velocity = 1, gridTicks = EIGHTH_NOTE_TICKS) {
    const normalizedStartTick = quantizeToGrid(startTick, gridTicks);
    const event: ChordEvent = {
      id,
      startTick: normalizedStartTick,
      durationTicks: Math.max(gridTicks, Math.min(DECK_TICKS, Math.round(Math.min(durationTicks, DECK_TICKS - normalizedStartTick) / gridTicks) * gridTicks)),
      symbol,
      pitches: [...pitches],
      velocity: clampVelocity(velocity),
      voicing,
      articulation: clampArticulation(articulation),
    };
    this.state.events.chords.push(event);
    this.state.events.chords.sort((a, b) => a.startTick - b.startTick);
    return clone(event);
  }

  remove(instrument: DeckInstrument, eventIds: string[]) {
    const ids = new Set(eventIds);
    const existing = this.state.events[instrument];
    const removed = existing.filter((event) => ids.has(event.id)).map(clone);
    this.state.events[instrument] = existing.filter((event) => !ids.has(event.id)) as never;
    return { removed, missing: eventIds.filter((id) => !removed.some((event) => event.id === id)) };
  }

  clear() {
    this.state.events = { drums: [], bass: [], chords: [], lead: [] };
    this.state.profiles = {};
  }

  clearInstrument(instrument: DeckInstrument) {
    if (instrument === 'drums') this.state.events.drums = [];
    if (instrument === 'bass') this.state.events.bass = [];
    if (instrument === 'chords') this.state.events.chords = [];
    if (instrument === 'lead') this.state.events.lead = [];
  }

  setSoundProfile(instrument: DeckInstrument, profile: DeckSoundProfile) {
    this.state.profiles[instrument] = clone(profile);
  }

  replaceRange(instrument: DeckInstrument, fromTick: number, toTick: number) {
    const from = Math.max(0, Math.min(DECK_TICKS, Math.round(fromTick)));
    const to = Math.max(from, Math.min(DECK_TICKS, Math.round(toTick)));
    const removed = this.state.events[instrument].filter((event) => event.startTick >= from && event.startTick < to).map(clone);
    this.state.events[instrument] = this.state.events[instrument].filter((event) => event.startTick < from || event.startTick >= to) as never;
    return removed;
  }

  restore(snapshot: DeckSnapshot) {
    this.state = clone(snapshot);
  }

  eventsAt(startTick: number) {
    const tick = quantizeToEighth(startTick);
    return {
      drums: this.state.events.drums.filter((event) => event.startTick === tick).map(clone),
      bass: this.state.events.bass.filter((event) => event.startTick === tick).map(clone),
      chords: this.state.events.chords.filter((event) => event.startTick === tick).map(clone),
      lead: this.state.events.lead.filter((event) => event.startTick === tick).map(clone),
    };
  }

  snapshot(): DeckSnapshot {
    return clone(this.state);
  }

  soundProfiles() {
    return clone(this.state.profiles);
  }

  eventCount() {
    const events = this.state.events;
    return events.drums.length + events.bass.length + events.chords.length + events.lead.length;
  }

  events(instrument: DeckInstrument) { return clone(this.state.events[instrument]); }
  hasEventId(instrument: DeckInstrument, id: string) { return this.state.events[instrument].some((event) => event.id === id); }
  hasAnyEventId(id: string) { return (Object.keys(this.state.events) as DeckInstrument[]).some((instrument) => this.hasEventId(instrument, id)); }
  restoreEvents(instrument: DeckInstrument, events: Array<DrumEvent | NoteEvent | ChordEvent>) {
    const current = this.state.events[instrument];
    const ids = new Set(events.map((event) => event.id));
    this.state.events[instrument] = [...current.filter((event) => !ids.has(event.id)), ...clone(events)].sort((a, b) => a.startTick - b.startTick) as never;
  }
  removeExactEvents(instrument: DeckInstrument, events: Array<DrumEvent | NoteEvent | ChordEvent>) {
    const wanted = new Map(events.map((event) => [event.id, JSON.stringify(event)]));
    const current = this.state.events[instrument];
    const removed: Array<DrumEvent | NoteEvent | ChordEvent> = [];
    this.state.events[instrument] = current.filter((event) => {
      const exact = wanted.get(event.id) === JSON.stringify(event);
      if (exact) removed.push(clone(event));
      return !exact;
    }) as never;
    return removed;
  }
  profile(instrument: DeckInstrument) { return this.state.profiles[instrument] ? clone(this.state.profiles[instrument]) : undefined; }
  removeSoundProfile(instrument: DeckInstrument) { delete this.state.profiles[instrument]; }
}

export type RecordMode = 'overdub' | 'replace';
type RawDrum = { kind: 'drum'; pad: number; startTick: number; velocity: number };
type RawNote = { kind: 'note'; instrument: NoteInstrument; pitch: number; startTick: number; endTick: number; velocity: number };
type RawChord = { kind: 'chord'; symbol: string; pitches: number[]; startTick: number; endTick: number; voicing: ChordEvent['voicing']; velocity: number };
type RawEvent = RawDrum | RawNote | RawChord;

export type RecordedTakeEvent = DrumEvent | NoteEvent | ChordEvent;
export type RecordedTake = Readonly<{
  instrument: DeckInstrument;
  mode: RecordMode;
  events: ReadonlyArray<RecordedTakeEvent>;
  count: number;
  quantizeTicks?: number;
}>;

const freezeTake = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value as Record<string, unknown>).forEach((child) => freezeTake(child));
    Object.freeze(value);
  }
  return value;
};

export class DeckRecorder {
  private recording = false;
  private target: DeckInstrument = 'lead';
  private mode: RecordMode = 'overdub';
  private startAt = 0;
  private countInBeats = 0;
  private rawEvents: RawEvent[] = [];
  private activeNotes = new Map<string, Omit<RawNote, 'kind' | 'endTick'>>();
  private activeChords = new Map<string, Omit<RawChord, 'kind' | 'endTick'>>();
  private tempoValue = 120;
  private timeAnchor = 0;
  private tickAnchor = 0;
  private countInStartAt = 0;
  private quantizeTicks = EIGHTH_NOTE_TICKS;
  private readonly context: () => AudioContext | null;
  private readonly tempo: () => number;

  constructor(context: () => AudioContext | null, tempo: () => number, _deck?: SingleDeck) {
    this.context = context;
    this.tempo = tempo;
  }

  begin(target: DeckInstrument, mode: RecordMode = 'overdub', countInBeats = 0) {
    const audio = this.context();
    if (!audio) return false;
    this.cancel();
    this.target = target;
    this.mode = mode;
    this.countInBeats = Math.max(0, Math.round(countInBeats));
    const secondsPerBeat = 60 / safeTempo(this.tempo());
    this.countInStartAt = audio.currentTime;
    this.startAt = audio.currentTime + this.countInBeats * secondsPerBeat;
    this.tempoValue = safeTempo(this.tempo());
    this.timeAnchor = this.startAt;
    this.tickAnchor = 0;
    this.recording = true;
    return true;
  }

  isRecording() { return this.recording; }
  setQuantization(division: QuantizeDivision) { this.quantizeTicks = quantizeTicksFor(division); }
  targetInstrument() { return this.target; }
  recordingStartAt() { return this.startAt; }

  retime() {
    const audio = this.context();
    if (!audio || !this.recording) return;
    const nextTempo = safeTempo(this.tempo());
    if (audio.currentTime < this.startAt && this.countInBeats > 0) {
      const elapsedBeats = Math.max(0, (audio.currentTime - this.countInStartAt) * this.tempoValue / 60);
      const newBeatLength = 60 / nextTempo;
      this.startAt = audio.currentTime + Math.max(0, this.countInBeats - elapsedBeats) * newBeatLength;
      this.countInStartAt = audio.currentTime - elapsedBeats * newBeatLength;
      this.tempoValue = nextTempo;
      return;
    }
    if (audio.currentTime >= this.startAt) {
      const currentTick = this.tickAt(audio.currentTime);
      this.timeAnchor = audio.currentTime;
      this.tickAnchor = currentTick;
    }
    this.tempoValue = nextTempo;
  }

  countInBeat() {
    if (!this.recording || this.countInBeats === 0) return null;
    const audio = this.context();
    if (!audio || audio.currentTime >= this.startAt) return null;
    const secondsPerBeat = 60 / this.tempoValue;
    const elapsed = audio.currentTime - (this.startAt - this.countInBeats * secondsPerBeat);
    return Math.min(this.countInBeats, Math.floor(Math.max(0, elapsed) / secondsPerBeat) + 1);
  }

  countInPositionTick() {
    if (!this.recording || this.countInBeats === 0) return null;
    const audio = this.context();
    if (!audio || audio.currentTime >= this.startAt) return null;
    const elapsedTicks = Math.max(0, audio.currentTime - this.countInStartAt) * PPQ * this.tempoValue / 60;
    return ((DECK_TICKS - this.countInBeats * PPQ + elapsedTicks) % DECK_TICKS + DECK_TICKS) % DECK_TICKS;
  }

  position() {
    const audio = this.context();
    if (!audio || !this.recording) return null;
    const localTick = Math.floor(Math.max(0, this.tickAt(audio.currentTime))) % DECK_TICKS;
    return {
      bar: Math.floor(localTick / (PPQ * BEATS_PER_BAR)),
      beat: Math.floor((localTick % (PPQ * BEATS_PER_BAR)) / PPQ),
      tick: localTick,
    };
  }

  recordingTicks() {
    const audio = this.context();
    return audio && this.recording ? Math.max(0, this.tickAt(audio.currentTime)) : 0;
  }

  recordDrum(pad: number, velocity = 1, at = this.context()?.currentTime ?? 0) {
    const startTick = this.recordingTick(at);
    if (startTick === null || this.target !== 'drums') return;
    this.rawEvents.push({ kind: 'drum', pad, velocity, startTick });
  }

  recordNoteOn(instrument: NoteInstrument, key: string, pitch: number, velocity = 1, at = this.context()?.currentTime ?? 0) {
    const startTick = this.recordingTick(at);
    if (startTick === null || this.target !== instrument) return;
    this.activeNotes.set(key, { instrument, pitch, velocity, startTick });
  }

  recordNoteOff(instrument: NoteInstrument, key: string, at = this.context()?.currentTime ?? 0) {
    if (!this.recording || this.target !== instrument) return;
    const active = this.activeNotes.get(key);
    if (!active) return;
    this.rawEvents.push({ kind: 'note', ...active, endTick: Math.max(active.startTick, this.tickAt(Math.max(at, this.startAt))) });
    this.activeNotes.delete(key);
  }

  recordChordOn(key: string, symbol: string, pitches: number[], voicing: ChordEvent['voicing'] = 'root', at = this.context()?.currentTime ?? 0, velocity = 1) {
    const startTick = this.recordingTick(at);
    if (startTick === null || this.target !== 'chords') return;
    this.activeChords.set(key, { symbol, pitches: [...pitches], voicing, velocity, startTick });
  }

  recordChordOff(key: string, at = this.context()?.currentTime ?? 0) {
    if (!this.recording || this.target !== 'chords') return;
    const active = this.activeChords.get(key);
    if (!active) return;
    this.rawEvents.push({ kind: 'chord', ...active, endTick: Math.max(active.startTick, this.tickAt(Math.max(at, this.startAt))) });
    this.activeChords.delete(key);
  }

  buildTake(): RecordedTake | null {
    if (!this.recording) return null;
    const now = this.context()?.currentTime ?? this.startAt;
    this.activeNotes.forEach((_, key) => this.recordNoteOff(this.target as NoteInstrument, key, now));
    this.activeChords.forEach((_, key) => this.recordChordOff(key, now));
    this.recording = false;
    const events = this.rawEvents.map((event): RecordedTakeEvent => {
      if (event.kind === 'drum') return { id: eventId('recorded-drum'), startTick: quantizedStart(event.startTick, this.quantizeTicks), pad: event.pad, velocity: clampVelocity(event.velocity) };
      const durationTicks = quantizedDuration(event.startTick, event.endTick, this.quantizeTicks);
      const rawHeldTicks = Math.max(0, event.endTick - event.startTick);
      const articulation = clampArticulation(rawHeldTicks / durationTicks);
      if (event.kind === 'note') return { id: eventId('recorded-note'), startTick: quantizedStart(event.startTick, this.quantizeTicks), durationTicks, pitch: event.pitch, velocity: clampVelocity(event.velocity), articulation };
      return { id: eventId('recorded-chord'), startTick: quantizedStart(event.startTick, this.quantizeTicks), durationTicks, symbol: event.symbol, pitches: [...event.pitches], velocity: clampVelocity(event.velocity), voicing: event.voicing, articulation };
    });
    this.rawEvents = [];
    this.activeNotes.clear();
    this.activeChords.clear();
    return freezeTake({ instrument: this.target, mode: this.mode, events, count: events.length, quantizeTicks: this.quantizeTicks });
  }

  /** @deprecated Use buildTake and commit it through MusicController atomically. */
  commit() {
    return this.buildTake();
  }

  cancel() {
    this.recording = false;
    this.countInBeats = 0;
    this.rawEvents = [];
    this.activeNotes.clear();
    this.activeChords.clear();
  }

  private tickAt(at: number) {
    return Math.max(0, this.tickAnchor + (at - this.timeAnchor) * PPQ * this.tempoValue / 60);
  }

  private recordingTick(at: number) {
    if (!this.recording) return null;
    if (at < this.startAt) return this.startAt - at <= FIRST_BEAT_TOLERANCE_SECONDS ? 0 : null;
    return this.tickAt(at);
  }
}

export const quantizedStart = (tick: number, gridTicks = EIGHTH_NOTE_TICKS) => Math.round(tick / Math.max(1, gridTicks)) * Math.max(1, gridTicks);
export const quantizedDuration = (startTick: number, endTick: number, gridTicks = EIGHTH_NOTE_TICKS) => Math.max(gridTicks, quantizedStart(endTick, gridTicks) - quantizedStart(startTick, gridTicks));
export const ticksToSeconds = (ticks: number, tempo: number) => Math.max(0, ticks) * 60 / (PPQ * safeTempo(tempo));
export const playbackDurationSeconds = (durationTicks: number, articulation: number | undefined, tempo: number) => ticksToSeconds(durationTicks, tempo) * clampArticulation(articulation);

type DeckPlayback = {
  drum: (pad: number, velocity: number, at: number, profile?: DeckSoundProfile) => void;
  note: (instrument: NoteInstrument, pitch: number, velocity: number, duration: number, at: number, profile?: DeckSoundProfile) => void;
  chord: (pitches: number[], velocity: number, duration: number, at: number, profile?: DeckSoundProfile) => void;
  stop?: () => void;
};

export class DeckTransport {
  private timer: number | null = null;
  private nextTick = 0;
  private startAt = 0;
  private playing = false;
  private muted = new Set<DeckInstrument>();
  private tempoValue = 120;
  private timeAnchor = 0;
  private tickAnchor = 0;
  private hasAnchor = false;
  private readonly context: () => AudioContext | null;
  private readonly tempo: () => number;
  private readonly deck: SingleDeck;
  private readonly playback: DeckPlayback;

  constructor(context: () => AudioContext | null, tempo: () => number, deck: SingleDeck, playback: DeckPlayback) {
    this.context = context;
    this.tempo = tempo;
    this.deck = deck;
    this.playback = playback;
  }

  start(startAt?: number) {
    const audio = this.context();
    if (!audio) return false;
    this.stop();
    this.tempoValue = safeTempo(this.tempo());
    if (startAt !== undefined || !this.hasAnchor) {
      this.startAt = startAt ?? audio.currentTime + .05;
      this.timeAnchor = this.startAt;
      this.tickAnchor = 0;
      this.nextTick = 0;
    } else {
      this.startAt = audio.currentTime;
      this.timeAnchor = audio.currentTime;
      this.nextTick = Math.ceil((this.tickAnchor + .001) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
    }
    this.hasAnchor = true;
    this.playing = true;
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), SCHEDULER_INTERVAL_MS);
    return true;
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.hasAnchor = true;
    this.playback.stop?.();
  }

  retime(startAt?: number) {
    const audio = this.context();
    if (!audio || !this.playing) return;

    if (startAt !== undefined) this.startAt = startAt;
    this.playback.stop?.();
    if (audio.currentTime < this.startAt) {
      this.tempoValue = safeTempo(this.tempo());
      this.timeAnchor = this.startAt;
      this.tickAnchor = 0;
      this.nextTick = 0;
      this.schedule();
      return;
    }

    const currentTick = this.currentTick(audio.currentTime);
    this.tempoValue = safeTempo(this.tempo());
    this.timeAnchor = audio.currentTime;
    this.tickAnchor = currentTick;
    this.nextTick = Math.ceil((currentTick + .001) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
    this.schedule();
  }

  isPlaying() { return this.playing; }
  setMuted(instrument: DeckInstrument, muted: boolean) {
    if (muted) this.muted.add(instrument);
    else this.muted.delete(instrument);
  }

  position() {
    const audio = this.context();
    if (!audio || !this.playing) return { bar: 0, beat: 0, tick: 0 };
    const absoluteTick = Math.max(0, Math.floor(this.currentTick(audio.currentTime)));
    const localTick = absoluteTick % DECK_TICKS;
    return {
      bar: Math.floor(localTick / (PPQ * BEATS_PER_BAR)),
      beat: Math.floor((localTick % (PPQ * BEATS_PER_BAR)) / PPQ),
      tick: localTick,
    };
  }

  private schedule() {
    const audio = this.context();
    if (!audio || !this.playing) return;
    const targetTick = Math.max(0, Math.floor(this.currentTick(audio.currentTime + LOOKAHEAD_SECONDS) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS);
    const profiles = this.deck.soundProfiles();
    while (this.nextTick <= targetTick) {
      const at = this.timeAtTick(this.nextTick);
      const events = this.deck.eventsAt(this.nextTick);
      if (at >= audio.currentTime - .02) {
        if (!this.muted.has('drums')) events.drums.forEach((event) => this.playback.drum(event.pad, event.velocity, at, profiles.drums));
        if (!this.muted.has('bass')) {
          const bassEvent = events.bass[events.bass.length - 1];
          if (bassEvent) this.playback.note('bass', bassEvent.pitch, bassEvent.velocity, playbackDurationSeconds(bassEvent.durationTicks, bassEvent.articulation, this.tempoValue), at, profiles.bass);
        }
        if (!this.muted.has('lead')) events.lead.forEach((event) => this.playback.note('lead', event.pitch, event.velocity, playbackDurationSeconds(event.durationTicks, event.articulation, this.tempoValue), at, profiles.lead));
        if (!this.muted.has('chords')) events.chords.forEach((event) => this.playback.chord(event.pitches, event.velocity ?? 1, playbackDurationSeconds(event.durationTicks, event.articulation, this.tempoValue), at, profiles.chords));
      }
      this.nextTick += EIGHTH_NOTE_TICKS;
    }
  }

  private currentTick(at: number) {
    return this.tickAnchor + (at - this.timeAnchor) * PPQ * this.tempoValue / 60;
  }

  private timeAtTick(tick: number) {
    return this.timeAnchor + (tick - this.tickAnchor) * 60 / (PPQ * this.tempoValue);
  }
}

export type SharedDeckPlayback = {
  drum: (pad: number, velocity: number, at: number, profile: DeckSoundProfile | undefined, lane: 'deckA' | 'deckB') => void;
  note: (instrument: NoteInstrument, pitch: number, velocity: number, duration: number, at: number, profile: DeckSoundProfile | undefined, lane: 'deckA' | 'deckB') => void;
  chord: (pitches: number[], velocity: number, duration: number, at: number, profile: DeckSoundProfile | undefined, lane: 'deckA' | 'deckB') => void;
  stop?: () => void;
};

export type SharedDeckScheduleView = {
  events: ReturnType<SingleDeck['eventsAt']>;
  profiles: ReturnType<SingleDeck['soundProfiles']>;
};

/** One scheduler and one musical anchor for both four-bar decks. */
export class SharedDeckTransport {
  private timer: number | null = null;
  private nextTick = 0;
  private startAt = 0;
  private playing = false;
  private muted = new Set<DeckInstrument>();
  private tempoValue = 120;
  private timeAnchor = 0;
  private tickAnchor = 0;
  private hasAnchor = false;
  private readonly context: () => AudioContext | null;
  private readonly tempo: () => number;
  private readonly decks: { A: SingleDeck; B: SingleDeck };
  private readonly playback: SharedDeckPlayback;
  private readonly scheduleView?: (deckId: 'A' | 'B', absoluteTick: number, deck: SingleDeck) => SharedDeckScheduleView;
  private readonly onStart?: (startAt: number, tempo: number, tickAnchor: number) => void;
  private readonly onStop?: (at: number, tick: number) => void;

  constructor(
    context: () => AudioContext | null,
    tempo: () => number,
    decks: { A: SingleDeck; B: SingleDeck },
    playback: SharedDeckPlayback,
    options: { onStart?: (startAt: number, tempo: number, tickAnchor: number) => void; onStop?: (at: number, tick: number) => void; scheduleView?: (deckId: 'A' | 'B', absoluteTick: number, deck: SingleDeck) => SharedDeckScheduleView } = {},
  ) {
    this.context = context;
    this.tempo = tempo;
    this.decks = decks;
    this.playback = playback;
    this.onStart = options.onStart;
    this.onStop = options.onStop;
    this.scheduleView = options.scheduleView;
  }

  start(startAt?: number) {
    const audio = this.context();
    if (!audio) return false;
    this.stop();
    this.tempoValue = safeTempo(this.tempo());
    if (startAt !== undefined || !this.hasAnchor) {
      this.startAt = startAt ?? audio.currentTime + .05;
      this.timeAnchor = this.startAt;
      this.tickAnchor = 0;
      this.nextTick = 0;
    } else {
      this.startAt = audio.currentTime;
      this.timeAnchor = audio.currentTime;
      this.nextTick = Math.ceil((this.tickAnchor + .001) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
    }
    this.hasAnchor = true;
    this.playing = true;
    this.onStart?.(this.timeAnchor, this.tempoValue, this.tickAnchor);
    this.schedule();
    this.timer = window.setInterval(() => this.schedule(), SCHEDULER_INTERVAL_MS);
    return true;
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const wasPlaying = this.playing;
    const audio = this.context();
    const stoppedAt = audio?.currentTime ?? this.timeAnchor;
    const stoppedTick = wasPlaying ? this.currentTick(stoppedAt) : this.tickAnchor;
    this.playing = false;
    if (wasPlaying) this.playback.stop?.();
    if (wasPlaying) {
      this.timeAnchor = stoppedAt;
      this.tickAnchor = Math.max(0, stoppedTick);
      this.hasAnchor = true;
      this.onStop?.(stoppedAt, this.tickAnchor);
    }
  }

  retime(startAt?: number) {
    const audio = this.context();
    if (!audio || !this.playing) return;
    this.playback.stop?.();
    const requestedStart = startAt ?? this.startAt;
    const currentTick = this.currentTick(audio.currentTime);
    this.tempoValue = safeTempo(this.tempo());
    if (requestedStart > audio.currentTime) {
      this.startAt = requestedStart;
      this.timeAnchor = requestedStart;
      this.tickAnchor = 0;
      this.nextTick = 0;
    } else {
      this.startAt = audio.currentTime;
      this.timeAnchor = audio.currentTime;
      this.tickAnchor = Math.max(0, currentTick);
      this.nextTick = Math.ceil((this.tickAnchor + .001) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS;
    }
    this.onStart?.(this.timeAnchor, this.tempoValue, this.tickAnchor);
    this.schedule();
  }

  isPlaying() { return this.playing; }
  setMuted(instrument: DeckInstrument, muted: boolean) {
    if (muted) this.muted.add(instrument);
    else this.muted.delete(instrument);
  }

  position() {
    const audio = this.context();
    const absoluteTick = audio && this.playing ? this.currentTick(audio.currentTime) : this.tickAnchor;
    const localTick = Math.max(0, Math.floor(absoluteTick)) % DECK_TICKS;
    return {
      bar: Math.floor(localTick / (PPQ * BEATS_PER_BAR)),
      beat: Math.floor((localTick % (PPQ * BEATS_PER_BAR)) / PPQ),
      tick: localTick,
    };
  }

  anchor() { return { startAt: this.timeAnchor, tickAnchor: this.tickAnchor, tempo: this.tempoValue, playing: this.playing }; }

  private schedule() {
    const audio = this.context();
    if (!audio || !this.playing) return;
    const targetTick = Math.max(0, Math.floor(this.currentTick(audio.currentTime + LOOKAHEAD_SECONDS) / EIGHTH_NOTE_TICKS) * EIGHTH_NOTE_TICKS);
    (['A', 'B'] as const).forEach((deckId) => {
      const deck = this.decks[deckId];
      const lane = deckId === 'A' ? 'deckA' : 'deckB';
      for (let tick = this.nextTick; tick <= targetTick; tick += EIGHTH_NOTE_TICKS) {
        const localTick = tick % DECK_TICKS;
        const at = this.timeAtTick(tick);
        const view = this.scheduleView?.(deckId, tick, deck);
        const events = view?.events ?? deck.eventsAt(localTick);
        const profiles = view?.profiles ?? deck.soundProfiles();
        if (at < audio.currentTime - .02) continue;
        if (!this.muted.has('drums')) events.drums.forEach((event) => this.playback.drum(event.pad, event.velocity, at, profiles.drums, lane));
        if (!this.muted.has('bass')) {
          const bassEvent = events.bass[events.bass.length - 1];
          if (bassEvent) this.playback.note('bass', bassEvent.pitch, bassEvent.velocity, playbackDurationSeconds(bassEvent.durationTicks, bassEvent.articulation, this.tempoValue), at, profiles.bass, lane);
        }
        if (!this.muted.has('lead')) events.lead.forEach((event) => this.playback.note('lead', event.pitch, event.velocity, playbackDurationSeconds(event.durationTicks, event.articulation, this.tempoValue), at, profiles.lead, lane));
        if (!this.muted.has('chords')) events.chords.forEach((event) => this.playback.chord(event.pitches, event.velocity ?? 1, playbackDurationSeconds(event.durationTicks, event.articulation, this.tempoValue), at, profiles.chords, lane));
      }
    });
    this.nextTick = targetTick + EIGHTH_NOTE_TICKS;
  }

  private currentTick(at: number) { return this.tickAnchor + (at - this.timeAnchor) * PPQ * this.tempoValue / 60; }
  private timeAtTick(tick: number) { return this.timeAnchor + (tick - this.tickAnchor) * 60 / (PPQ * this.tempoValue); }
}
