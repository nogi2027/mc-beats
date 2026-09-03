import { BEATS_PER_BAR, DECK_TICKS, PPQ } from './deck.ts';

export type DeckPhasePosition = { bar: number; beat: number; tick: number };

/** Uses the controller's frozen phase except during a recorder count-in. */
export const deckPhaseTick = (clockPhaseTick: number, countInTick: number | null) => countInTick ?? clockPhaseTick;

export const deckPhasePosition = (tick: number): DeckPhasePosition => {
  const localTick = ((Math.floor(tick) % DECK_TICKS) + DECK_TICKS) % DECK_TICKS;
  return {
    bar: Math.floor(localTick / (PPQ * BEATS_PER_BAR)),
    beat: Math.floor((localTick % (PPQ * BEATS_PER_BAR)) / PPQ),
    tick: localTick,
  };
};
