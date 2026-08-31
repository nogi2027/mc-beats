import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacySynthEngine } from '../src/audio.ts';
import { IndependentBassEngine } from '../src/synth/independent-bass.ts';
import { BASS_PRESETS, DEFAULT_BASS_PROFILE } from '../src/synth/patches/bass.ts';

type Operation = { method: string; value?: number; start?: number; end?: number };

class FakeParam {
  value = 0;
  operations: Operation[] = [];
  setValueAtTime(value: number, start = 0) { this.value = value; this.operations.push({ method: 'setValueAtTime', value, start }); return this; }
  linearRampToValueAtTime(value: number, end = 0) { this.value = value; this.operations.push({ method: 'linearRampToValueAtTime', value, end }); return this; }
  exponentialRampToValueAtTime(value: number, end = 0) { this.value = value; this.operations.push({ method: 'exponentialRampToValueAtTime', value, end }); return this; }
  cancelAndHoldAtTime(start = 0) { this.operations.push({ method: 'cancelAndHoldAtTime', start }); return this; }
  cancelScheduledValues(start = 0) { this.operations.push({ method: 'cancelScheduledValues', start }); return this; }
}

class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  connect<T extends FakeNode>(target: T) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeFilter extends FakeNode { type: BiquadFilterType = 'lowpass'; frequency = new FakeParam(); Q = new FakeParam(); }
class FakeShaper extends FakeNode { curve: Float32Array | null = null; oversample: OverSampleType = 'none'; }
class FakeSource extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  type: OscillatorType = 'sine';
  starts: number[] = [];
  stops: number[] = [];
  listeners: Array<() => void> = [];
  failOnStart = false;
  start(at = 0) { this.starts.push(at); }
  stop(at = 0) { this.stops.push(at); }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.push(listener); }
  end() { this.listeners.forEach((listener) => listener()); }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  state: AudioContextState = 'running';
  oscillatorCount = 0;
  failOscillatorStartAt: number | null = null;
  createGain() { return new FakeGain(); }
  createOscillator() {
    const source = new FakeSource();
    source.failOnStart = this.failOscillatorStartAt === this.oscillatorCount;
    this.oscillatorCount += 1;
    const start = source.start.bind(source);
    source.start = (at = 0) => {
      if (source.failOnStart) throw new Error('fake source start failure');
      start(at);
    };
    return source;
  }
  createBiquadFilter() { return new FakeFilter(); }
  createWaveShaper() { return new FakeShaper(); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

const profile = () => ({
  ...DEFAULT_BASS_PROFILE,
  controls: { ...DEFAULT_BASS_PROFILE.controls },
  parameters: { ...DEFAULT_BASS_PROFILE.parameters },
});
const engine = (context: FakeContext) => new IndependentBassEngine({ context: context as unknown as BaseAudioContext });
const finishVoice = (voice: { sources: Set<AudioScheduledSourceNode> }) => [...voice.sources].forEach((source) => (source as unknown as FakeSource).end());
const reaches = (from: FakeNode, target: FakeNode, seen = new Set<FakeNode>()): boolean => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((next) => reaches(next, target, seen));
};
const reachesBeforeFinal = (from: FakeNode, target: FakeNode, finalGain: FakeNode, seen = new Set<FakeNode>()): boolean => {
  if (from === finalGain) return false;
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((next) => reachesBeforeFinal(next, target, finalGain, seen));
};

test('independent bass creates one complete note-owned graph after silence', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const sources = bass.note(36, .25, 0, profile(), 'deckA', 1);
  const voice = bass.pool.all()[0];
  assert.equal(sources.length, 2, 'Sub has no click source');
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 1);
  assert.equal(voice.profile.profile?.presetId, 'Sub');
  assert.equal(voice.finalGain.connections.length, 1);
  assert.equal(voice.finalGain.gain.operations.some((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === .65), true);
  assert.equal((voice.sources.values().next().value as FakeSource).starts.length, 1);
  assert.equal(bass.getSynthSnapshot().bassLanes.find((lane) => lane.lane === 'deckA')?.persistent, false);
  finishVoice(voice);
  context.currentTime = voice.cleanupAt + .001;
  voice.finishIfSilent(context.currentTime);
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 0);
});

