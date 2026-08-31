import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadKeyboardLayout } from '../src/lead-keyboard.ts';

test('major lead layout keeps the existing white and black keyboard shape', () => {
  const layout = buildLeadKeyboardLayout(0, 'major');
  assert.deepEqual(layout.white.map((key) => key.midi), [60, 62, 64, 65, 67, 69, 71, 72, 74, 76]);
  assert.deepEqual(layout.white.map((key) => key.shortcut), ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/']);
  assert.deepEqual(layout.black.map((key) => key.position), [10, 20, 40, 50, 60, 80, 90]);
  assert.deepEqual(layout.black.map((key) => key.shortcut), ['s', 'd', 'g', 'h', 'j', 'l', ';']);
});

test('A minor puts the natural minor scale on the lead white keys', () => {
  const layout = buildLeadKeyboardLayout(9, 'minor');
  assert.deepEqual(layout.white.map((key) => key.midi), [69, 71, 72, 74, 76, 77, 79, 81, 83, 84]);
  assert.deepEqual(layout.black.map((key) => key.midi), [70, 73, 75, 78, 80, 82]);
});

test('D minor moves black keys into the natural-minor gaps and shares the pointer shortcut map', () => {
  const layout = buildLeadKeyboardLayout(2, 'minor');
  assert.deepEqual(layout.white.map((key) => key.midi), [62, 64, 65, 67, 69, 70, 72, 74, 76, 77]);
  assert.deepEqual(layout.black.map((key) => key.position), [10, 30, 40, 60, 70, 80]);
  assert.deepEqual(layout.black.map((key) => key.shortcut), ['s', 'f', 'g', 'j', 'k', 'l']);
  assert.equal(layout.shortcuts.includes('r'), false);
  [...layout.white, ...layout.black].forEach((key) => assert.equal(layout.midiByShortcut[key.shortcut], key.midi));
});
