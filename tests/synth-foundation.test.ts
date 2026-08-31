import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioEngine } from '../src/synth/contract.ts';
import { LegacySynthEngine } from '../src/audio.ts';
import { VoiceEnvelope, envelopeStageAt, envelopeValueAt, safeAutomationTime, MIN_GAIN_TRANSITION_SECONDS, scheduleSmoothFade, smoothstepValueAt } from '../src/synth/envelope.ts';
import { SynthVoice, sourceStopGuardSeconds } from '../src/synth/voice.ts';
import { VoiceGroup } from '../src/synth/voice-group.ts';
import { VoicePool } from '../src/synth/voice-pool.ts';
import { ProfileBus } from '../src/synth/profile-bus.ts';

type Operation = { method: string; value?: number; start?: number; end?: number };
class Param {
  value = 0;
  operations: Operation[] = [];
  setValueAtTime(value: number, start = 0) { this.value = value; this.operations.push({ method: 'setValueAtTime', value, start }); return this; }
  linearRampToValueAtTime(value: number, end = 0) { this.value = value; this.operations.push({ method: 'linearRampToValueAtTime', value, end }); return this; }
  cancelAndHoldAtTime(start = 0) { this.operations.push({ method: 'cancelAndHoldAtTime', start }); return this; }
  cancelScheduledValues(start = 0) { this.operations.push({ method: 'cancelScheduledValues', start }); return this; }
}
class Node {
  gain = new Param();
  disconnectCount = 0;
  connect() { return this; }
  disconnect() { this.disconnectCount += 1; }
}
class Source extends Node {
  listeners: Array<() => void> = [];
  stops: number[] = [];
  start() {}
  stop(at = 0) { this.stops.push(at); }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.push(listener); }
  end() { this.listeners.forEach((listener) => listener()); }
}
class BrowserStrictSource extends Source {
  started = false;
  rejectedStops = 0;
  override start() { this.started = true; }
  override stop(at = 0) {
    if (!this.started) {
      this.rejectedStops += 1;
      throw new Error('InvalidStateError: cannot stop an unstarted source');
    }
    super.stop(at);
  }
}

const gain = () => new Node() as unknown as GainNode;
const source = () => new Source() as unknown as AudioScheduledSourceNode;

test('LegacySynthEngine remains directly runnable and satisfies AudioEngine', () => {
  const engine: AudioEngine = new LegacySynthEngine();
  assert.equal(typeof engine.start, 'function');
  assert.equal(typeof engine.note, 'function');
  engine.dispose();
});

test('VoiceEnvelope models attack, decay, sustain, and release without a reset', () => {
  const parameter = new Param() as unknown as AudioParam;
  const envelope = new VoiceEnvelope(parameter);
  envelope.noteOn(1, { attackSeconds: .1, decaySeconds: .2, sustain: .5, releaseSeconds: .3 }, .8);
  assert.equal(envelopeStageAt(.05, { attackSeconds: .1, decaySeconds: .2, sustain: .5, releaseSeconds: .3 }), 'attack');
  assert.equal(envelopeStageAt(.15, { attackSeconds: .1, decaySeconds: .2, sustain: .5, releaseSeconds: .3 }), 'decay');
  assert.equal(envelopeStageAt(.4, { attackSeconds: .1, decaySeconds: .2, sustain: .5, releaseSeconds: .3 }), 'sustain');
  assert.ok(envelopeValueAt(1, 1.05, { attackSeconds: .1, decaySeconds: .2, sustain: .5, releaseSeconds: .3 }) > 0);
  const release = envelope.release(1.4, .3)!;
  assert.deepEqual(release, { start: 1.4, end: 1.7 });
  assert.equal(envelope.valueAt(1.7), 0);
  const operationCount = parameter.operations.length;
  assert.deepEqual(envelope.release(1.5, .3), release);
  assert.equal(parameter.operations.length, operationCount);
  assert.equal(parameter.operations.some((operation) => operation.method === 'setValueCurveAtTime'), false);
});

test('VoiceEnvelope handles zero, invalid, late, and choke transitions safely', () => {
  const parameter = new Param() as unknown as AudioParam;
  const envelope = new VoiceEnvelope(parameter);
  envelope.noteOn(0, { attackSeconds: Number.NaN, decaySeconds: 0, sustain: 1, releaseSeconds: Number.NaN });
  const release = envelope.choke(.001, 0);
  assert.ok(release && release.end > release.start);
  assert.ok(parameter.operations.some((operation) => operation.method === 'cancelAndHoldAtTime'));
  assert.equal(safeAutomationTime(0, 1, 48000, true).scheduledAt, 1 + 256 / 48000);
});