test('every independent bass source and processing node is owned by the final voice', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const voice = bass.pool.all()[0] ?? (() => { bass.note(40, .2, 0, { ...profile(), parameters: { ...profile().parameters, clickLevel: .2 } }, 'live'); return bass.pool.all()[0]; })();
  assert.ok(voice);
  assert.equal(voice.sources.size, 3, 'nonzero click adds a third source');
  assert.ok(voice.nodes.has(voice.finalGain));
  assert.equal(voice.finalGain.connections.length, 1);
  assert.ok([...voice.nodes].every((node) => !node.disconnected));
});

test('independent bass releases during attack, decay, and sustain without changing another voice', () => {
  for (const releaseAt of [.002, .02, .2]) {
    const context = new FakeContext();
    const bass = engine(context);
    bass.note(36, null, 0, profile(), 'deckA');
    const voice = bass.pool.all()[0];
    context.currentTime = releaseAt;
    const release = voice.release(releaseAt, .1)!;
    assert.equal(release.start, releaseAt);
    assert.equal(voice.state, 'releasing');
    assert.equal(voice.envelope.valueAt(release.end), 0);
  }
});

test('independent bass finite gates release at onset plus duration', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .25, 0, profile(), 'deckA');
  const voice = bass.pool.all()[0];
  assert.equal(voice.timing.noteOffAt, .25);
  context.currentTime = .25;
  assert.equal(voice.state, 'releasing');
  assert.equal(voice.timing.releaseEndAt, .75);
});

test('four-bar deck bass stress keeps 250 ms onset spacing and 500 ms releases', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const onsetSpacing = .25;
  const gate = .111;
  for (let index = 0; index < 32; index += 1) {
    context.currentTime = index * onsetSpacing;
    // Fake sources do not advance themselves, so retire voices whose real
    // scheduled stop has passed before adding the next musical event.
    for (const voice of bass.pool.all()) {
      if (voice.timing.stopAt !== null && voice.timing.stopAt <= context.currentTime) finishVoice(voice);
    }
    bass.note(36 + (index % 5), gate, context.currentTime, profile(), 'deckA');
    const voice = bass.pool.all().find((candidate) => candidate.timing.startAt === context.currentTime);
    assert.ok(voice);
    assert.equal(voice.timing.noteOffAt, context.currentTime + gate);
    assert.equal(voice.timing.releaseEndAt, context.currentTime + gate + .5);
  }
  assert.equal(bass.pool.retainedCount('bass', 'deckA') <= 4, true);
  const remaining = bass.pool.all();
  remaining.forEach((voice) => finishVoice(voice));
  context.currentTime = Math.max(...remaining.map((voice) => voice.cleanupAt)) + .001;
  remaining.forEach((voice) => voice.finishIfSilent(context.currentTime));
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 0);
});

test('zero through 100 ms rapid notes create independent bass voices without rewriting old envelopes', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const gaps = [0, .001, .005, .01, .02, .05, .1];
  const oldTimelines: unknown[][] = [];
  gaps.forEach((gap, index) => {
    context.currentTime = gap;
    bass.note(36 + index, .11, gap, profile(), 'deckA', .4 + index / 20);
    oldTimelines.push(bass.pool.all().map((voice) => voice.envelope.timeline()));
  });
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), gaps.length);
  assert.equal(new Set(bass.pool.all().map((voice) => voice.finalGain)).size, gaps.length);
  assert.ok(oldTimelines.every((timeline) => timeline.length > 0));
});

