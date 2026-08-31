import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS, measureReleaseBoundary, releaseDiagnosticSelfTest } from '../src/synth/release-diagnostic.ts';
import { VoiceEnvelope } from '../src/synth/envelope.ts';

test('release diagnostic detects an injected one-sample broadband fault', () => {
  const result = releaseDiagnosticSelfTest();
  assert.equal(result.detected, true);
  assert.equal(result.boundaryFault.detected, true);
  assert.equal(result.boundaryFault.boundaryPassed, false);
  assert.equal(result.boundaryFault.highBandPassed, true);
});

test('release diagnostic detects a short high-band burst independently of boundary detection', () => {
  const result = releaseDiagnosticSelfTest();
  assert.equal(result.highBandFault.detected, true);
  assert.equal(result.highBandFault.boundaryPassed, true);
  assert.equal(result.highBandFault.highBandPassed, false);
});

test('release diagnostic passes a quiet continuous waveform', () => {
  const sampleRate = 44_100;
  const samples = new Float32Array(sampleRate);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(2 * Math.PI * 110 * index / sampleRate) * .01;
  const result = measureReleaseBoundary(samples, .5, sampleRate, 'release-end');
  assert.equal(result.boundaryPassed, true);
  assert.equal(result.highBandPassed, true);
  assert.equal(result.highBandThreshold >= DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS.highBandAbsoluteFloor, true);
});

test('fallback release anchors the voice-local value continuously at sample boundaries', () => {
  const sampleRate = 44_100;
  const operations: Array<{ method: string; value?: number; start?: number; end?: number }> = [];
  const parameter = {
    setValueAtTime(value: number, start = 0) { operations.push({ method: 'setValueAtTime', value, start }); return this; },
    linearRampToValueAtTime(value: number, end = 0) { operations.push({ method: 'linearRampToValueAtTime', value, end }); return this; },
    cancelScheduledValues(start = 0) { operations.push({ method: 'cancelScheduledValues', start }); return this; },
  } as unknown as AudioParam;
  const envelope = new VoiceEnvelope(parameter);
  envelope.noteOn(0, { attackSeconds: .01, decaySeconds: .1, sustain: .65, releaseSeconds: .5 }, 1);
  const releaseAt = .25;
  const releaseDuration = .5;
  const before = envelope.valueAt(releaseAt - 1 / sampleRate);
  const at = envelope.valueAt(releaseAt);
  envelope.release(releaseAt, releaseDuration);
  const anchor = operations.find((operation) => operation.method === 'setValueAtTime' && operation.start === releaseAt)?.value;
  const after = at * (1 - (1 / sampleRate) / releaseDuration);
  assert.ok(anchor !== undefined);
  assert.ok(Math.abs(anchor - at) < 1e-12);
  assert.ok(Math.abs(at - before) < .01);
  assert.ok(after < at && after > 0);
  assert.ok(Math.abs((at - after) - at / (releaseDuration * sampleRate)) < 1e-12);
  assert.equal(envelope.valueAt(releaseAt + releaseDuration), 0);
});