test('safeAutomationTime reports only the actual shift at 44.1 and 48 kHz', () => {
  for (const sampleRate of [44100, 48000]) {
    const immediate = safeAutomationTime(1, 1, sampleRate, true);
    assert.equal(immediate.scheduledAt, 1 + 256 / sampleRate);
    assert.ok(Math.abs(immediate.safetyOffsetSeconds - 256 / sampleRate) < 1e-12);
    const slightlyLate = safeAutomationTime(1.001, 1, sampleRate, true);
    assert.equal(slightlyLate.scheduledAt, 1 + 256 / sampleRate);
    assert.ok(Math.abs(slightlyLate.safetyOffsetSeconds - (256 / sampleRate - .001)) < 1e-12);
    const future = safeAutomationTime(2, 1, sampleRate, true);
    assert.equal(future.scheduledAt, 2);
    assert.equal(future.safetyOffsetSeconds, 0);
  }
});

test('SynthVoice state follows future onset and note-off times', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const voice = new SynthVoice({ id: 'future-state', instrument: 'bass', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  const src = source();
  voice.addSource(src, 5);
  voice.start(5, { attackSeconds: .01, decaySeconds: .02, sustain: .7, releaseSeconds: .1 });
  voice.release(5.2, .1);
  assert.equal(voice.state, 'scheduled');
  context.currentTime = 5.1;
  assert.equal(voice.state, 'active');
  context.currentTime = 5.2;
  assert.equal(voice.state, 'releasing');
});

test('VoicePool evaluates future intervals at the proposed audio time', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 1 });
  const make = (id: string, start: number, gate?: number) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'deckA', profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), start);
    voice.start(start, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
    if (gate !== undefined) voice.release(start + gate, .1);
    return voice;
  };
  const first = make('future-first', 5, .1);
  const second = make('future-second', 10);
  assert.equal(pool.tryAdd(first).status, 'accepted');
  assert.equal(pool.tryAdd(second).status, 'accepted');
  assert.equal(pool.allocatedCount('lead', 'deckA', 0), 0);
  assert.equal(pool.scheduledCount('lead', 'deckA', 0), 2);
  assert.equal(pool.allocatedCount('lead', 'deckA', 5), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 5.2), 0);
  assert.equal(pool.retainedTailCount('lead', 'deckA', 5.2), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 10), 1);
});

test('VoicePool supports out-of-order future scheduling without dropping notes', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 1 });
  const make = (id: string, start: number, gate: number) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'deckA', profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), start);
    voice.start(start, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
    voice.release(start + gate, .1);
    return voice;
  };
  assert.equal(pool.tryAdd(make('late', 10, .1)).status, 'accepted');
  assert.equal(pool.tryAdd(make('early', 5, .1)).status, 'accepted');
  assert.equal(pool.allocatedCount('lead', 'deckA', 5), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 10), 1);
});

test('future forced victims stay active until their scheduled choke time', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 1 });
  const make = (id: string, start: number) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'deckA', profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), start);
    voice.start(start, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
    return voice;
  };
  const first = make('scheduled-victim', 5);
  assert.equal(pool.tryAdd(first).status, 'accepted');
  assert.equal(pool.tryAdd(make('scheduled-replacement', 10)).status, 'accepted');
  assert.equal(pool.forcedRetiringCount('lead', 'deckA', 0), 0);
  assert.equal(first.stateAt(9), 'active');
  assert.equal(pool.forcedRetiringCount('lead', 'deckA', 9), 0);
  assert.equal(first.stateAt(10), 'releasing');
  assert.equal(pool.forcedRetiringCount('lead', 'deckA', 10), 1);
});

test('out-of-order overlapping future intervals stay within the musical limit', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const make = (id: string, startAt: number, gate: number | null) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'deckA', profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), startAt);
    voice.start(startAt, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .5 });
    if (gate !== null) voice.release(startAt + gate, .5);
    return voice;
  };
  const pool = new VoicePool({ lead: 1 }, { lead: 4 });
  const late = make('overlap-late', 10, null);
  const early = make('overlap-early', 5, null);
  assert.equal(pool.tryAdd(late).status, 'accepted');
  assert.equal(pool.tryAdd(early).status, 'accepted');
  assert.equal(pool.allocatedCount('lead', 'deckA', 5), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 10), 1);
  assert.equal(pool.forcedRetiringCount('lead', 'deckA', 10), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 10.012), 1);
});