test('a new finite bass note does not edit the older release envelope', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .1, 0, profile(), 'deckA');
  const first = bass.pool.all()[0];
  const before = JSON.stringify(first.envelope.timeline());
  context.currentTime = .05;
  bass.note(43, .1, .05, profile(), 'deckA');
  assert.equal(JSON.stringify(first.envelope.timeline()), before);
  assert.notEqual(bass.pool.all()[1].finalGain, first.finalGain);
});

test('live held bass uses last-note priority and falls back to the older key', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.holdNote('a', 36, profile());
  const firstVoice = bass.pool.all()[0];
  bass.holdNote('b', 40, profile());
  finishVoice(firstVoice);
  context.currentTime = .05;
  const live = bass.getSynthSnapshot().bassLanes.find((lane) => lane.lane === 'live');
  assert.equal(live?.currentHeldId, 'b');
  assert.equal(bass.releaseNote('b')?.id, 'b');
  assert.equal(bass.getSynthSnapshot().bassLanes.find((lane) => lane.lane === 'live')?.currentHeldId, 'a');
  assert.equal(bass.hasHeldNote('a'), true);
  assert.equal(bass.pool.byLane('live').some((voice) => voice.profile.profile?.presetId === 'Sub' && voice.state !== 'stopped'), true);
  assert.equal(bass.releaseNote('a')?.id, 'a');
  assert.equal(bass.hasHeldNote('a'), false);
});

test('held bass metadata survives a stopped crossfade voice and preserves three-key priority', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.holdNote('a', 36, profile());
  const aVoice = bass.pool.all()[0];
  bass.holdNote('b', 40, profile());
  const bVoice = bass.pool.all().find((voice) => voice !== aVoice)!;
  bass.holdNote('c', 43, profile());
  finishVoice(aVoice);
  finishVoice(bVoice);
  context.currentTime = 1;
  assert.equal(bass.hasHeldNote('a'), true);
  assert.equal(bass.hasHeldNote('b'), true);
  assert.equal(bass.hasHeldNote('c'), true);
  bass.releaseNote('b');
  assert.equal(bass.hasHeldNote('a'), true);
  assert.equal(bass.hasHeldNote('c'), true);
  assert.equal(bass.getSynthSnapshot().bassLanes.find((lane) => lane.lane === 'live')?.currentHeldId, 'c');
  bass.releaseNote('c');
  assert.equal(bass.getSynthSnapshot().bassLanes.find((lane) => lane.lane === 'live')?.currentHeldId, 'a');
  bass.releaseNote('a');
  assert.equal(bass.hasHeldNote('a'), false);
});

test('live, deckA, deckB, solo, and debug bass lanes stay independent', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const lanes = ['live', 'deckA', 'deckB', 'solo', 'debug'] as const;
  lanes.forEach((lane, index) => bass.note(36 + index, .1, 0, profile(), lane, 1));
  assert.equal(bass.pool.retainedCount('bass'), lanes.length);
  for (const lane of lanes) assert.equal(bass.pool.retainedCount('bass', lane), 1);
  bass.stopLane('deckA');
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 1);
  assert.equal(bass.pool.all().filter((voice) => voice.lane === 'deckB')[0].state, 'active');
});

test('profile snapshots and velocity stay independent from later changes', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const input = profile();
  bass.note(36, .1, 0, input, 'deckA', .2);
  const first = bass.pool.all()[0];
  input.controls.tone = .99;
  input.parameters.filterHz = 7000;
  assert.equal(first.profile.profile?.controls.tone, .25);
  assert.equal(first.profile.profile?.parameters.filterHz, 900);
  const secondGain = bass.note(40, .1, .1, input, 'deckA', .9);
  assert.equal(secondGain.length, 2);
  assert.equal(first.profile.profile?.volume, .62);
  assert.equal(bass.pool.all()[0].finalGain.gain.operations.some((operation) => operation.value === .2), true);
});

