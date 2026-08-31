import test from 'node:test';
import assert from 'node:assert/strict';
import { LegacySynthEngine } from '../src/audio.ts';
import { IndependentLeadEngine } from '../src/synth/independent-lead.ts';
import { IndependentChordEngine } from '../src/synth/independent-chords.ts';
import { LEAD_PRESETS, DEFAULT_LEAD_PROFILE } from '../src/synth/patches/lead.ts';
import { CHORD_PRESETS, DEFAULT_CHORD_PROFILE, normalizeChordProfile } from '../src/synth/patches/chords.ts';
import { boundaryMetric, INDEPENDENT_VOICE_THRESHOLDS } from './independent-lead-chords-offline-harness.ts';

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
class FakeDelay extends FakeNode { delayTime = new FakeParam(); }
class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  private typeValue: OscillatorType = 'sine';
  typeSetCount = 0;
  get type() { return this.typeValue; }
  set type(value: OscillatorType) { this.typeValue = value; this.typeSetCount += 1; }
  starts: number[] = [];
  stops: number[] = [];
  listeners: Array<() => void> = [];
  start(at = 0) { this.starts.push(at); }
  stop(at = 0) { this.stops.push(at); }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.push(listener); }
  end() { this.listeners.forEach((listener) => listener()); }
}
class FakeShaper extends FakeNode {
  private curveValue: Float32Array | null = null;
  private oversampleValue: OverSampleType = 'none';
  curveSetCount = 0;
  oversampleSetCount = 0;
  get curve() { return this.curveValue; }
  set curve(value: Float32Array | null) { this.curveValue = value; this.curveSetCount += 1; }
  get oversample() { return this.oversampleValue; }
  set oversample(value: OverSampleType) { this.oversampleValue = value; this.oversampleSetCount += 1; }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48_000;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  oscillatorCount = 0;
  oscillators: FakeOscillator[] = [];
  failOscillatorStartAt: number | null = null;
  createGain() { return new FakeGain(); }
  createBiquadFilter() { return new FakeFilter(); }
  createDelay() { return new FakeDelay(); }
  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    const shouldFail = this.failOscillatorStartAt === this.oscillatorCount;
    this.oscillatorCount += 1;
    const start = oscillator.start.bind(oscillator);
    oscillator.start = (at = 0) => { if (shouldFail) throw new Error('fake oscillator start failure'); start(at); };
    return oscillator;
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

const leadProfile = () => ({ ...DEFAULT_LEAD_PROFILE, controls: { ...DEFAULT_LEAD_PROFILE.controls }, parameters: { ...DEFAULT_LEAD_PROFILE.parameters } });
const chordProfile = () => ({ ...DEFAULT_CHORD_PROFILE, controls: { ...DEFAULT_CHORD_PROFILE.controls }, parameters: { ...DEFAULT_CHORD_PROFILE.parameters } });
const finishVoice = (voice: { sources: Set<AudioScheduledSourceNode> }) => [...voice.sources].forEach((source) => (source as unknown as FakeOscillator).end());
const reaches = (from: FakeNode, target: FakeNode, seen = new Set<FakeNode>()): boolean => {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return from.connections.some((next) => Array.isArray(next.connections) && reaches(next, target, seen));
};

test('independent lead sustains and releases duplicate same-pitch keys independently', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.holdNote('a', 60, leadProfile());
  lead.holdNote('b', 60, leadProfile());
  context.currentTime = .02;
  assert.equal(lead.hasHeldNote('a'), true);
  assert.equal(lead.hasHeldNote('b'), true);
  assert.equal(lead.runtime.pool.activeCount('lead', 'live'), 2);
  assert.equal(lead.releaseNote('a')?.id, 'a');
  context.currentTime = .03;
  assert.equal(lead.hasHeldNote('a'), false);
  assert.equal(lead.hasHeldNote('b'), true);
  assert.equal(lead.runtime.pool.retiringCount('lead', 'live'), 1);
  assert.equal(lead.releaseNote('b')?.id, 'b');
  assert.equal(lead.hasHeldNote('b'), false);
});

test('lead repeated notes use fresh independent voices at all short gaps', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  const gaps = [0, .001, .005, .01, .02, .05, .1];
  for (const [index, gap] of gaps.entries()) lead.note(60 + index, .11, gap, leadProfile(), 'deckA', .4 + index / 20);
  const voices = lead.runtime.pool.byLane('deckA');
  assert.equal(voices.length, gaps.length);
  assert.equal(new Set(voices.map((voice) => voice.finalGain)).size, gaps.length);
  const before = voices[0].envelope.timeline();
  lead.note(72, .2, .12, leadProfile(), 'deckA');
  assert.deepEqual(voices[0].envelope.timeline(), before);
});

