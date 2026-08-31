import test from 'node:test';
import assert from 'node:assert/strict';
import { IndependentDrumEngine } from '../src/synth/independent-drums.ts';
import { DRUM_NAMES, normalizeDrumProfile, drumProfileFingerprint } from '../src/synth/patches/drums.ts';
import { DRUM_PRESET_OVERRIDES } from '../src/synth/patches/drum-presets.ts';
import type { DrumModel, VoiceLane } from '../src/synth/contract.ts';
import type { DeckSoundProfile } from '../src/deck.ts';

type Operation = { method: string; value?: number; start?: number; end?: number };
class FakeParam {
  value = 0;
  operations: Operation[] = [];
  setValueAtTime(value: number, start = 0) { this.value = value; this.operations.push({ method: 'setValueAtTime', value, start }); return this; }
  linearRampToValueAtTime(value: number, end = 0) { this.value = value; this.operations.push({ method: 'linearRampToValueAtTime', value, end }); return this; }
  exponentialRampToValueAtTime(value: number, end = 0) { this.value = value; this.operations.push({ method: 'exponentialRampToValueAtTime', value, end }); return this; }
  cancelAndHoldAtTime(start = 0) { this.operations.push({ method: 'cancelAndHoldAtTime', start }); return this; }
  cancelScheduledValues(start = 0) { this.operations.push({ method: 'cancelScheduledValues', start }); return this; }
  setValueCurveAtTime(_values: Float32Array, start = 0, duration = 0) { this.operations.push({ method: 'setValueCurveAtTime', start, end: start + duration }); return this; }
}
class FakeNode {
  connections: FakeNode[] = [];
  disconnected = false;
  connect<T extends FakeNode>(target: T) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeFilter extends FakeNode { type: BiquadFilterType = 'lowpass'; frequency = new FakeParam(); Q = new FakeParam(); }
class FakeDelay extends FakeNode { delayTime = new FakeParam(); }
class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  private typeValue: OscillatorType = 'sine';
  get type() { return this.typeValue; }
  set type(value: OscillatorType) { this.typeValue = value; }
  starts: number[] = [];
  stops: number[] = [];
  listeners: Array<() => void> = [];
  private readonly shouldFail: () => boolean;
  constructor(shouldFail: () => boolean = () => false) { super(); this.shouldFail = shouldFail; }
  start(at = 0) { if (this.shouldFail()) throw new Error('fake source start failure'); this.starts.push(at); }
  stop(at = 0) { this.stops.push(at); }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.push(listener); }
  end() { this.listeners.forEach((listener) => listener()); }
}
class FakeBufferSource extends FakeOscillator { buffer: AudioBuffer | null = null; constructor(shouldFail: () => boolean = () => false) { super(shouldFail); } }
class FakeShaper extends FakeNode { curve: Float32Array | null = null; oversample: OverSampleType = 'none'; }
class FakeBuffer {
  duration = 2;
  private readonly length: number;
  constructor(length: number) { this.length = length; }
  getChannelData() { return new Float32Array(this.length); }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48_000;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  startAttempts = 0;
  failOnStartAttempt: number | null = null;
  private startGuard() { return () => { this.startAttempts += 1; return this.failOnStartAttempt === this.startAttempts; }; }
  createGain() { return new FakeGain(); }
  createBiquadFilter() { return new FakeFilter(); }
  createDelay() { return new FakeDelay(); }
  createWaveShaper() { return new FakeShaper(); }
  createOscillator() { const oscillator = new FakeOscillator(this.startGuard()); this.oscillators.push(oscillator); return oscillator; }
  createBuffer(_channels: number, length: number) { return new FakeBuffer(length) as unknown as AudioBuffer; }
  createBufferSource() { const source = new FakeBufferSource(this.startGuard()); this.oscillators.push(source); return source; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

const profile = (presetId = 'Clean', drumModel: DrumModel = 'layered'): DeckSoundProfile => ({
  presetId,
  controls: { punch: .5, tightness: .55, dirt: .05, room: .12 },
  parameters: {},
  volume: .7,
  drumModel,
});
const endVoice = (voice: { sources: Set<AudioScheduledSourceNode> }) => [...voice.sources].forEach((source) => (source as unknown as FakeOscillator).end());
const reaches = (from: FakeNode, target: FakeNode, seen = new Set<FakeNode>()): boolean => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((next) => reaches(next, target, seen));
};

const reachesWithout = (from: FakeNode, target: FakeNode, forbidden: FakeNode, seen = new Set<FakeNode>()): boolean => {
  if (from === forbidden) return false;
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((next) => reachesWithout(next, target, forbidden, seen));
};

test('independent drums render every pad in all legacy models through one final gain', () => {
  for (const model of ['layered', 'noisy', 'electronic'] as DrumModel[]) {
    const context = new FakeContext();
    const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile('Clean', model), drumModel: model });
    for (let pad = 0; pad < DRUM_NAMES.length; pad += 1) {
      const build = engine.drum(pad, pad * 2, profile('Clean', model), 'live', .8);
      assert.ok(build, `pad ${pad} should be accepted for ${model}`);
      assert.ok(build!.sources.length > 0);
      assert.equal(build!.voice.finalGain.gain.value, .8);
      const finalGain = build!.voice.finalGain as unknown as FakeNode;
      for (const source of build!.voice.sources) assert.equal(reaches(source as unknown as FakeNode, finalGain), true);
      assert.equal(reaches(finalGain, build!.profileBus.output as unknown as FakeNode), true);
    }
    assert.equal(engine.runtime.pool.retainedCount('drums'), 12);
    engine.dispose();
  }
});