test('reverse insertion order gives the same bounded result for overlapping intervals', () => {
  const run = (firstStart: number, secondStart: number) => {
    const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
    const pool = new VoicePool({ lead: 1 }, { lead: 4 });
    const make = (id: string, startAt: number) => {
      const voice = new SynthVoice({ id, instrument: 'lead', lane: 'deckA', profile: { fingerprint: id }, finalGain: gain(), context });
      voice.addSource(source(), startAt);
      voice.start(startAt, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .5 });
      return voice;
    };
    const first = make('reverse-first', firstStart);
    const second = make('reverse-second', secondStart);
    const firstResult = pool.tryAdd(first);
    const secondResult = pool.tryAdd(second);
    return { firstResult, secondResult, pool };
  };
  const lateThenEarly = run(10, 5);
  const earlyThenLate = run(5, 10);
  assert.equal(lateThenEarly.firstResult.status, 'accepted');
  assert.equal(lateThenEarly.secondResult.status, 'accepted');
  assert.equal(earlyThenLate.firstResult.status, 'accepted');
  assert.equal(earlyThenLate.secondResult.status, 'accepted');
  for (const result of [lateThenEarly, earlyThenLate]) {
    assert.equal(result.pool.allocatedCount('lead', 'deckA', 5), 1);
    assert.equal(result.pool.allocatedCount('lead', 'deckA', 10), 1);
    assert.equal(result.pool.forcedRetiringCount('lead', 'deckA', 10), 1);
  }
});

test('staggered out-of-order intervals stay within the limit at every boundary', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 2 }, { lead: 8 });
  const voices = [
    ['stagger-late', 10, .4],
    ['stagger-early', 5, 7],
    ['stagger-middle', 8, 2],
  ].map(([id, startAt, gate]) => {
    const voice = new SynthVoice({ id: String(id), instrument: 'lead', lane: 'deckA', profile: { fingerprint: String(id) }, finalGain: gain(), context });
    voice.addSource(source(), Number(startAt));
    voice.start(Number(startAt), { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .5 });
    voice.release(Number(startAt) + Number(gate), .5);
    return voice;
  });
  voices.forEach((voice) => assert.equal(pool.tryAdd(voice).status, 'accepted'));
  const boundaries = [...new Set(voices.flatMap((voice) => [voice.timing.startAt, voice.timing.noteOffAt ?? 0, voice.timing.releaseEndAt ?? 0, voice.timing.stopAt ?? 0]))]
    .filter((time) => time >= 0)
    .sort((left, right) => left - right);
  boundaries.forEach((time) => assert.ok(pool.allocatedCount('lead', 'deckA', time) <= 2, `capacity exceeded at ${time}`));
  assert.equal(pool.allocatedCount('lead', 'deckA', 10), 2);
});

test('long effect tails do not block a later non-overlapping note', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 1 }, { lead: 1 });
  const first = new SynthVoice({ id: 'tail-first', instrument: 'lead', lane: 'deckA', profile: { fingerprint: 'first' }, finalGain: gain(), context });
  first.setEffectTailSeconds(2);
  first.addSource(source(), 0);
  first.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
  first.release(0, .1);
  assert.equal(pool.tryAdd(first).status, 'accepted');
  const second = new SynthVoice({ id: 'tail-second', instrument: 'lead', lane: 'deckA', profile: { fingerprint: 'second' }, finalGain: gain(), context });
  second.addSource(source(), 1);
  second.start(1, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
  assert.equal(pool.tryAdd(second).status, 'accepted');
  assert.equal(pool.retainedTailCount('lead', 'deckA', 1), 1);
  assert.equal(pool.allocatedCount('lead', 'deckA', 1), 1);
});