test('lead held notes use separate live, deck, solo, and debug lanes', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.holdNote('live', 60, leadProfile());
  lead.note(64, .2, 0, leadProfile(), 'deckA');
  lead.note(67, .2, 0, leadProfile(), 'deckB');
  lead.note(69, .2, 0, leadProfile(), 'solo');
  lead.debugNote(71, .2, 0, leadProfile());
  for (const lane of ['live', 'deckA', 'deckB', 'solo', 'debug'] as const) assert.equal(lead.runtime.pool.byLane(lane).length, 1);
  lead.stopLane('deckA');
  assert.equal(lead.hasHeldNote('live'), true);
  assert.equal(lead.runtime.pool.byLane('deckB').length, 1);
});

test('lead source and effect paths cross finalGain before the profile bus', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.note(60, .2, 0, LEAD_PRESETS[6], 'deckA');
  const voice = lead.runtime.pool.byLane('deckA')[0];
  const bus = lead.runtime.laneState('deckA').profileBuses.values().next().value;
  assert.ok(bus);
  for (const source of [...voice.sources].slice(0, 2)) assert.equal(reaches(source as unknown as FakeNode, bus.output as unknown as FakeNode), true);
  assert.equal(voice.finalGain.connections.length >= 1, true, 'all effect paths start at finalGain');
  assert.equal(voice.nodes.has(voice.finalGain), true);
});

test('lead profile snapshots are immutable and old voices do not change', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  const profile = leadProfile();
  lead.note(60, .2, 0, profile, 'deckA');
  const voice = lead.runtime.pool.byLane('deckA')[0];
  const before = JSON.stringify(voice.profile.profile);
  profile.controls.tone = .01;
  profile.parameters.filterHz = 200;
  assert.equal(JSON.stringify(voice.profile.profile), before);
  assert.equal(Object.isFrozen(voice.profile.profile), true);
});

test('lead disable safely stops existing voices and blocks new allocation', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.note(60, .2, 0, leadProfile(), 'deckA');
  lead.setInstrumentEnabled(false);
  assert.equal(lead.isInstrumentEnabled(), false);
  assert.deepEqual(lead.note(62, .2, 0, leadProfile(), 'deckA'), []);
  assert.equal(lead.runtime.pool.activeCount('lead', 'deckA'), 0);
  lead.setInstrumentEnabled(true);
  lead.note(64, .2, 0, leadProfile(), 'deckA');
  assert.equal(lead.runtime.pool.retainedCount('lead', 'deckA') >= 1, true);
});

test('lead rejected and partial-start voices are aborted without retained pool entries', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  for (let index = 0; index < 8; index += 1) lead.note(48 + index, .2, 0, leadProfile(), 'live');
  context.currentTime = .01;
  for (let index = 0; index < 16; index += 1) lead.note(72 + index, .2, 0, leadProfile(), 'live');
  assert.equal(lead.runtime.pool.retainedCount('lead', 'live') <= 8 + lead.runtime.pool.retainedTailLimit('lead', 'live'), true);
  const failingContext = new FakeContext();
  failingContext.failOscillatorStartAt = 0;
  const failingLead = new IndependentLeadEngine({ context: failingContext as unknown as BaseAudioContext });
  assert.deepEqual(failingLead.note(60, .2, 0, leadProfile(), 'live'), []);
  assert.equal(failingLead.runtime.pool.retainedCount('lead', 'live'), 0);
});

test('repeated and overlapping chord events remain separate VoiceGroups', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.chord([48, 52, 55, 59], .25, 0, chordProfile(), 'deckA', 1);
  chords.chord([48, 52, 55, 59], .25, .05, chordProfile(), 'deckA', .7);
  chords.chord([50, 53, 57, 60], null, 0, chordProfile(), 'deckB', 1);
  const groups = chords.getGroups();
  assert.equal(groups.length, 3);
  assert.equal(groups[0].children.length, 4);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 8);
  assert.ok(groups[0].children.every((voice) => voice.timing.startAt === groups[0].children[0].timing.startAt));
  const firstTimelines = groups[0].children.map((voice) => JSON.stringify(voice.envelope.timeline()));
  chords.chord([48, 52, 55, 59], .1, .1, chordProfile(), 'deckA', 1);
  assert.deepEqual(groups[0].children.map((voice) => JSON.stringify(voice.envelope.timeline())), firstTimelines);
});