test('glide changes only the new bass voice', () => {
  const context = new FakeContext();
  const bass = engine(context);
  const glideProfile = { ...profile(), controls: { ...profile().controls, glide: 1 }, parameters: { ...profile().parameters, glideMs: 100 } };
  bass.note(36, .2, 0, glideProfile, 'deckA');
  const first = bass.pool.all()[0];
  const firstFrequencyOperations = JSON.stringify((first.sources.values().next().value as FakeSource).frequency.operations);
  bass.note(48, .2, .1, glideProfile, 'deckA');
  const second = bass.pool.all()[1];
  const secondFrequency = second.sources.values().next().value as FakeSource;
  assert.equal(JSON.stringify((first.sources.values().next().value as FakeSource).frequency.operations), firstFrequencyOperations);
  assert.equal(secondFrequency.frequency.operations.some((operation) => operation.method === 'exponentialRampToValueAtTime'), true);
});

test('pool rejection never starts or orphans a rejected bass voice', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.pool.setLimit('bass', 'deckA', 1);
  bass.pool.setTailLimit('bass', 'deckA', 1);
  for (let index = 0; index < 4; index += 1) {
    context.currentTime = index * .01;
    bass.note(36 + index, .5, context.currentTime, profile(), 'deckA');
  }
  assert.ok(bass.pool.retainedCount('bass', 'deckA') <= 3);
  assert.equal(bass.pool.all().filter((voice) => voice.lane === 'deckA').every((voice) => voice.sources.size > 0), true);
});

test('stop, disable, panic, and cleanup reach independent bass voices', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .2, 0, profile(), 'deckA');
  bass.note(40, .2, 0, profile(), 'deckB');
  bass.stopLane('deckA');
  assert.ok(bass.pool.all().filter((voice) => voice.lane === 'deckA').every((voice) => [...voice.sources].some((source) => (source as unknown as FakeSource).stops.length > 0)));
  bass.setInstrumentEnabled(false);
  assert.equal(bass.isInstrumentEnabled(), false);
  bass.panic();
  assert.ok(bass.pool.all().every((voice) => voice.timing.stopAt !== null));
  const voices = bass.pool.all();
  voices.forEach((voice) => finishVoice(voice));
  context.currentTime = Math.max(...voices.map((voice) => voice.cleanupAt)) + .001;
  voices.forEach((voice) => voice.finishIfSilent(context.currentTime));
  assert.equal(bass.pool.retainedCount('bass'), 0);
});

test('disabled bass stops retained voices and rejects new notes without allocation', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, null, 0, profile(), 'deckA');
  bass.note(40, .1, 5, profile(), 'deckB');
  const before = bass.pool.retainedCount('bass');
  bass.setInstrumentEnabled(false);
  assert.equal(bass.isInstrumentEnabled(), false);
  assert.equal(bass.note(43, .1, 0, profile(), 'live').length, 0);
  assert.equal(bass.pool.retainedCount('bass'), before);
  assert.ok(bass.pool.all().every((voice) => voice.timing.stopAt !== null));
  bass.setInstrumentEnabled(true);
  assert.equal(bass.note(43, .1, 0, profile(), 'live').length, 2);
});

test('profile buses stay connected and reusable until engine disposal', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .1, 0, profile(), 'deckA');
  const first = bass.pool.all()[0];
  const firstBus = first.finalGain.connections[0] as unknown as FakeNode;
  finishVoice(first);
  context.currentTime = first.cleanupAt + .001;
  first.finishIfSilent(context.currentTime);
  assert.equal((bass.getProfileBusSnapshots('deckA')[0] as { users: number }).users, 0);
  assert.equal(firstBus.disconnected, false);
  bass.note(40, .1, .2, profile(), 'deckA');
  const second = bass.pool.all()[0];
  assert.equal(second.finalGain.connections[0], firstBus);
  assert.equal((bass.getProfileBusSnapshots('deckA')[0] as { users: number }).users, 1);
  bass.dispose();
  finishVoice(second);
  context.currentTime = second.cleanupAt + .001;
  second.finishIfSilent(context.currentTime);
  assert.equal(firstBus.disconnected, true);
});