test('a short choke replaces a future natural effect-tail deadline', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const voice = new SynthVoice({ id: 'tail-choke', instrument: 'lead', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  voice.setEffectTailSeconds(3);
  voice.addSource(source(), 0);
  voice.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .5 });
  voice.release(.1, .5);
  const naturalCleanup = voice.cleanupAt;
  voice.choke(.2, .012);
  assert.ok(voice.cleanupAt < naturalCleanup);
  assert.equal(voice.timing.noteOffAt, .2);
  assert.ok(Math.abs((voice.timing.releaseEndAt ?? 0) - .212) < 1e-12);
});

test('a suspended audio clock cannot finish a retained voice early', () => {
  const context = { currentTime: 0, sampleRate: 48000, state: 'suspended' } as unknown as BaseAudioContext;
  const finalGain = gain();
  const voice = new SynthVoice({ id: 'suspended-tail', instrument: 'lead', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain, context });
  const src = source();
  voice.addSource(src, 0);
  voice.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: .7, releaseSeconds: .1 });
  voice.release(0, .012);
  (src as unknown as Source).end();
  voice.finishIfSilent(0);
  assert.equal((finalGain as unknown as Node).disconnectCount, 0);
  (context as unknown as { currentTime: number }).currentTime = voice.cleanupAt + .001;
  voice.finishIfSilent((context as unknown as { currentTime: number }).currentTime);
  assert.equal((finalGain as unknown as Node).disconnectCount, 1);
});

test('a future voice choked before onset never becomes audible and still cleans up', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const finalGain = gain();
  const voice = new SynthVoice({ id: 'future-choke', instrument: 'bass', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain, context });
  const src = source();
  voice.addSource(src, 5);
  voice.start(5, { attackSeconds: .01, decaySeconds: .02, sustain: .7, releaseSeconds: .1 });
  voice.choke(4.5, .012);
  assert.equal(voice.state, 'scheduled');
  context.currentTime = 5;
  assert.equal(voice.isAudible, false);
  (src as unknown as Source).end();
  assert.equal(voice.state, 'stopped');
  assert.equal((finalGain as unknown as Node).disconnectCount, 1);
});