test('chord group releases all pitch voices at one time and keys release independently', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.holdChord('a', [48, 52, 55], chordProfile());
  chords.holdChord('b', [50, 53, 57], chordProfile());
  assert.equal(chords.hasHeldNote('a'), true);
  assert.equal(chords.hasHeldNote('b'), true);
  const result = chords.releaseChord('a');
  assert.equal(result?.voiceCount, 3);
  const releasedGroup = chords.getGroups().find((group) => group.children[0].timing.noteOffAt !== null);
  assert.ok(releasedGroup);
  const noteOffs = releasedGroup.children.map((voice) => voice.timing.noteOffAt);
  assert.equal(new Set(noteOffs).size, 1);
  assert.equal(chords.hasHeldNote('b'), true);
  context.currentTime = .01;
  assert.equal(chords.runtime.pool.activeCount('chords', 'live'), 3);
});

test('chord pitch source paths cross each child finalGain and profile snapshots are immutable', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  const profile = chordProfile();
  chords.chord([48, 52], .2, 0, profile, 'deckA');
  const voices = chords.getGroups()[0].children;
  const bus = chords.runtime.laneState('deckA').profileBuses.values().next().value;
  assert.ok(bus);
  profile.controls.tone = .99;
  for (const voice of voices) {
    assert.equal(Object.isFrozen(voice.profile.profile), true);
    assert.equal([...voice.sources].every((source) => reaches(source as unknown as FakeNode, bus.output as unknown as FakeNode)), true);
    assert.equal(voice.finalGain.connections.length >= 1, true);
  }
});

test('chord detune uses the legacy linear frequency offsets', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  const profile = chordProfile();
  const patch = normalizeChordProfile(profile, context.sampleRate);
  chords.chord([60], .2, 0, profile, 'deckA');
  const [left, right] = context.oscillators;
  const frequency = 440 * Math.pow(2, (60 - 69) / 12);
  const expectedLeft = frequency * (1 - patch.detuneCents / 1200);
  const expectedRight = frequency * (1 + patch.detuneCents / 1200);
  assert.equal(left.frequency.operations.at(-1)?.value, expectedLeft);
  assert.equal(right.frequency.operations.at(-1)?.value, expectedRight);
});

test('pre-scheduling 32 non-overlapping lead events accepts every event', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  let accepted = 0;
  for (let index = 0; index < 32; index += 1) {
    if (lead.note(48 + index % 8, .111, index * .25, leadProfile(), 'deckA').length > 0) accepted += 1;
  }
  assert.equal(accepted, 32);
  assert.equal(lead.runtime.pool.retainedCount('lead', 'deckA'), 32);
  assert.equal(lead.runtime.pool.allocatedCount('lead', 'deckA', 0), 1);
  assert.equal(lead.runtime.pool.allocatedCount('lead', 'deckA', 7.75), 3);
});

test('chord pool capacity counts pitches and rejects a whole over-capacity event cleanly', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.runtime.pool.setTailLimit('chords', 'deckA', 1);
  for (let index = 0; index < 6; index += 1) chords.chord([48, 52, 55, 59], .2, 0, chordProfile(), 'deckA');
  assert.equal(chords.runtime.pool.allocatedCount('chords', 'deckA'), 24);
  assert.deepEqual(chords.chord([48, 52], .2, 0, chordProfile(), 'deckA'), []);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 24);
});

test('chord allocation is atomic when the whole group cannot fit', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.runtime.pool.setLimit('chords', 'deckA', 3);
  assert.deepEqual(chords.chord([48, 52, 55, 59], .2, 0, chordProfile(), 'deckA'), []);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 0);
  assert.equal(chords.getGroups().length, 0);
  assert.equal(context.oscillators.every((oscillator) => oscillator.starts.length === 0), true);
  assert.equal(chords.getProfileBusSnapshots('deckA').every((bus) => (bus as { users: number }).users === 0), true);
});

test('chord allocation rejects without changing existing voices when retiring capacity is full', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.runtime.pool.setTailLimit('chords', 'deckA', 8);
  for (let index = 0; index < 8; index += 1) chords.chord([40 + index], null, 0, chordProfile(), 'deckA');
  const retiring = chords.runtime.pool.byLane('deckA').slice(0, 8);
  retiring.forEach((voice) => voice.release(0, .012));
  for (let index = 0; index < 22; index += 1) chords.chord([60 + index], null, .02, chordProfile(), 'deckA');
  const before = chords.runtime.pool.snapshot();
  assert.equal(chords.runtime.pool.allocatedCount('chords', 'deckA', .02), 22);
  assert.equal(chords.runtime.pool.retainedTailCount('chords', 'deckA', .02), 8);
  assert.deepEqual(chords.chord([48, 52, 55, 59], .2, .02, chordProfile(), 'deckA'), []);
  assert.deepEqual(chords.runtime.pool.snapshot(), before);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 30);
});

