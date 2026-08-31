import assert from 'node:assert/strict';
import test from 'node:test';
import { DECK_TICKS, PPQ } from '../src/deck.ts';
import { PLATTER_COAST_MS, platterAngleDegrees, platterCoastTicks, platterResumeOffset, shortestPlatterOffset } from '../src/platter-motion.ts';

test('platter maps one four-bar loop to one clockwise visual cycle', () => {
  assert.equal(platterAngleDegrees(0), 0);
  assert.equal(platterAngleDegrees(PPQ * 4), -90);
  assert.equal(platterAngleDegrees(DECK_TICKS), 0);
});

test('platter pause coast follows the configured triangular ramp', () => {
  const coastDistance = PPQ * 120 / 60_000 * PLATTER_COAST_MS / 2;
  assert.equal(platterCoastTicks(0, 120), 0);
  assert.equal(platterCoastTicks(PLATTER_COAST_MS, 120), coastDistance);
  assert.equal(platterCoastTicks(PLATTER_COAST_MS * 2, 120), coastDistance);
});

test('platter resume consumes a completed coast offset without reversing', () => {
  const coastOffset = platterCoastTicks(PLATTER_COAST_MS, 120);
  assert.equal(platterResumeOffset(coastOffset, 0, PLATTER_COAST_MS, 120), coastOffset);
  assert.equal(platterResumeOffset(coastOffset, PLATTER_COAST_MS / 2, PLATTER_COAST_MS, 120), coastOffset / 4);
  assert.equal(platterResumeOffset(coastOffset, PLATTER_COAST_MS, PLATTER_COAST_MS, 120), 0);
  const ticksPerMs = PPQ * 120 / 60_000;
  const firstFrameMovement = ticksPerMs + platterResumeOffset(coastOffset, 1, PLATTER_COAST_MS, 120) - coastOffset;
  assert.ok(firstFrameMovement >= 0);
});

test('platter resume preserves the current speed during an interrupted coast', () => {
  const coastElapsed = PLATTER_COAST_MS / 2;
  const coastOffset = platterCoastTicks(coastElapsed, 120);
  const ticksPerMs = PPQ * 120 / 60_000;
  const firstFrameMovement = ticksPerMs + platterResumeOffset(coastOffset, 1, coastElapsed, 120) - coastOffset;
  const expectedMovement = ticksPerMs * (1 - coastElapsed / PLATTER_COAST_MS);
  assert.ok(Math.abs(firstFrameMovement - expectedMovement) < .01);
});

test('platter resume chooses the short offset across the loop boundary', () => {
  assert.equal(shortestPlatterOffset(DECK_TICKS - 40, 20), -60);
  assert.equal(shortestPlatterOffset(20, DECK_TICKS - 40), 60);
});

test('recording rewind begins at the current visual angle', () => {
  const currentTick = 871;
  const countInTick = DECK_TICKS - PPQ * 4;
  const offset = shortestPlatterOffset(currentTick, countInTick);
  assert.equal(platterAngleDegrees(countInTick + offset), platterAngleDegrees(currentTick));
});
