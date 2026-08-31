import assert from 'node:assert/strict';
import test from 'node:test';
import { skipMissedMetronomeBeats } from '../src/metronome-scheduler.ts';

test('metronome scheduler drops a delayed timer backlog while preserving beat phase', () => {
  const recovered = skipMissedMetronomeBeats({ beat: 1, nextBeat: .5 }, 3.1, .5);
  assert.deepEqual(recovered, { beat: 7, nextBeat: 3.5 });
  assert.equal(recovered.beat % 4, 3);
});

test('metronome scheduler keeps the next future beat unchanged', () => {
  const position = { beat: 4, nextBeat: 2.5 };
  assert.equal(skipMissedMetronomeBeats(position, 2.4, .5), position);
});
