import assert from 'node:assert/strict';
import test from 'node:test';
import { beginSwitchDirection, updateSwitchDirection } from '../src/switch-direction.ts';

test('switch direction follows meaningful movement and holds while static', () => {
  let state = beginSwitchDirection('A', 0);
  assert.equal(state.destination, 'B');
  state = updateSwitchDirection(state, .4);
  assert.equal(state.destination, 'B');
  state = updateSwitchDirection(state, .4);
  assert.equal(state.destination, 'B');
});

test('switch direction ignores small reversals but accepts movement through the dead zone', () => {
  let state = updateSwitchDirection(beginSwitchDirection('A', 0), .6);
  state = updateSwitchDirection(state, .59);
  assert.equal(state.destination, 'B');
  state = updateSwitchDirection(state, .58);
  assert.equal(state.destination, 'A');
  state = updateSwitchDirection(state, .59);
  assert.equal(state.destination, 'A');
  state = updateSwitchDirection(state, .6);
  assert.equal(state.destination, 'B');
});

test('a switch beginning on Deck B defaults toward Deck A', () => {
  assert.equal(beginSwitchDirection('B', 1).destination, 'A');
});
