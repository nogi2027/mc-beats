import { BEATS_PER_BAR, DECK_BARS, EIGHTH_NOTE_TICKS, PPQ, type DeckSoundProfile } from './deck.ts';
import { MUSIC_PRESETS, NOTE_NAMES, SCALE_INTERVALS } from './music-catalog.ts';
import type { AddDeckEvent, DeckPreparationTrack, MusicInstrument, RelativeSoloEvent } from './music-types.ts';
import { BASS_PRESETS } from './synth/patches/bass.ts';
import { CHORD_PRESETS } from './synth/patches/chords.ts';
import { DRUM_PRESET_OVERRIDES } from './synth/patches/drum-presets.ts';
import { normalizeDrumProfile } from './synth/patches/drums.ts';
import { LEAD_PRESETS } from './synth/patches/lead.ts';

export type SoundShorthand = {
  presetId?: string;
  controls?: Record<string, number>;
  parameters?: Record<string, number>;
  volume?: number;
  drumModel?: 'layered' | 'noisy' | 'electronic';
};

export type ProgressionBuildInput = {
  progression: Array<number | string>;
  drums?: 'none' | 'backbeat' | 'four-on-floor' | 'half-time';
  drumHits?: DrumHitShorthand[];
  bass?: 'none' | 'roots' | 'pulses';
  chords?: 'none' | 'sustained' | 'stabs';
  sounds?: Partial<Record<'drums' | 'bass' | 'chords', SoundShorthand>>;
};

export type DrumHitName = 'kick' | 'snare' | 'closed-hat' | 'open-hat' | 'clap' | 'low-tom' | 'high-tom' | 'perc' | 'rim' | 'shaker' | 'cowbell' | 'ride';
export type DrumHitShorthand = { bar: number; beat?: number; eighth?: 0 | 1; drum: DrumHitName; velocity?: number; id?: string };
export const DRUM_NAME_TO_PAD: Record<DrumHitName, number> = { kick: 0, snare: 1, 'closed-hat': 2, 'open-hat': 3, clap: 4, 'low-tom': 5, 'high-tom': 6, perc: 7, rim: 8, shaker: 9, cowbell: 10, ride: 11 };

export type ShorthandNote = {
  bar: number;
  beat?: number;
  eighth?: 0 | 1;
  degree: number | string;
  octave?: number;
  duration?: '1/8' | '1/4' | '1/2' | '1bar';
  velocity?: number;
  articulation?: number;
  id?: string;
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const profileTables: Partial<Record<MusicInstrument, DeckSoundProfile[]>> = { bass: BASS_PRESETS, chords: CHORD_PRESETS, lead: LEAD_PRESETS };
const romanDegrees: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };
const durationTicks: Record<NonNullable<ShorthandNote['duration']>, number> = { '1/8': EIGHTH_NOTE_TICKS, '1/4': PPQ, '1/2': PPQ * 2, '1bar': PPQ * BEATS_PER_BAR };

export const degreeNumber = (value: number | string) => {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 7 ? value : null;
  const text = value.trim().toLowerCase().replace(/[°º]/g, '');
  if (/^[1-7]$/.test(text)) return Number(text);
  return romanDegrees[text] ?? null;
};

const baseProfile = (instrument: MusicInstrument, presetId?: string): DeckSoundProfile | null => {
  if (instrument === 'drums') {
    const requested = presetId ?? MUSIC_PRESETS.drums[0];
    const override = DRUM_PRESET_OVERRIDES.find((candidate) => candidate.presetId.toLowerCase() === requested.toLowerCase());
    if (!override) return null;
    const base = clone(normalizeDrumProfile().profile) as DeckSoundProfile;
    return {
      ...base,
      ...clone(override),
      controls: { ...base.controls, ...override.controls },
      parameters: { ...base.parameters, ...override.parameters },
      drumModel: ['808', 'Circuit', 'Glitch'].includes(override.presetId) ? 'electronic' : base.drumModel,
    };
  }
  const table = profileTables[instrument];
  if (!table) return null;
  const requested = presetId ?? MUSIC_PRESETS[instrument][0];
  const profile = table.find((candidate) => candidate.presetId.toLowerCase() === requested.toLowerCase());
  return profile ? clone(profile) : null;
};

