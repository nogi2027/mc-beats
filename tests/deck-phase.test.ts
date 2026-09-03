import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_TICKS, EIGHTH_NOTE_TICKS } from '../src/deck.ts';
import { deckPhasePosition, deckPhaseTick } from '../src/deck-phase.ts';

test('deck phase uses the controller clock except during count-in', () => {
  assert.equal(deckPhaseTick(960, null), 960);
  assert.equal(deckPhaseTick(960, 5760), 5760);
  assert.deepEqual(deckPhasePosition(960), { bar: 0, beat: 2, tick: 960 });
  assert.deepEqual(deckPhasePosition(DECK_TICKS + EIGHTH_NOTE_TICKS), { bar: 0, beat: 0, tick: EIGHTH_NOTE_TICKS });
});

test('deck phase normalizes negative and fractional ticks safely', () => {
  assert.deepEqual(deckPhasePosition(-1), { bar: 3, beat: 3, tick: DECK_TICKS - 1 });
  assert.deepEqual(deckPhasePosition(960.9), { bar: 0, beat: 2, tick: 960 });
});