test('out-of-order overlapping chord groups remain atomic when tail capacity is full', () => {
  const context = new FakeContext();
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.runtime.pool.setLimit('chords', 'deckA', 4);
  chords.runtime.pool.setTailLimit('chords', 'deckA', 8);

  // The second same-time group safely fills the eight retained-tail slots by
  // choking the first group. A later overlap must reject as one whole group.
  assert.equal(chords.chord([40, 44, 47, 51], .1, 0, chordProfile(), 'deckA').length, 12);
  assert.equal(chords.chord([41, 45, 48, 52], .1, 0, chordProfile(), 'deckA').length, 12);
  const late = chords.chord([60, 64, 67, 71], 2, 10, chordProfile(), 'deckA');
  assert.equal(late.length, 12);
  const oldTiming = chords.runtime.pool.byLane('deckA').filter((voice) => voice.timing.startAt === 10).map((voice) => ({ noteOffAt: voice.timing.noteOffAt, releaseEndAt: voice.timing.releaseEndAt }));
  const oldRetained = chords.runtime.pool.retainedCount('chords', 'deckA');
  const oldGroups = chords.getGroups().length;
  const oldBusUsers = [...chords.runtime.laneState('deckA').profileBuses.values()].reduce((sum, bus) => sum + Number((bus as { users: number }).users), 0);
  const oscillatorCount = context.oscillators.length;

  assert.deepEqual(chords.chord([55, 59, 62, 65], 10, 5, chordProfile(), 'deckA'), []);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), oldRetained);
  assert.equal(chords.getGroups().length, oldGroups);
  assert.deepEqual(chords.runtime.pool.byLane('deckA').filter((voice) => voice.timing.startAt === 10).map((voice) => ({ noteOffAt: voice.timing.noteOffAt, releaseEndAt: voice.timing.releaseEndAt })), oldTiming);
  assert.equal([...chords.runtime.laneState('deckA').profileBuses.values()].reduce((sum, bus) => sum + Number((bus as { users: number }).users), 0), oldBusUsers);
  assert.equal(context.oscillators.slice(oscillatorCount).every((oscillator) => oscillator.starts.length === 0), true);
});

test('later chord source-start failure rolls back every child and bus retain', () => {
  const context = new FakeContext();
  context.failOscillatorStartAt = 3;
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  assert.deepEqual(chords.chord([48, 52], .2, 0, chordProfile(), 'deckA'), []);
  for (const oscillator of context.oscillators) oscillator.end();
  context.currentTime = 1;
  for (const voice of chords.runtime.pool.all()) voice.finishIfSilent(context.currentTime);
  assert.equal(chords.getGroups().length, 0);
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 0);
  assert.equal(chords.getProfileBusSnapshots('deckA').every((bus) => (bus as { users: number }).users === 0), true);
});

test('effect tails keep lead and chord paths connected until their declared drain time', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.note(60, .1, 0, LEAD_PRESETS[5], 'deckA');
  const leadVoice = lead.runtime.pool.byLane('deckA')[0];
  assert.ok(leadVoice.effectTailSeconds > 0);
  context.currentTime = .1;
  leadVoice.release(.1, .45);
  finishVoice(leadVoice);
  assert.equal(leadVoice.finalGain.disconnected, false);
  context.currentTime = leadVoice.effectTailEndAt + .001;
  leadVoice.finishIfSilent(context.currentTime);
  assert.equal(leadVoice.finalGain.disconnected, true);

  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.chord([48, 52, 55, 59], .1, context.currentTime, CHORD_PRESETS[5], 'deckA');
  const chordVoices = chords.getGroups()[0].children;
  assert.ok(chordVoices.every((voice) => voice.effectTailSeconds > 0));
  context.currentTime += .1;
  chordVoices.forEach((voice) => voice.release(context.currentTime, .45));
  chordVoices.forEach((voice) => finishVoice(voice));
  assert.equal(chordVoices.every((voice) => !voice.finalGain.disconnected), true);
  context.currentTime = Math.max(...chordVoices.map((voice) => voice.effectTailEndAt)) + .001;
  chordVoices.forEach((voice) => voice.finishIfSilent(context.currentTime));
  assert.equal(chordVoices.every((voice) => voice.finalGain.disconnected), true);
});