export const resolveSoundShorthand = (instrument: MusicInstrument, shorthand: SoundShorthand = {}) => {
  const profile = baseProfile(instrument, shorthand.presetId);
  if (!profile) return null;
  return {
    ...profile,
    controls: { ...profile.controls, ...shorthand.controls },
    parameters: { ...profile.parameters, ...shorthand.parameters },
    volume: shorthand.volume ?? profile.volume,
    ...(instrument === 'drums' ? { drumModel: shorthand.drumModel ?? profile.drumModel } : {}),
  } satisfies DeckSoundProfile;
};

const scaleOffset = (degree: number, mode: 'major' | 'minor') => SCALE_INTERVALS[mode][degree - 1];
const pitchForDegree = (degree: number, octave: number, root: number, mode: 'major' | 'minor') => 12 * (octave + 1) + root + scaleOffset(degree, mode);

const chordForDegree = (degree: number, root: number, mode: 'major' | 'minor', octave = 3) => {
  const scale = SCALE_INTERVALS[mode];
  const scalePitch = (index: number) => scale[index % 7] + Math.floor(index / 7) * 12;
  const rootOffset = scalePitch(degree - 1);
  const offsets = [rootOffset, scalePitch(degree + 1), scalePitch(degree + 3)];
  const intervals = offsets.map((offset) => offset - rootOffset);
  const quality = intervals[1] === 3 && intervals[2] === 6 ? 'dim' : intervals[1] === 3 ? 'm' : '';
  return {
    symbol: `${NOTE_NAMES[(root + rootOffset) % 12]}${quality}`,
    pitches: offsets.map((offset) => 12 * (octave + 1) + root + offset),
    rootPitch: 12 * 3 + root + rootOffset,
  };
};

const drumEvents = (pattern: NonNullable<ProgressionBuildInput['drums']>): AddDeckEvent[] => {
  if (pattern === 'none') return [];
  const events: AddDeckEvent[] = [];
  for (let bar = 0; bar < DECK_BARS; bar += 1) {
    const base = bar * PPQ * BEATS_PER_BAR;
    for (let eighth = 0; eighth < 8; eighth += 1) events.push({ type: 'drum', id: `recipe-hat-${bar}-${eighth}`, startTick: base + eighth * EIGHTH_NOTE_TICKS, pad: 2, velocity: eighth % 2 === 0 ? .55 : .38 });
    const kickBeats = pattern === 'four-on-floor' ? [0, 1, 2, 3] : pattern === 'half-time' ? [0, 2] : [0, 2];
    kickBeats.forEach((beat) => events.push({ type: 'drum', id: `recipe-kick-${bar}-${beat}`, startTick: base + beat * PPQ, pad: 0, velocity: .9 }));
    const snareBeats = pattern === 'half-time' ? [2] : [1, 3];
    snareBeats.forEach((beat) => events.push({ type: 'drum', id: `recipe-snare-${bar}-${beat}`, startTick: base + beat * PPQ, pad: 1, velocity: .82 }));
  }
  return events;
};

const compileDrumHits = (hits: DrumHitShorthand[] = []): AddDeckEvent[] | null => {
  const events: AddDeckEvent[] = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const beat = hit.beat ?? 1;
    const eighth = hit.eighth ?? 0;
    if (!Number.isInteger(hit.bar) || hit.bar < 1 || hit.bar > DECK_BARS || !Number.isInteger(beat) || beat < 1 || beat > BEATS_PER_BAR || (eighth !== 0 && eighth !== 1) || !(hit.drum in DRUM_NAME_TO_PAD) || (hit.velocity !== undefined && (!Number.isFinite(hit.velocity) || hit.velocity < 0 || hit.velocity > 1))) return null;
    events.push({ type: 'drum', id: hit.id ?? `recipe-drum-${index}`, startTick: (hit.bar - 1) * PPQ * BEATS_PER_BAR + (beat - 1) * PPQ + eighth * EIGHTH_NOTE_TICKS, pad: DRUM_NAME_TO_PAD[hit.drum], velocity: hit.velocity ?? .8 });
  }
  return events;
};