test('legacy drum preset overrides remain exact and new kits serialize as complete profiles', () => {
  assert.deepEqual(DRUM_PRESET_OVERRIDES.slice(0, 6).map((preset) => [preset.presetId, preset.controls, preset.parameters, preset.volume]), [
    ['Clean', { punch: .5, tightness: .55, dirt: .05, room: .12 }, { kickStartHz: 170, kickDecayMs: 360, snareBodyHz: 180, closedHatMs: 42, openHatMs: 360 }, .7],
    ['Classic', { punch: .75, tightness: .45, dirt: .2, room: .22 }, { kickStartHz: 210, kickPitchFallMs: 75, snareBodyHz: 210, snareNoiseMs: 210, clapGapMs: 18 }, .68],
    ['Soft', { punch: .35, tightness: .8, dirt: 0, room: .35 }, { kickStartHz: 155, kickDecayMs: 240, snareNoiseMs: 120, closedHatMs: 30, openHatMs: 280 }, .64],
    ['Tight', { punch: .7, tightness: .95, dirt: .08, room: .08 }, { kickPitchFallMs: 45, kickDecayMs: 180, snareNoiseMs: 90, closedHatMs: 18, openHatMs: 180, tomFallMs: 70 }, .72],
    ['Industrial', { punch: .9, tightness: .35, dirt: .65, room: .18 }, { kickStartHz: 250, kickEndHz: 42, kickDecayMs: 500, snareBodyHz: 260, snareNoiseMs: 300, percAHz: 1100, percBHz: 1750 }, .58],
    ['Lo-fi', { punch: .4, tightness: .7, dirt: .85, room: .4 }, { kickStartHz: 130, kickEndHz: 55, kickPitchFallMs: 150, snareBodyHz: 150, closedHatMs: 65, openHatMs: 520, clapGapMs: 28 }, .55],
  ]);
  assert.deepEqual(DRUM_PRESET_OVERRIDES.slice(6).map((preset) => preset.presetId), ['808', 'Circuit', 'Glitch']);
  for (const preset of DRUM_PRESET_OVERRIDES) {
    const normalized = normalizeDrumProfile({ ...preset, controls: { ...preset.controls }, parameters: { ...preset.parameters } });
    assert.equal(normalized.profile.presetId, preset.presetId);
    assert.equal(typeof drumProfileFingerprint(normalized.profile), 'string');
  }
});

