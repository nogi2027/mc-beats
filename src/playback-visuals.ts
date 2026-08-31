import { BEATS_PER_BAR, DECK_TICKS, EIGHTH_NOTE_TICKS, PPQ, type DeckSnapshot } from './deck.ts';
import type { SoloState } from './music-types.ts';

export type VisualSource = {
  drums: Set<number>;
  bass: Set<number>;
  lead: Set<number>;
  chords: Set<string>;
};

export type PlaybackVisuals = { deck: VisualSource; solo: VisualSource };

const emptySource = (): VisualSource => ({ drums: new Set(), bass: new Set(), lead: new Set(), chords: new Set() });
const BAR_TICKS = PPQ * BEATS_PER_BAR;
const CYCLE_BARS = 24;
const wrappedElapsed = (now: number, start: number) => (now - start + DECK_TICKS) % DECK_TICKS;
const noteLength = (durationTicks: number, articulation = 1) => durationTicks * Math.min(1, Math.max(.05, articulation));
export const chordVisualKey = (pitches: number[]) => pitches.map((pitch) => ((pitch % 12) + 12) % 12).sort((a, b) => a - b).join('-');

const addDeck = (target: VisualSource, snapshot: DeckSnapshot, phaseTick: number) => {
  snapshot.events.drums.forEach((event) => {
    if (wrappedElapsed(phaseTick, event.startTick) < EIGHTH_NOTE_TICKS * .45) target.drums.add(event.pad);
  });
  snapshot.events.bass.forEach((event) => {
    if (wrappedElapsed(phaseTick, event.startTick) < noteLength(event.durationTicks, event.articulation)) target.bass.add(event.pitch);
  });
  snapshot.events.lead.forEach((event) => {
    if (wrappedElapsed(phaseTick, event.startTick) < noteLength(event.durationTicks, event.articulation)) target.lead.add(event.pitch);
  });
  snapshot.events.chords.forEach((event) => {
    if (wrappedElapsed(phaseTick, event.startTick) < noteLength(event.durationTicks, event.articulation)) target.chords.add(chordVisualKey(event.pitches));
  });
};

const addSolo = (target: VisualSource, solo: SoloState, absoluteTick: number) => {
  if (solo.status !== 'active') return;
  solo.events.forEach((event) => {
    const start = (event.start.cycle * CYCLE_BARS + event.start.bar) * BAR_TICKS + event.start.tick;
    const elapsed = absoluteTick - start;
    if (elapsed < 0) return;
    if (event.type === 'drum') {
      if (elapsed < EIGHTH_NOTE_TICKS * .45) target.drums.add(event.pad);
      return;
    }
    if (elapsed >= noteLength(event.durationTicks, event.articulation)) return;
    if (event.type === 'chord') target.chords.add(chordVisualKey(event.pitches));
    else target[event.instrument].add(event.pitch);
  });
};

export const playbackVisuals = ({ decks, phaseTick, absoluteTick, crossfadePosition, solo, playing }: {
  decks: Record<'A' | 'B', DeckSnapshot>;
  phaseTick: number;
  absoluteTick: number;
  crossfadePosition: number;
  solo: SoloState | null;
  playing: boolean;
}): PlaybackVisuals => {
  const result = { deck: emptySource(), solo: emptySource() };
  if (playing) {
    if (crossfadePosition < .995) addDeck(result.deck, decks.A, phaseTick);
    if (crossfadePosition > .005) addDeck(result.deck, decks.B, phaseTick);
  }
  if (solo) addSolo(result.solo, solo, absoluteTick);
  return result;
};
