import test from 'node:test';
import assert from 'node:assert/strict';
import { ENVELOPE_FIELDS, envelopeDisplayBounds, envelopeDisplayValue, envelopeParameterValue } from '../src/envelope-controls.ts';
import { envelopePath, envelopePreviewGeometry } from '../src/envelope-preview.ts';

test('envelope preview geometry stays finite and in bounds for valid and invalid values', () => {
  const inputs = [
    { attackMs: 5, decayMs: 480, sustainLevel: .65, releaseMs: 1200 },
    { attackMs: 0, decayMs: 0, sustainLevel: 0, releaseMs: 0 },
    { attackMs: Number.NaN, decayMs: Number.POSITIVE_INFINITY, sustainLevel: -2, releaseMs: -10 },
  ];
  for (const input of inputs) {
    const geometry = envelopePreviewGeometry(input, 240, 72);
    assert.equal(geometry.points.length, 5);
    assert.deepEqual(geometry.regions.map((region) => region.label), ['A', 'D', 'S', 'R']);
    for (const point of geometry.points) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= 0 && point.x <= geometry.width);
      assert.ok(point.y >= 0 && point.y <= geometry.height);
    }
    for (const region of geometry.regions) {
      assert.ok(Number.isFinite(region.x) && Number.isFinite(region.width));
      assert.ok(region.x >= 0 && region.x <= geometry.width);
      assert.ok(region.width >= 0 && region.x + region.width <= geometry.width + 1e-9);
    }
    assert.doesNotMatch(envelopePath(geometry), /NaN|Infinity/);
  }
});

test('envelope fields map to the shared parameter names and display units', () => {
  assert.deepEqual(ENVELOPE_FIELDS, [
    { key: 'attackMs', label: 'Attack', unit: 'ms' },
    { key: 'decayMs', label: 'Decay', unit: 'ms' },
    { key: 'sustainLevel', label: 'Sustain', unit: '%' },
    { key: 'releaseMs', label: 'Release', unit: 'ms' },
  ]);
  const parameter = { min: 0, max: 1, step: .01 };
  assert.deepEqual(envelopeDisplayBounds('sustainLevel', parameter), { min: 0, max: 100, step: 1 });
  assert.deepEqual(envelopeDisplayBounds('attackMs', { min: 1, max: 1200, step: 1 }), { min: 1, max: 1200, step: 1 });
  assert.equal(envelopeDisplayValue('sustainLevel', .65), 65);
  assert.equal(envelopeParameterValue('sustainLevel', 65), .65);
  assert.equal(envelopeParameterValue('attackMs', 180), 180);
});

test('envelope display conversion is reversible for each field', () => {
  for (const field of ENVELOPE_FIELDS) {
    const value = field.key === 'sustainLevel' ? .37 : 137;
    assert.equal(envelopeParameterValue(field.key, envelopeDisplayValue(field.key, value)), value);
  }
});