test('zero, negative, and invalid gain stages use a real minimum transition', () => {
  for (const attackSeconds of [0, -1, Number.NaN]) {
    const parameter = new Param() as unknown as AudioParam;
    const envelope = new VoiceEnvelope(parameter);
    envelope.noteOn(0, { attackSeconds, decaySeconds: 0, sustain: .5, releaseSeconds: .1 }, 1);
    const attack = parameter.operations.find((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1);
    assert.ok(attack && (attack.end ?? 0) >= MIN_GAIN_TRANSITION_SECONDS);
  }
  const parameter = new Param() as unknown as AudioParam;
  const envelope = new VoiceEnvelope(parameter);
  envelope.noteOn(0, { attackSeconds: .01, decaySeconds: 0, sustain: .5, releaseSeconds: .1 }, 1);
  const ramps = parameter.operations.filter((operation) => operation.method === 'linearRampToValueAtTime');
  assert.ok((ramps[1]?.end ?? 0) - (ramps[0]?.end ?? 0) >= MIN_GAIN_TRANSITION_SECONDS - 1e-12);
});

test('VoiceEnvelope releases during attack, decay, and sustain with native cancellation', () => {
  for (const releaseAt of [.002, .02, .2]) {
    const parameter = new Param() as unknown as AudioParam;
    const envelope = new VoiceEnvelope(parameter);
    envelope.noteOn(0, { attackSeconds: .01, decaySeconds: .08, sustain: .6, releaseSeconds: .2 }, .9);
    const before = envelope.valueAt(releaseAt);
    const release = envelope.release(releaseAt, .2)!;
    assert.ok(before >= 0 && before <= .9);
    assert.equal(release.start, releaseAt);
    assert.equal(envelope.stageAt(releaseAt), 'release');
    assert.equal(envelope.stageAt(release.end), 'silence');
    assert.equal(envelope.valueAt(release.end), 0);
    assert.equal(parameter.operations.filter((operation) => operation.method === 'cancelAndHoldAtTime').length, 1);
  }
});

test('VoiceEnvelope uses the voice-local anchor when cancelAndHoldAtTime is unavailable', () => {
  const operations: Array<{ method: string; value?: number; start?: number }> = [];
  const fallback = {
    value: 0,
    setValueAtTime(value: number, start = 0) { this.value = value; operations.push({ method: 'setValueAtTime', value, start }); return this; },
    linearRampToValueAtTime(value: number, end = 0) { this.value = value; operations.push({ method: 'linearRampToValueAtTime', value, start: end }); return this; },
    cancelScheduledValues(start = 0) { operations.push({ method: 'cancelScheduledValues', start }); return this; },
  } as unknown as AudioParam;
  const envelope = new VoiceEnvelope(fallback);
  envelope.noteOn(0, { attackSeconds: .01, decaySeconds: .1, sustain: .5, releaseSeconds: .2 }, 1);
  const expected = envelope.valueAt(.03);
  envelope.release(.03, .2);
  assert.equal(envelope.valueAt(.03), expected);
  assert.equal(operations.find((operation) => operation.method === 'setValueAtTime' && operation.start === .03)?.value, expected);
  assert.equal('cancelAndHoldAtTime' in (fallback as unknown as object), false);
});

test('VoiceEnvelope uses native hold plus a C1 release curve without a model anchor jump', () => {
  const operations: Array<{ method: string; values?: Float32Array; start?: number; duration?: number; value?: number }> = [];
  const parameter = {
    value: 0,
    setValueAtTime(value: number, start = 0) { operations.push({ method: 'setValueAtTime', value, start }); return this; },
    linearRampToValueAtTime(value: number, end = 0) { operations.push({ method: 'linearRampToValueAtTime', value, start: end }); return this; },
    cancelAndHoldAtTime(start = 0) { operations.push({ method: 'cancelAndHoldAtTime', start }); return this; },
    cancelScheduledValues(start = 0) { operations.push({ method: 'cancelScheduledValues', start }); return this; },
    setValueCurveAtTime(values: Float32Array, start = 0, duration = 0) { operations.push({ method: 'setValueCurveAtTime', values, start, duration }); return this; },
  } as unknown as AudioParam;
  const envelope = new VoiceEnvelope(parameter);
  envelope.noteOn(0, { attackSeconds: .01, decaySeconds: .08, sustain: .6, releaseSeconds: .2 }, .9);
  const from = envelope.valueAt(.2);
  envelope.release(.2, .2);
  const curve = operations.find((operation) => operation.method === 'setValueCurveAtTime')?.values;
  assert.ok(curve);
  assert.equal(operations.filter((operation) => operation.method === 'cancelAndHoldAtTime').length, 1);
  assert.equal(operations.some((operation) => operation.method === 'setValueAtTime' && operation.start === .2), false);
  assert.ok(Math.abs(curve[0] - from) < 1e-6);
  assert.equal(curve[curve.length - 1], 0);
  assert.ok(curve[1] - curve[0] < .002);
  assert.ok(curve[curve.length - 1] - curve[curve.length - 2] > -.002);
  assert.equal(smoothstepValueAt(from, 0, .2, .4, .2), from);
  assert.equal(smoothstepValueAt(from, 0, .2, .4, .4), 0);
});

test('scheduleSmoothFade falls back safely when a browser rejects a replacement curve', () => {
  const operations: string[] = [];
  const parameter = {
    cancelAndHoldAtTime() { operations.push('cancelAndHoldAtTime'); return this; },
    cancelScheduledValues() { operations.push('cancelScheduledValues'); return this; },
    setValueAtTime() { operations.push('setValueAtTime'); return this; },
    linearRampToValueAtTime() { operations.push('linearRampToValueAtTime'); return this; },
    setValueCurveAtTime() { operations.push('setValueCurveAtTime'); throw new Error('overlapping curve'); },
  } as unknown as AudioParam;

  assert.doesNotThrow(() => {
    const result = scheduleSmoothFade(parameter, 2, .02, .7, 0);
    assert.equal(result.usedCancelAndHold, true);
    assert.equal(result.usedCurve, false);
  });
  assert.deepEqual(operations, ['cancelAndHoldAtTime', 'setValueCurveAtTime', 'cancelScheduledValues', 'setValueAtTime', 'linearRampToValueAtTime']);
});

test('SynthVoice starts silent, releases to zero, and waits for render-quantum guard', () => {
  let stopped = 0;
  const fakeContext = { currentTime: 2, sampleRate: 48000 } as unknown as BaseAudioContext;
  const finalGain = gain();
  const voice = new SynthVoice({ id: 'voice-1', instrument: 'bass', lane: 'live', profile: { fingerprint: 'p' }, finalGain, context: fakeContext, onStopped: () => { stopped += 1; } });
  const first = source();
  const second = source();
  voice.addSource(first, 2);
  voice.addSource(second, 2);
  assert.equal((finalGain as unknown as Node).gain.value, 0);
  voice.start(2, { attackSeconds: .01, decaySeconds: .02, sustain: .7, releaseSeconds: .1 }, 1);
  const release = voice.release(2, .1)!;
  assert.equal(voice.state, 'releasing');
  assert.equal(voice.timing.stopAt, release.end + sourceStopGuardSeconds(48000));
  assert.equal((first as unknown as Source).stops[0], voice.timing.stopAt);
  (first as unknown as Source).end();
  assert.equal(voice.state, 'releasing');
  (second as unknown as Source).end();
  (fakeContext as unknown as { currentTime: number }).currentTime = release.end + .001;
  voice.finishIfSilent((fakeContext as unknown as { currentTime: number }).currentTime);
  assert.equal(voice.state, 'stopped');
  assert.equal(stopped, 1);
  voice.dispose();
  voice.dispose();
  assert.equal(stopped, 1);
});

test('SynthVoice reapplies a finite stop after browser-style stop-before-start rejection', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const voice = new SynthVoice({ id: 'strict-order', instrument: 'metronome', lane: 'independent', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  const src = new BrowserStrictSource();
  voice.addSource(src as unknown as AudioScheduledSourceNode, 0);
  voice.start(0, { attackSeconds: .001, decaySeconds: .001, sustain: 1, releaseSeconds: .01 });
  voice.release(.02, .01);

  assert.equal(src.rejectedStops, 1);
  assert.deepEqual(src.stops, []);
  voice.startSources(0);
  assert.deepEqual(src.stops, [voice.timing.stopAt]);
});

test('browser-style finite sources leave the pool instead of exhausting retained tails', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool();

  for (let index = 0; index < 80; index += 1) {
    context.currentTime = index;
    const voice = new SynthVoice({ id: `finite-${index}`, instrument: 'drums', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain: gain(), context });
    const src = new BrowserStrictSource();
    voice.addSource(src as unknown as AudioScheduledSourceNode, index);
    voice.start(index, { attackSeconds: .001, decaySeconds: .001, sustain: 1, releaseSeconds: .01 });
    voice.release(index + .02, .01);
    assert.equal(pool.tryAdd(voice).status, 'accepted');
    voice.startSources(index);
    context.currentTime = voice.cleanupAt + .001;
    src.end();
    assert.equal(pool.retainedCount('drums', 'deckA'), 0);
  }
});

test('live release is moved two render quanta ahead while future release keeps its boundary', () => {
  const context = { currentTime: 3, sampleRate: 44100 } as unknown as BaseAudioContext;
  const live = new SynthVoice({ id: 'live-release', instrument: 'bass', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  live.addSource(source(), 3);
  live.start(3, { attackSeconds: .01, decaySeconds: .02, sustain: .7, releaseSeconds: .2 });
  const liveRelease = live.release(3, .2, true)!;
  assert.equal(liveRelease.start, 3 + (256 / 44100));
  assert.equal(liveRelease.end, 3 + (256 / 44100) + .2);

  const deck = new SynthVoice({ id: 'deck-release', instrument: 'bass', lane: 'deckA', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  deck.addSource(source(), 4);
  deck.start(4, { attackSeconds: .01, decaySeconds: .02, sustain: .7, releaseSeconds: .2 });
  const deckRelease = deck.release(4, .2, false)!;
  assert.equal(deckRelease.start, 4);
});

test('SynthVoice cleans up normally, handles ended-before-release, and calls its callback once', () => {
  let stopped = 0;
  const context = { currentTime: 0, sampleRate: 44100 } as unknown as BaseAudioContext;
  const finalGain = gain();
  const voice = new SynthVoice({ id: 'cleanup', instrument: 'lead', lane: 'live', profile: { fingerprint: 'p' }, finalGain, context, onStopped: () => { stopped += 1; } });
  const src = source();
  voice.addSource(src, 0);
  voice.start(0, { attackSeconds: .01, decaySeconds: .02, sustain: 1, releaseSeconds: .1 });
  (src as unknown as Source).end();
  assert.equal(voice.state, 'stopped');
  assert.equal(stopped, 1);
  assert.equal((finalGain as unknown as Node).disconnectCount, 1);
  voice.release(.2, .1);
  (src as unknown as Source).end();
  assert.equal(stopped, 1);
});

test('SynthVoice reschedules a shorter steal fade and late sources inherit the stop', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const voice = new SynthVoice({ id: 'steal', instrument: 'bass', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  const src = source();
  voice.addSource(src, 0);
  voice.start(0, { attackSeconds: .01, decaySeconds: .02, sustain: 1, releaseSeconds: .5 });
  voice.release(.1, .5);
  const longStop = voice.timing.stopAt!;
  voice.choke(.2, .012);
  assert.ok(voice.timing.stopAt! < longStop);
  const late = source();
  voice.addSource(late, 0);
  assert.equal((late as unknown as Source).stops.at(-1), voice.timing.stopAt);
});

test('VoiceGroup releases all children at the same time exactly once', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const first = new SynthVoice({ id: 'a', instrument: 'lead', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  const second = new SynthVoice({ id: 'b', instrument: 'lead', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  first.addSource(source(), 0);
  second.addSource(source(), 0);
  first.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .1 });
  second.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .1 });
  const group = new VoiceGroup('group', [first, second]);
  context.currentTime = .5;
  group.release(.5, .2);
  group.release(.6, .2);
  assert.equal(first.timing.noteOffAt, .5);
  assert.equal(second.timing.noteOffAt, .5);
  assert.equal(group.state, 'releasing');
});

test('VoiceGroup chokes mixed child states once at one time', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const active = new SynthVoice({ id: 'active', instrument: 'lead', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  const releasing = new SynthVoice({ id: 'releasing', instrument: 'lead', lane: 'live', profile: { fingerprint: 'p' }, finalGain: gain(), context });
  active.addSource(source(), 0);
  releasing.addSource(source(), 0);
  active.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .2 });
  releasing.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .2 });
  releasing.release(.1, .2);
  const group = new VoiceGroup('mixed', [active, releasing]);
  context.currentTime = .2;
  group.choke(.2, .012);
  group.choke(.3, .012);
  assert.equal(active.timing.noteOffAt, .2);
  assert.equal(releasing.timing.noteOffAt, .2);
  assert.equal(group.state, 'releasing');
});

test('ProfileBus owns a frozen profile and disconnects only after users and tail finish', () => {
  const profile = { presetId: 'test', controls: { tone: .5 }, parameters: { filterHz: 900 }, volume: .4 };
  const context = { createGain: () => gain() } as unknown as BaseAudioContext;
  const bus = new ProfileBus(context, { fingerprint: 'profile', profile });
  bus.retain();
  profile.controls.tone = .9;
  assert.equal(bus.profile?.controls.tone, .5);
  assert.equal(bus.disconnect(0), false);
  bus.release(2);
  assert.equal(bus.disconnect(1), false);
  assert.equal(bus.disconnect(2), true);
  assert.equal(bus.disconnect(3), false);
});

test('SynthVoice owns a deeply frozen profile snapshot', () => {
  const profile = { presetId: 'voice-profile', controls: { tone: .25, nested: { amount: .4 } }, parameters: { filterHz: 900 }, volume: .5 };
  const voice = new SynthVoice({ id: 'profile-voice', instrument: 'lead', lane: 'live', profile: { fingerprint: 'profile', profile }, finalGain: gain(), context: { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext });
  profile.controls.tone = .9;
  profile.controls.nested.amount = .1;
  assert.equal(voice.profile.profile?.controls.tone, .25);
  assert.equal(((voice.profile.profile?.controls as Record<string, unknown>).nested as Record<string, number>).amount, .4);
  assert.equal(Object.isFrozen(voice.profile.profile), true);
  assert.equal(Object.isFrozen(voice.profile.profile?.controls), true);
});

test('VoicePool isolates lanes and steals releasing voices before active voices', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ bass: 2 });
  pool.setTailLimit('bass', 'live', 2);
  const make = (id: string, lane: 'live' | 'deckA') => {
    const voice = new SynthVoice({ id, instrument: 'bass', lane, profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), 0);
    voice.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .1 });
    return voice;
  };
  const first = make('first', 'live');
  const second = make('second', 'live');
  const deck = make('deck', 'deckA');
  pool.add(first); pool.add(second); pool.add(deck);
  first.release(.1, .1);
  const third = make('third', 'live');
  pool.add(third);
  assert.throws(() => pool.add(third));
  assert.equal(pool.count('bass', 'deckA'), 1);
  assert.equal(first.state, 'releasing');
  assert.equal(pool.activeCount('bass', 'live'), 2);
  let rejected = 0;
  for (let index = 0; index < 100; index++) {
    const burst = make(`burst-${index}`, 'live');
    const result = pool.tryAdd(burst);
    if (result.status === 'rejected') {
      rejected += 1;
      burst.dispose();
    }
  }
  assert.ok(rejected > 0);
  assert.ok(pool.retainedCount('bass', 'live') <= pool.retainedTailLimit('bass', 'live') + 2);
  assert.equal(sourceStopGuardSeconds(48000), 256 / 48000);
});