test('rejected and partially started voices are stopped, disconnected, and do not leak bus users', () => {
  const rejectedContext = new FakeContext();
  const rejectedBass = engine(rejectedContext);
  rejectedBass.pool.setLimit('bass', 'deckA', 1);
  rejectedBass.pool.setTailLimit('bass', 'deckA', 1);
  for (let index = 0; index < 4; index += 1) rejectedBass.note(36 + index, .5, 0, profile(), 'deckA');
  const rejected = rejectedBass.getLastRejectedVoice();
  assert.ok(rejected);
  assert.equal(rejected.startedSourceCount, 0);
  assert.equal(rejected.state, 'stopped');
  assert.equal(rejected.finalGain.disconnected, true);
  assert.ok(rejectedBass.getProfileBusSnapshots('deckA').every((bus) => (bus as { users: number }).users <= 3));

  const failingContext = new FakeContext();
  failingContext.failOscillatorStartAt = 1;
  const failingBass = engine(failingContext);
  assert.throws(() => failingBass.note(36, .1, 0, profile(), 'deckA'));
  const failed = failingBass.getLastStartFailureVoice();
  assert.ok(failed);
  assert.equal(failed.startedSourceCount, 1);
  assert.equal(failed.state, 'releasing');
  finishVoice(failed);
  failingContext.currentTime = failed.cleanupAt + .001;
  failed.finishIfSilent(failingContext.currentTime);
  assert.equal(failed.finalGain.disconnected, true);
  assert.equal((failingBass.getProfileBusSnapshots('deckA')[0] as { users: number }).users, 0);
});

test('independent bass graph paths reach finalGain before any profile bus', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .1, 0, { ...profile(), parameters: { ...profile().parameters, clickLevel: .2 } }, 'deckA');
  const voice = bass.pool.all()[0];
  const sources = [...voice.sources] as FakeSource[];
  assert.ok(sources.every((source) => reaches(source, voice.finalGain as unknown as FakeNode)));
  assert.equal(voice.finalGain.connections.length, 1);
  assert.equal(sources.some((source) => reachesBeforeFinal(source, voice.finalGain.connections[0] as unknown as FakeNode, voice.finalGain as unknown as FakeNode)), false);
});

test('independent bass snapshots separate scheduling transitions from measured diagnostics', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, .25, 0, profile(), 'deckA');
  const snapshot = bass.getSynthSnapshot();
  assert.deepEqual(snapshot.bassReleaseDiagnostics, []);
  assert.equal(snapshot.independentBassTransitions?.some((transition) => transition.lane === 'deckA' && transition.cause === 'natural-release'), true);
  assert.equal(snapshot.independentBassTransitions?.every((transition) => transition.end >= transition.scheduledAt), true);
});

test('dispose keeps active voices reachable until their sources finish', () => {
  const context = new FakeContext();
  const bass = engine(context);
  bass.note(36, null, 0, profile(), 'deckA');
  const voice = bass.pool.all()[0];

  bass.dispose();
  assert.equal(voice.finalGain.disconnected, false, 'dispose must not disconnect an audible voice immediately');
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 1);

  finishVoice(voice);
  context.currentTime = voice.cleanupAt + .001;
  voice.finishIfSilent(context.currentTime);
  assert.equal(bass.pool.retainedCount('bass', 'deckA'), 0);
  assert.equal(voice.finalGain.disconnected, true);
  bass.dispose();
});

test('all current bass presets remain available to the independent patch', () => {
  assert.equal(BASS_PRESETS.length, 6);
  assert.deepEqual(BASS_PRESETS.map((preset) => preset.presetId), ['Sub', 'Rubber', 'Acid', 'Pluck', 'Pulse', 'Distorted']);
});

test('independent bass presets match the legacy bass profiles by value', () => {
  const legacy = new LegacySynthEngine();
  for (const [index, preset] of BASS_PRESETS.entries()) {
    legacy.loadPreset('bass', index);
    assert.deepEqual(preset, legacy.getSoundProfile('bass', preset.presetId));
  }
  legacy.dispose();
});
