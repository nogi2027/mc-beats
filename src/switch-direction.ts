import type { DeckId } from './music-types.ts';

export const SWITCH_DIRECTION_DEAD_ZONE = .02;

export type SwitchDirectionState = { destination: DeckId; extreme: number };

export const beginSwitchDirection = (activeDeck: DeckId, value: number): SwitchDirectionState => ({
  destination: activeDeck === 'A' ? 'B' : 'A',
  extreme: value,
});

export const updateSwitchDirection = (state: SwitchDirectionState, value: number, deadZone = SWITCH_DIRECTION_DEAD_ZONE): SwitchDirectionState => {
  if (state.destination === 'B') {
    const high = Math.max(state.extreme, value);
    return value <= high - deadZone ? { destination: 'A', extreme: value } : { destination: 'B', extreme: high };
  }
  const low = Math.min(state.extreme, value);
  return value >= low + deadZone ? { destination: 'B', extreme: value } : { destination: 'A', extreme: low };
};