test('lead profile buses remain reusable after a voice ends and chord groups retire', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  lead.note(60, .2, 0, leadProfile(), 'deckA');
  const first = lead.runtime.pool.byLane('deckA')[0];
  const firstBus = lead.runtime.laneState('deckA').profileBuses.values().next().value;
  finishVoice(first);
  context.currentTime = first.cleanupAt + .001;
  first.finishIfSilent(context.currentTime);
  assert.equal(lead.runtime.pool.retainedCount('lead', 'deckA'), 0);
  assert.ok(firstBus && !firstBus.output.disconnected);
  lead.note(62, .2, .3, leadProfile(), 'deckA');
  const secondBus = lead.runtime.laneState('deckA').profileBuses.values().next().value;
  assert.equal(secondBus, firstBus);

  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  chords.chord([48, 52], .2, 0, chordProfile(), 'deckA');
  const group = chords.getGroups()[0];
  group.children.forEach((voice) => finishVoice(voice));
  context.currentTime = Math.max(...group.children.map((voice) => voice.cleanupAt)) + .001;
  group.children.forEach((voice) => voice.finishIfSilent(context.currentTime));
  assert.equal(group.state, 'stopped');
  assert.equal(chords.runtime.pool.retainedCount('chords', 'deckA'), 0);
  assert.equal(chords.getGroups().length, 0);
});

test('independent lead/chord preset IDs and values match LegacySynthEngine after preset load', () => {
  const legacy = new LegacySynthEngine();
  LEAD_PRESETS.forEach((preset, index) => {
    legacy.loadPreset('lead', index);
    assert.deepEqual(preset, legacy.getSoundProfile('lead', preset.presetId));
  });
  CHORD_PRESETS.forEach((preset, index) => {
    legacy.loadPreset('chords', index);
    assert.deepEqual(preset, legacy.getSoundProfile('chords', preset.presetId));
  });
  legacy.dispose();
});

test('independent lead and chords cleanup reaches every voice and cached bus', () => {
  const context = new FakeContext();
  const lead = new IndependentLeadEngine({ context: context as unknown as BaseAudioContext });
  const chords = new IndependentChordEngine({ context: context as unknown as BaseAudioContext });
  lead.note(60, .2, 0, leadProfile(), 'live');
  chords.chord([48, 52, 55], .2, 0, chordProfile(), 'live');
  context.currentTime = .01;
  const leadVoices = lead.runtime.pool.all();
  const chordVoices = chords.runtime.pool.all();
  const leadBuses = [...lead.runtime.laneState('live').profileBuses.values()];
  const chordBuses = [...chords.runtime.laneState('live').profileBuses.values()];
  lead.dispose(); chords.dispose();
  assert.equal(leadVoices.every((voice) => voice.state === 'releasing' && !voice.finalGain.disconnected && voice.nodes.size > 0), true);
  assert.equal(chordVoices.every((voice) => voice.state === 'releasing' && !voice.finalGain.disconnected && voice.nodes.size > 0), true);
  leadVoices.forEach((voice) => finishVoice(voice));
  chordVoices.forEach((voice) => finishVoice(voice));
  context.currentTime = Math.max(...leadVoices.map((voice) => voice.cleanupAt), ...chordVoices.map((voice) => voice.cleanupAt)) + .001;
  leadVoices.forEach((voice) => voice.finishIfSilent(context.currentTime));
  chordVoices.forEach((voice) => voice.finishIfSilent(context.currentTime));
  assert.equal(lead.runtime.pool.retainedCount(), 0);
  assert.equal(chords.runtime.pool.retainedCount(), 0);
  assert.equal(leadVoices.every((voice) => voice.nodes.size === 0 && voice.finalGain.disconnected), true);
  assert.equal(chordVoices.every((voice) => voice.nodes.size === 0 && voice.finalGain.disconnected), true);
  assert.equal(leadBuses.every((bus) => bus.snapshot().users === 0 && bus.output.disconnected), true);
  assert.equal(chordBuses.every((bus) => bus.snapshot().users === 0 && bus.output.disconnected), true);
});

test('offline boundary detector catches a deliberately discontinuous control signal', () => {
  const samples = new Float32Array(4096);
  for (let index = 0; index < samples.length; index += 1) samples[index] = index < 2048 ? 0 : .5;
  const metric = boundaryMetric(samples, 2048 / 44_100, 44_100, 'note-off');
  assert.equal(metric.boundaryPassed, false);
  assert.ok(metric.maxAdjacentSampleDelta > metric.boundaryThreshold);
  assert.equal(INDEPENDENT_VOICE_THRESHOLDS.boundary.absoluteFloor, .015);
});