export const compileProgression = (input: ProgressionBuildInput, keyRoot: number, keyMode: 'major' | 'minor') => {
  if (!Array.isArray(input.progression) || input.progression.length < 1 || input.progression.length > DECK_BARS) return null;
  const supplied = input.progression.map(degreeNumber);
  if (supplied.some((degree) => degree === null)) return null;
  const degrees = Array.from({ length: DECK_BARS }, (_, index) => supplied[index % supplied.length]!) as number[];
  const chords = degrees.map((degree) => chordForDegree(degree, keyRoot, keyMode));
  const tracks: DeckPreparationTrack[] = [];
  const drumPattern = input.drums ?? 'backbeat';
  const customDrums = compileDrumHits(input.drumHits);
  if (!customDrums) return null;
  if (drumPattern !== 'none' || customDrums.length > 0) tracks.push({ instrument: 'drums', mode: 'replace', events: [...drumEvents(drumPattern), ...customDrums], profile: resolveSoundShorthand('drums', input.sounds?.drums) ?? undefined });
  const bassPattern = input.bass ?? 'roots';
  if (bassPattern !== 'none') {
    const events: AddDeckEvent[] = [];
    chords.forEach((chord, bar) => {
      const starts = bassPattern === 'pulses' ? [0, PPQ, PPQ * 2, PPQ * 3] : [0];
      starts.forEach((withinBar, index) => events.push({ type: 'note', id: `recipe-bass-${bar}-${index}`, instrument: 'bass', startTick: bar * PPQ * BEATS_PER_BAR + withinBar, durationTicks: bassPattern === 'pulses' ? PPQ : PPQ * BEATS_PER_BAR, pitch: chord.rootPitch, velocity: .75 }));
    });
    tracks.push({ instrument: 'bass', mode: 'replace', events, profile: resolveSoundShorthand('bass', input.sounds?.bass) ?? undefined });
  }
  const chordPattern = input.chords ?? 'sustained';
  if (chordPattern !== 'none') {
    const events: AddDeckEvent[] = [];
    chords.forEach((chord, bar) => {
      const starts = chordPattern === 'stabs' ? [0, PPQ * 2] : [0];
      starts.forEach((withinBar, index) => events.push({ type: 'chord', id: `recipe-chord-${bar}-${index}`, startTick: bar * PPQ * BEATS_PER_BAR + withinBar, durationTicks: chordPattern === 'stabs' ? PPQ : PPQ * BEATS_PER_BAR, symbol: chord.symbol, pitches: chord.pitches, velocity: chordPattern === 'stabs' ? .62 : .52, voicing: 'root' }));
    });
    tracks.push({ instrument: 'chords', mode: 'replace', events, profile: resolveSoundShorthand('chords', input.sounds?.chords) ?? undefined });
  }
  return { degrees, chords, tracks };
};

export const compileShorthandNotes = (notes: ShorthandNote[], instrument: 'bass' | 'lead', keyRoot: number, keyMode: 'major' | 'minor'): RelativeSoloEvent[] | null => {
  if (!Array.isArray(notes) || notes.length < 1 || notes.length > 256) return null;
  const compiled: RelativeSoloEvent[] = [];
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    const degree = degreeNumber(note.degree);
    const beat = note.beat ?? 1;
    const eighth = note.eighth ?? 0;
    const octave = note.octave ?? (instrument === 'bass' ? 2 : 4);
    const duration = note.duration ?? '1/8';
    if (!degree || !Number.isInteger(note.bar) || note.bar < 1 || note.bar > 24 || !Number.isInteger(beat) || beat < 1 || beat > BEATS_PER_BAR || (eighth !== 0 && eighth !== 1) || !Number.isInteger(octave) || octave < 0 || octave > 8 || !(duration in durationTicks) || (note.velocity !== undefined && (!Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1)) || (note.articulation !== undefined && (!Number.isFinite(note.articulation) || note.articulation < .05 || note.articulation > 1))) return null;
    const pitch = pitchForDegree(degree, octave, keyRoot, keyMode);
    if (pitch < 0 || pitch > 127) return null;
    compiled.push({ type: 'note', id: note.id ?? `recipe-solo-${index}`, offsetTicks: (note.bar - 1) * PPQ * BEATS_PER_BAR + (beat - 1) * PPQ + eighth * EIGHTH_NOTE_TICKS, instrument, durationTicks: durationTicks[duration], pitch, velocity: note.velocity ?? .8, articulation: note.articulation ?? .9 });
  }
  return compiled;
};