test('closed hats choke only open hats in the same lane', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  const openLive = engine.drum(3, 0, profile(), 'live');
  const openDeck = engine.drum(3, 0, profile(), 'deckA');
  assert.ok(openLive && openDeck);
  const deckBefore = openDeck!.voice.timing.releaseEndAt;
  engine.drum(2, .01, profile(), 'live');
  assert.ok((openLive!.voice.timing.releaseEndAt ?? Infinity) <= .022);
  assert.equal(openDeck!.voice.timing.releaseEndAt, deckBefore);
  engine.dispose();
});

test('disabled drum engine rejects hits without starting or retaining a voice', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  engine.setInstrumentEnabled(false);
  assert.equal(engine.drum(0, 0, profile(), 'live'), null);
  assert.equal(engine.runtime.pool.retainedCount(), 0);
  assert.equal(context.oscillators.length, 0);
  engine.setInstrumentEnabled(true);
  assert.ok(engine.drum(0, 0, profile(), 'live'));
  engine.dispose();
});

test('drum hit profiles are immutable snapshots and preserve lane independence', () => {
  const context = new FakeContext();
  const source = profile('Circuit');
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: source });
  const first = engine.drum(0, 0, source, 'deckA');
  source.controls.punch = .99;
  source.parameters.kickStartHz = 999;
  const second = engine.drum(0, 0, source, 'deckB');
  assert.ok(first && second);
  assert.notEqual(first!.voice.profile.profile, source);
  assert.equal(first!.voice.profile.profile?.controls.punch, .5);
  assert.equal(second!.voice.lane, 'deckB');
  assert.equal(first!.voice.lane, 'deckA');
  engine.dispose();
});

test('every drum source reaches its lane bus only through the one final gain', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  for (const lane of ['live', 'deckA', 'deckB', 'solo', 'debug'] as VoiceLane[]) {
    const build = engine.drum(4, 0, profile(), lane, .5);
    assert.ok(build);
    const finalGain = build!.voice.finalGain as unknown as FakeNode;
    const bus = build!.profileBus.output as unknown as FakeNode;
    for (const source of build!.voice.sources) {
      assert.equal(reaches(source as unknown as FakeNode, finalGain), true);
      assert.equal(reachesWithout(source as unknown as FakeNode, bus, finalGain), false);
    }
  }
  engine.dispose();
});

test('profile bus retains once, survives one ending, and serves a later same-profile hit', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  const first = engine.drum(0, 0, profile(), 'live');
  assert.ok(first);
  const firstBus = first!.profileBus;
  assert.equal(firstBus.snapshot().users, 1);
  const overlapping = engine.drum(0, .01, profile(), 'live');
  assert.ok(overlapping);
  assert.equal(firstBus.snapshot().users, 2);
  endVoice(first!.voice as unknown as { sources: Set<AudioScheduledSourceNode> });
  context.currentTime = 2;
  first!.voice.finishIfSilent(2);
  assert.equal(firstBus.snapshot().users, 1);
  endVoice(overlapping!.voice as unknown as { sources: Set<AudioScheduledSourceNode> });
  overlapping!.voice.finishIfSilent(2);
  assert.equal(firstBus.snapshot().users, 0);
  const later = engine.drum(0, 3, profile(), 'live');
  assert.ok(later);
  assert.equal(later!.profileBus, firstBus);
  assert.equal((later!.profileBus.output as unknown as FakeNode).disconnected, false);
  engine.dispose();
});