test('VoicePool uses insertion order for equal-time steals and handles future voices separately', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 2 });
  const make = (id: string, start: number) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'live', profile: { fingerprint: id }, finalGain: gain(), context });
    voice.addSource(source(), start);
    voice.start(start, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .2 });
    return voice;
  };
  const first = make('first', 0);
  const second = make('second', 0);
  pool.add(first); pool.add(second);
  const future = new SynthVoice({ id: 'future', instrument: 'lead', lane: 'live', profile: { fingerprint: 'future' }, finalGain: gain(), context });
  future.addSource(source(), 5);
  future.start(5, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .2 });
  pool.add(future);
  assert.equal(first.state, 'active');
  assert.equal(pool.activeCount('lead', 'live'), 2);
  assert.equal(pool.scheduledCount('lead', 'live'), 1);
  context.currentTime = 5;
  assert.equal(first.state, 'releasing');
  assert.equal(pool.activeCount('lead', 'live'), 2);
  assert.equal(pool.scheduledCount('lead', 'live'), 0);
  assert.equal(pool.allocatedCount('lead', 'live'), 2);
  assert.equal(pool.count('lead', 'live', false), 3);
  assert.throws(() => pool.add(future));
});

test('VoicePool accepts three close bass voices and dispose reaches every retained state', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ bass: 8 });
  const voices = [0, 1, 2].map((index) => {
    const voice = new SynthVoice({ id: `close-${index}`, instrument: 'bass', lane: 'live', profile: { fingerprint: String(index) }, finalGain: gain(), context });
    voice.addSource(source(), 0);
    voice.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .5 });
    assert.equal(pool.tryAdd(voice).status, 'accepted');
    return voice;
  });
  const retiring = voices[0];
  retiring.release(0, .5);
  const future = new SynthVoice({ id: 'close-future', instrument: 'bass', lane: 'live', profile: { fingerprint: 'future' }, finalGain: gain(), context });
  const futureSource = source();
  future.addSource(futureSource, 5);
  assert.equal(pool.tryAdd(future).status, 'accepted');
  pool.dispose();
  for (const voice of [...voices, future]) {
    const sources = [...voice.sources] as Source[];
    context.currentTime = Math.max(context.currentTime, voice.cleanupAt + .001);
    voice.finishIfSilent(context.currentTime);
    assert.equal(voice.state, 'stopped');
    assert.ok(sources.every((item) => item.disconnectCount > 0));
  }
});

test('VoicePool removes forced-retiring IDs when the stolen voice ends', () => {
  const context = { currentTime: 0, sampleRate: 48000 } as unknown as BaseAudioContext;
  const pool = new VoicePool({ lead: 1 });
  const make = (id: string) => {
    const voice = new SynthVoice({ id, instrument: 'lead', lane: 'live', profile: { fingerprint: id }, finalGain: gain(), context });
    const src = source();
    voice.addSource(src, 0);
    voice.start(0, { attackSeconds: .01, decaySeconds: .01, sustain: 1, releaseSeconds: .2 });
    voice.startSources(0);
    return { voice, src: src as unknown as Source };
  };
  const first = make('forced-first');
  pool.add(first.voice);
  const second = make('forced-second');
  assert.equal(pool.tryAdd(second.voice).status, 'accepted');
  assert.equal(pool.forcedRetiringCount('lead', 'live'), 1);
  first.src.end();
  (context as unknown as { currentTime: number }).currentTime = first.voice.cleanupAt + .001;
  first.voice.finishIfSilent((context as unknown as { currentTime: number }).currentTime);
  assert.equal(pool.forcedRetiringCount('lead', 'live'), 0);
  second.src.end();
});