test('rejected and partially started hits abort every owned source and release the bus', () => {
  const rejectedContext = new FakeContext();
  rejectedContext.failOnStartAttempt = 1;
  const rejectedEngine = new IndependentDrumEngine({ context: rejectedContext as unknown as BaseAudioContext, defaultProfile: profile() });
  assert.equal(rejectedEngine.drum(0, 0, profile(), 'live'), null);
  assert.equal(rejectedEngine.runtime.pool.retainedCount(), 0);
  assert.equal(rejectedContext.oscillators.every((source) => source.starts.length === 0), true);
  assert.equal(rejectedContext.oscillators.every((source) => source.disconnected), true);
  assert.equal(rejectedEngine.getProfileBusSnapshots('live').every((bus) => bus.users === 0), true);
  rejectedEngine.dispose();

  const partialContext = new FakeContext();
  partialContext.failOnStartAttempt = 2;
  const partialEngine = new IndependentDrumEngine({ context: partialContext as unknown as BaseAudioContext, defaultProfile: profile() });
  assert.equal(partialEngine.drum(0, 0, profile(), 'live'), null);
  assert.equal(partialContext.oscillators.some((source) => source.starts.length > 0), true);
  assert.equal(partialEngine.runtime.pool.retainedCount(), 1);
  partialContext.currentTime = 2;
  partialContext.oscillators.forEach((source) => source.end());
  partialEngine.runtime.pool.all().forEach((voice) => voice.finishIfSilent(2));
  assert.equal(partialEngine.runtime.pool.retainedCount(), 0);
  assert.equal(partialEngine.getProfileBusSnapshots('live').every((bus) => bus.users === 0), true);
  partialEngine.dispose();
});

test('a rejected closed hat does not choke an existing open hat', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  engine.runtime.pool.setLimit('drums', 'live', 1);
  engine.runtime.pool.setTailLimit('drums', 'live', 1);
  const old = engine.drum(2, 0, profile(), 'live');
  assert.ok(old);
  context.currentTime = 1;
  const open = engine.drum(3, 1, profile(), 'live');
  assert.ok(open);
  const before = open!.voice.timing.releaseEndAt;
  // The old closed hat is still retained as an effect tail. Choking the new
  // open hat would exceed the one-object retained-tail budget, so the hit is
  // rejected before the hat choke runs.
  const rejected = engine.drum(2, 1.01, profile(), 'live');
  assert.equal(rejected, null);
  assert.equal(open!.voice.timing.releaseEndAt, before);
  engine.dispose();
});

test('drum disable stops retained hits and re-enable accepts only new hits', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile() });
  const active = engine.drum(0, 0, profile(), 'live');
  assert.ok(active);
  engine.setInstrumentEnabled(false, 1, false);
  assert.equal(engine.isInstrumentEnabled(), true);
  assert.ok(engine.drum(1, 1, profile(), 'live'));
  engine.commitInstrumentEnabled(false, 1);
  assert.equal(engine.isInstrumentEnabled(), false);
  assert.equal(engine.drum(1, 1.1, profile(), 'live'), null);
  engine.commitInstrumentEnabled(true, 2);
  assert.equal(engine.isInstrumentEnabled(), true);
  assert.ok(engine.drum(1, 2.1, profile(), 'live'));
  engine.panic();
  engine.dispose();
});

test('drum lane, velocity, profile and debug/deck/solo dispatch stay distinct', () => {
  const context = new FakeContext();
  const engine = new IndependentDrumEngine({ context: context as unknown as BaseAudioContext, defaultProfile: profile('Clean') });
  const builds = (['live', 'deckA', 'deckB', 'solo', 'debug'] as VoiceLane[]).map((lane, index) => engine.debugDrum(index, 0, profile(index === 4 ? 'Circuit' : 'Clean'), lane, index / 4));
  builds.forEach((build, index) => {
    assert.ok(build);
    assert.equal(build!.voice.lane, ['live', 'deckA', 'deckB', 'solo', 'debug'][index]);
    assert.equal(build!.voice.finalGain.gain.value, index / 4);
  });
  assert.deepEqual(engine.getVoiceSnapshots().map((snapshot) => snapshot.lane), ['live', 'deckA', 'deckB', 'solo', 'debug']);
  engine.dispose();
});
