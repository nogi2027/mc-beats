import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckRecorder, SharedDeckTransport, SingleDeck, DECK_TICKS, EIGHTH_NOTE_TICKS, type RecordedTake } from '../src/deck.ts';
import { BassVcaController, PERSISTENT_BASS_LANES, SynthEngine, bassLaneNoteIsAudibleAt, linearFadeValue } from '../src/audio.ts';
import { BAR_TICKS, SOLO_OPENING_TICKS, MusicController, absoluteTickOf, fractionalMidiOf, isMusicalTime, musicalTimeOf, planHeldRetriggerProbe, quantizeMusicalTime } from '../src/music-controller.ts';
import { buildWebMcpTools, registerWebMcp } from '../src/webmcp.ts';
import { KeyboardPressRegistry } from '../src/keyboard-input.ts';
import type { DeckSoundProfile } from '../src/deck.ts';

const time = (bar: number, tick = 0, cycle = 0) => ({ cycle, bar, tick });
const soloOpening = (instrument: 'bass' | 'lead' = 'lead', prefix = 'opening') => [
  { type: 'note' as const, id: `${prefix}-1`, offsetTicks: 0, instrument, durationTicks: EIGHTH_NOTE_TICKS, pitch: instrument === 'bass' ? 36 : 72, velocity: .8 },
  { type: 'note' as const, id: `${prefix}-2`, offsetTicks: BAR_TICKS, instrument, durationTicks: EIGHTH_NOTE_TICKS, pitch: instrument === 'bass' ? 39 : 75, velocity: .8 },
];
const profileVariant = (source: DeckSoundProfile, presetId: string, volume: number, controlName = Object.keys(source.controls)[0]) => ({
  ...source,
  presetId,
  volume,
  controls: { ...source.controls, [controlName]: Math.max(0, Math.min(1, source.controls[controlName] + .2)) },
});
const runningController = () => {
  const engine = new SynthEngine();
  engine.context = { currentTime: 0, sampleRate: 48000, state: 'running', close: async () => {} } as unknown as AudioContext;
  const controller = new MusicController(engine);
  (controller as unknown as { clockRunning: boolean }).clockRunning = true;
  controller.transport.isPlaying = () => true;
  return controller;
};

type FakeParamOperation = {
  method: string;
  value?: number | string;
  start: number;
  duration: number;
};

class FakeParam {
  value = 0;
  setValueAtTimeCalls = 0;
  operations: FakeParamOperation[] = [];
  lastCurveValues: number[] | undefined;
  private lastTime = 0;
  private heldStart: number | undefined;
  private record(operation: FakeParamOperation) { this.operations.push(operation); }
  setValueAtTime(value: number, start = 0) { this.setValueAtTimeCalls += 1; this.value = value; this.lastTime = start; this.heldStart = undefined; this.record({ method: 'setValueAtTime', value, start, duration: 0 }); return this; }
  setTargetAtTime(value: number, start = 0, duration = 0) { this.value = value; this.lastTime = start; this.heldStart = undefined; this.record({ method: 'setTargetAtTime', value, start, duration }); return this; }
  exponentialRampToValueAtTime(value: number, end = 0) { const start = this.heldStart ?? this.lastTime; this.value = value; this.lastTime = end; this.heldStart = undefined; this.record({ method: 'exponentialRampToValueAtTime', value, start, duration: Math.max(0, end - start) }); return this; }
  linearRampToValueAtTime(value: number, end = 0) { const start = this.heldStart ?? this.lastTime; this.value = value; this.lastTime = end; this.heldStart = undefined; this.record({ method: 'linearRampToValueAtTime', value, start, duration: Math.max(0, end - start) }); return this; }
  setValueCurveAtTime(values: Float32Array, start = 0, duration = 0) {
    this.value = values[values.length - 1] ?? 0;
    this.lastCurveValues = Array.from(values);
    this.lastTime = start + duration;
    this.heldStart = undefined;
    this.record({ method: 'setValueCurveAtTime', value: `${values[0] ?? 0}:${values[values.length - 1] ?? 0}:${values.length}`, start, duration });
    return this;
  }
  cancelAndHoldAtTime(start = 0) { this.lastTime = start; this.heldStart = start; this.record({ method: 'cancelAndHoldAtTime', start, duration: 0 }); return this; }
  cancelScheduledValues(start = 0) { this.lastTime = start; this.heldStart = start; this.record({ method: 'cancelScheduledValues', start, duration: 0 }); return this; }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  detune = new FakeParam();
  delayTime = new FakeParam();
  Q = new FakeParam();
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  connect() { return this; }
  disconnect() {}
}
class FakeOscillatorNode extends FakeNode {
  private oscillatorType = 'sine';
  typeSetCount = 0;
  get type() { return this.oscillatorType; }
  set type(value: OscillatorType) { this.typeSetCount += 1; this.oscillatorType = value; }
  listeners = new Map<string, Array<() => void>>();
  start() {}
  stop() {}
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
}
class FakeWaveShaperNode extends FakeNode {
  private currentCurve: Float32Array | null = null;
  private currentOversample = 'none';
  curveSetCount = 0;
  oversampleSetCount = 0;
  lastCurveValues: number[] | undefined;
  get curve() { return this.currentCurve; }
  set curve(value: Float32Array | null) { this.curveSetCount += 1; this.currentCurve = value; this.lastCurveValues = value ? Array.from(value) : undefined; }
  get oversample() { return this.currentOversample; }
  set oversample(value: string) { this.oversampleSetCount += 1; this.currentOversample = value; }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  getFloatFrequencyData(values: Float32Array) { values.fill(-100); }
  getFloatTimeDomainData(values: Float32Array) { values.fill(0); }
}
class FakeAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  state: AudioContextState = 'suspended';
  destination = new FakeNode();
  oscillators: FakeOscillatorNode[] = [];
  resume = async () => { this.state = 'running'; };
  close = async () => { this.state = 'closed'; };
  createGain() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeAnalyser(); }
  createDelay() { return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createWaveShaper() { return new FakeWaveShaperNode(); }
  createOscillator() { const source = new FakeOscillatorNode(); this.oscillators.push(source); return source; }
  createBuffer(_channels: number, length: number) { return { getChannelData: () => new Float32Array(length) }; }
}

type TestBassLane = {
  main: FakeOscillatorNode;
  sub: FakeOscillatorNode;
  click: FakeOscillatorNode;
  mainGain: FakeNode;
  subGain: FakeNode;
  filter: FakeNode;
  clickFilter: FakeNode;
  shaper: FakeWaveShaperNode;
  profileGain: FakeNode;
  envelope: FakeNode;
  gate: FakeNode;
  envelopeState: BassVcaController;
  vca: BassVcaController;
  current: { token: number; gateEnd: number | null; releaseEnd?: number; heldId?: string } | null;
  currentHeldId?: string;
  envelopeResetToken?: number;
  profileState: unknown;
  pendingProfile?: unknown;
};

const bassLanesOf = (engine: SynthEngine) => (engine as unknown as { bassLanes: Map<string, TestBassLane> }).bassLanes;
const bassGraphWrites = (lane: TestBassLane) => ({
  curve: lane.shaper.curveSetCount,
  oversample: lane.shaper.oversampleSetCount,
  mainType: lane.main.typeSetCount,
  subType: lane.sub.typeSetCount,
  clickType: lane.click.typeSetCount,
  mainGain: lane.mainGain.gain.operations.length,
  subGain: lane.subGain.gain.operations.length,
  filter: lane.filter.frequency.operations.length,
  clickFrequency: lane.click.frequency.operations.length,
  clickFilter: lane.clickFilter.frequency.operations.length,
  profileGain: lane.profileGain.gain.operations.length,
});
const assertBassGraphUnchanged = (lane: TestBassLane, before: ReturnType<typeof bassGraphWrites>) => {
  assert.deepEqual(bassGraphWrites(lane), before);
};
const withFakeAudio = async <T>(run: (engine: SynthEngine, context: FakeAudioContext) => T | Promise<T>) => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  try {
    await engine.start();
    return await run(engine, engine.context as unknown as FakeAudioContext);
  } finally {
    engine.dispose();
    if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    else (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = previousAudioContext;
  }
};

test('global musical time uses 24-bar cycles and converts both ways', () => {
  assert.equal(absoluteTickOf(time(1, 480)), 2400);
  assert.deepEqual(musicalTimeOf(24 * 1920 + 960), time(0, 960, 1));
  assert.equal(isMusicalTime(time(23, 1919)), true);
  assert.equal(isMusicalTime(time(24, 0)), false);
  assert.deepEqual(quantizeMusicalTime(time(0, 241)), time(0, 480));
  assert.deepEqual(quantizeMusicalTime(time(0, 1), true), time(1, 0));
});

test('held retrigger plans sort positive, zero, and negative overlaps deterministically', () => {
  const positive = planHeldRetriggerProbe({ firstId: 'first', secondId: 'second', firstHoldMs: 100, retriggerGapMs: 20, secondHoldMs: 40 }, 10);
  assert.deepEqual(positive.operations.map((operation) => operation.action), ['hold', 'release', 'hold', 'release']);
  assert.deepEqual(positive.operations.map((operation) => operation.id), ['first', 'first', 'second', 'second']);

  const zero = planHeldRetriggerProbe({ firstId: 'first', secondId: 'second', firstHoldMs: 100, retriggerGapMs: 0, secondHoldMs: 40 }, 10);
  assert.deepEqual(zero.operations.map((operation) => operation.action), ['hold', 'release', 'hold', 'release']);

  const negative = planHeldRetriggerProbe({ firstId: 'first', secondId: 'second', firstHoldMs: 100, retriggerGapMs: -50, secondHoldMs: 10 }, 10);
  assert.deepEqual(negative.operations.map((operation) => operation.action), ['hold', 'hold', 'release', 'release']);
  assert.equal(negative.operations[1].id, 'second');
  assert.ok(Math.abs(negative.captureWindow.end - 10.175) < 1e-9);
});

test('controller owns independent Deck A and Deck B state', () => {
  const controller = new MusicController(new SynthEngine());
  controller.decks.A.addNote('bass', 36, 0, EIGHTH_NOTE_TICKS);
  controller.decks.B.addNote('bass', 48, 0, EIGHTH_NOTE_TICKS);
  const state = controller.getState();
  assert.equal(state.decks.A.events.bass[0].pitch, 36);
  assert.equal(state.decks.B.events.bass[0].pitch, 48);
  assert.equal(state.clock.deckPhaseTick, 0);
  controller.dispose();
});

test('controller switches the active deck without merging deck contents', () => {
  const controller = new MusicController(new SynthEngine());
  controller.selectActiveDeck('B');
  assert.equal(controller.getState().activeDeck, 'B');
  controller.selectActiveDeck('A');
  assert.equal(controller.getState().activeDeck, 'A');
  assert.equal(controller.decks.A.eventCount(), 0);
  assert.equal(controller.decks.B.eventCount(), 0);
  controller.dispose();
});

test('the shared clock freezes on stop and retime preserves its absolute tick', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let nextTimer = 1;
  (globalThis as { window?: unknown }).window = { setInterval: () => nextTimer++, clearInterval: () => {} };
  const engine = new SynthEngine();
  const context = { currentTime: 0, sampleRate: 48000, state: 'running', close: async () => {} } as unknown as AudioContext;
  engine.context = context;
  const controller = new MusicController(engine);
  assert.equal(controller.transport.start(0), true);
  context.currentTime = 1;
  assert.equal(Math.round(controller.clockSnapshot().absoluteTick), 960);
  controller.transport.stop();
  context.currentTime = 3;
  assert.equal(Math.round(controller.clockSnapshot().absoluteTick), 960);
  controller.transport.start();
  context.currentTime = 3.5;
  assert.equal(Math.round(controller.clockSnapshot().absoluteTick), 1440);
  engine.tempo = 60;
  controller.transport.retime();
  const anchor = controller.transport.anchor();
  assert.equal(Math.round(anchor.tickAnchor), 1440);
  assert.ok(Math.abs(anchor.startAt - 3.5) < .0001);
  controller.dispose();
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
});

test('controller owns normal and recording transport starts with one shared clock', async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { setInterval: () => 1, clearInterval: () => {} };
  const engine = new SynthEngine();
  const context = { currentTime: 0, sampleRate: 48000, state: 'running', close: async () => {} } as unknown as AudioContext;
  engine.context = context;
  const controller = new MusicController(engine);
  try {
    const result = await controller.startTransport();
    assert.equal(result.ok, true);
    assert.equal(controller.getState().clock.running, true);
    controller.stopTransport();
    assert.equal(controller.getState().clock.running, false);
    const recording = controller.startRecordingTransport(2, 'lead', true);
    assert.equal(recording.ok, true);
    assert.equal(controller.transport.isPlaying(), true);
    assert.equal(controller.transport.anchor().startAt, 2);
    assert.equal(controller.setRecordingInstrumentMuted('lead', false).ok, true);
    assert.equal(controller.retimeRecordingTransport(3).ok, true);
    assert.equal(controller.catchUpRecordingEvents('A', 'lead', []).ok, true);
  } finally {
    controller.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('cue actions are pending until explicitly executed and undo restores the transaction', () => {
  const controller = runningController();
  const queued = controller.queueAction(time(0, 480), { type: 'add-deck-events', deck: 'A', instrument: 'bass', events: [{ type: 'note', instrument: 'bass', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 36, velocity: 1 }] });
  assert.equal(queued.ok, true);
  assert.equal(controller.decks.A.eventCount(), 0);
  const cueId = queued.data!.cueId;
  assert.equal(controller.executeCueNow(cueId).ok, true);
  assert.equal(controller.decks.A.snapshot().events.bass.length, 1);
  assert.equal(controller.undoLastAgentAction().ok, true);
  assert.equal(controller.decks.A.eventCount(), 0);
  controller.dispose();
});

test('agent undo removes only its added event and preserves later human input', () => {
  const controller = runningController();
  const queued = controller.queueAction(time(1), { type: 'add-deck-events', deck: 'A', instrument: 'lead', events: [{ type: 'note', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 60, velocity: 1 }] });
  assert.equal(queued.ok, true);
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  controller.decks.A.addNote('lead', 64, EIGHTH_NOTE_TICKS, EIGHTH_NOTE_TICKS, 1, 1, 'human-lead');
  controller.humanDeckMutation('A', 'lead');
  assert.equal(controller.undoLastAgentAction().ok, true);
  assert.deepEqual(controller.decks.A.events('lead').map((event) => event.id), ['human-lead']);
  controller.dispose();
});

test('agent range undo merges around a later human event outside the range', () => {
  const controller = runningController();
  controller.decks.A.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'original');
  const queued = controller.queueAction(time(1), {
    type: 'replace-deck-events',
    deck: 'A',
    instrument: 'lead',
    fromTick: 0,
    toTick: EIGHTH_NOTE_TICKS,
    events: [{ type: 'note', id: 'agent-replacement', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 67, velocity: 1 }],
  });
  assert.equal(queued.ok, true);
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  controller.decks.A.addNote('lead', 72, EIGHTH_NOTE_TICKS, EIGHTH_NOTE_TICKS, 1, 1, 'human-later');
  controller.humanDeckMutation('A', 'lead');

  assert.equal(controller.undoLastAgentAction().ok, true);
  assert.deepEqual(controller.decks.A.events('lead').map((event) => event.id), ['original', 'human-later']);
  controller.dispose();
});

test('agent undo reports a conflict after a later human profile change', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('lead', 'agent-profile');
  const queued = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile });
  assert.equal(queued.ok, true);
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  controller.decks.A.setSoundProfile('lead', { ...profile, presetId: 'human-profile' });
  controller.humanProfileMutation('A', 'lead');
  const undone = controller.undoLastAgentAction();
  assert.equal(undone.ok, false);
  assert.equal(undone.code, 'UNDO_CONFLICT');
  assert.equal(controller.decks.A.profile('lead')?.presetId, 'human-profile');
  controller.dispose();
});

test('cue actions mutate profiles and global instrument state atomically', () => {
  const controller = runningController();
  const profile: DeckSoundProfile = controller.engine.getSoundProfile('lead', 'test');
  const enabled = controller.queueAction(time(1), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(enabled.ok, true);
  assert.equal(controller.executeCueNow(enabled.data!.cueId).ok, true);
  assert.equal(controller.getState().instrumentEnabled.bass, false);
  const setProfile = controller.queueAction(time(2), { type: 'set-deck-sound-profile', deck: 'B', instrument: 'lead', profile });
  assert.equal(setProfile.ok, true);
  assert.equal(controller.executeCueNow(setProfile.data!.cueId).ok, true);
  assert.deepEqual(controller.decks.B.soundProfiles().lead, profile);
  controller.dispose();
});

test('cut and blend transfer state move the active deck without changing deck data', () => {
  const controller = runningController();
  controller.decks.A.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS);
  controller.decks.B.addNote('lead', 72, 0, EIGHTH_NOTE_TICKS);
  const cut = controller.queueAction(time(1), { type: 'transfer-deck', destination: 'B', style: 'cut', durationTicks: 0 });
  assert.equal(cut.ok, true);
  assert.equal(controller.executeCueNow(cut.data!.cueId).ok, true);
  assert.equal(controller.getState().activeDeck, 'B');
  const blend = controller.queueAction(time(2), { type: 'transfer-deck', destination: 'A', style: 'blend', durationTicks: 0 });
  assert.equal(blend.ok, true);
  assert.equal(controller.executeCueNow(blend.data!.cueId).ok, true);
  assert.equal(controller.getState().activeDeck, 'A');
  assert.equal(controller.decks.A.eventCount(), 1);
  assert.equal(controller.decks.B.eventCount(), 1);
  controller.dispose();
});

test('human crossfader preserves its drag position while cut audio follows the midpoint', () => {
  const controller = runningController();
  assert.equal(controller.humanSetCrossfade(.25, 'blend'), .25);
  assert.equal(controller.getState().crossfadePosition, .25);
  assert.equal(controller.getState().activeDeck, 'A');
  assert.equal(controller.humanSetCrossfade(.75, 'blend'), .75);
  assert.equal(controller.getState().crossfadePosition, .75);
  assert.equal(controller.getState().activeDeck, 'B');
  assert.equal(controller.humanSetCrossfade(.49, 'cut'), .49);
  assert.equal(controller.getState().crossfadePosition, .49);
  assert.equal(controller.getState().activeDeck, 'A');
  controller.dispose();
});

test('output controls clamp safely and serialize with the synth snapshot', () => {
  const engine = new SynthEngine();
  engine.setOutputControl('masterVolume', 2);
  engine.setOutputControl('eqLowDb', -30);
  engine.setOutputControl('echoFeedback', .9);
  engine.setOutputControl('echoTimeMs', 500);
  const output = engine.getSynthSnapshot().outputControls!;
  assert.equal(output.masterVolume, 1);
  assert.equal(output.eqLowDb, -12);
  assert.equal(output.echoFeedback, .75);
  assert.equal(output.echoTimeMs, 500);
  engine.dispose();
});

test('output controls update the live master, EQ, and echo graph', async () => {
  await withFakeAudio(async (engine) => {
    const nodes = engine as unknown as { master: FakeNode; outputEqLow: FakeNode; outputEcho: FakeNode; outputEchoFeedback: FakeNode; outputEchoWet: FakeNode };
    engine.setOutputControl('masterVolume', .8);
    engine.setOutputControl('eqLowDb', 6);
    engine.setOutputControl('echoTimeMs', 420);
    engine.setOutputControl('echoFeedback', .5);
    engine.setOutputControl('echoMix', .6);
    assert.ok(Math.abs(nodes.master.gain.value - .56) < 1e-9);
    assert.equal(nodes.outputEqLow.gain.value, 6);
    assert.equal(nodes.outputEcho.delayTime.value, .42);
    assert.equal(nodes.outputEchoFeedback.gain.value, .5);
    assert.ok(Math.abs(nodes.outputEchoWet.gain.value - .27) < 1e-9);
  });
});

test('cancelling a lookahead transfer restores both deck lane targets', () => {
  const controller = runningController();
  const queued = controller.queueAction(time(1), { type: 'transfer-deck', destination: 'B', style: 'blend', durationTicks: EIGHTH_NOTE_TICKS * 2 });
  assert.equal(queued.ok, true);
  const privateController = controller as unknown as { pendingCues: Array<{ id: string; action: unknown }>; scheduleCueAudio: (cue: { id: string; action: unknown }, at: number) => void; preScheduledAudio: Map<string, unknown> };
  const cue = privateController.pendingCues[0];
  let cancelCount = 0;
  let rampCount = 0;
  const engine = controller.engine as unknown as { cancelLaneGainAutomation: () => void; setLaneGainRamp: () => void };
  engine.cancelLaneGainAutomation = () => { cancelCount += 1; };
  engine.setLaneGainRamp = () => { rampCount += 1; };
  privateController.scheduleCueAudio(cue, 1);
  const beforeCancelRamps = rampCount;
  assert.equal(controller.cancelCue(cue.id).ok, true);
  assert.equal(privateController.preScheduledAudio.has(cue.id), false);
  assert.ok(cancelCount >= 2);
  assert.ok(rampCount >= beforeCancelRamps + 2);
  controller.dispose();
});

test('rebuilding future transfer automation preserves a dip transition', () => {
  const controller = runningController();
  const transfer = controller.queueAction(time(4), { type: 'transfer-deck', destination: 'B', style: 'dip', durationTicks: EIGHTH_NOTE_TICKS * 4 });
  const instrument = controller.queueAction(time(2), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(transfer.ok, true);
  assert.equal(instrument.ok, true);
  const privateController = controller as unknown as {
    pendingCues: Array<{ id: string; action: { type: string } }>;
    scheduleCueAudio: (cue: { id: string; action: unknown }, at: number) => void;
  };
  const transferCue = privateController.pendingCues.find((cue) => cue.action.type === 'transfer-deck')!;
  const instrumentCue = privateController.pendingCues.find((cue) => cue.action.type === 'set-instrument-enabled')!;
  const ramps: Array<{ lane: string; value: number; at: number; duration: number }> = [];
  const engine = controller.engine as unknown as { setLaneGainRamp: (lane: string, value: number, at: number, duration: number) => void };
  engine.setLaneGainRamp = (lane, value, at, duration) => { ramps.push({ lane, value, at, duration }); };
  privateController.scheduleCueAudio(transferCue, 4);
  privateController.scheduleCueAudio(instrumentCue, 2);
  ramps.length = 0;
  assert.equal(controller.cancelCue(instrumentCue.id).ok, true);
  assert.deepEqual(ramps, [
    { lane: 'deckA', value: 0, at: 4, duration: .5 },
    { lane: 'deckB', value: 0, at: 4, duration: .018 },
    { lane: 'deckB', value: 1, at: 4.5, duration: .5 },
  ]);
  controller.dispose();
});

test('recording conflicts reject destructive agent changes but allow separate additions', () => {
  const controller = runningController();
  controller.setHumanRecording(true, 'A', 'bass');
  const remove = controller.queueAction(time(1), { type: 'remove-deck-events', deck: 'A', instrument: 'bass', eventIds: ['bass-1'] });
  assert.equal(remove.ok, false);
  assert.equal(remove.code, 'HUMAN_RECORDING_CONFLICT');
  const add = controller.queueAction(time(1), { type: 'add-deck-events', deck: 'A', instrument: 'bass', events: [{ type: 'note', instrument: 'bass', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 36, velocity: 1 }] });
  assert.equal(add.ok, true);
  controller.dispose();
});

test('human recording commit applies events and profile as one atomic target revision', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('lead', 'human-take');
  const take: RecordedTake = {
    instrument: 'lead',
    mode: 'overdub',
    count: 1,
    events: [{ id: 'human-take-event', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 64, velocity: .5, articulation: .4 }],
  };
  const committed = controller.commitHumanRecording('A', take, profile);
  assert.equal(committed.ok, true);
  assert.equal(controller.decks.A.events('lead').length, 1);
  assert.equal(controller.decks.A.profile('lead')?.presetId, 'human-take');
  const undone = controller.undoLastHumanRecording();
  assert.equal(undone.ok, true);
  assert.equal(controller.decks.A.events('lead').length, 0);
  assert.equal(controller.decks.A.profile('lead'), undefined);
  controller.dispose();
});

test('human replace recording restores the exact prior lane and profile on undo', () => {
  const controller = runningController();
  const previous = controller.engine.getSoundProfile('lead', 'before-take');
  controller.decks.A.addNote('lead', 55, 0, EIGHTH_NOTE_TICKS, 1, 1, 'old-event');
  controller.decks.A.setSoundProfile('lead', previous);
  controller.humanDeckMutation('A', 'lead');
  const take: RecordedTake = { instrument: 'lead', mode: 'replace', count: 1, events: [{ id: 'new-event', startTick: EIGHTH_NOTE_TICKS, durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: 1, articulation: 1 }] };
  assert.equal(controller.commitHumanRecording('A', take, { ...previous, presetId: 'during-take' }).ok, true);
  assert.deepEqual(controller.decks.A.events('lead').map((event) => event.id), ['new-event']);
  assert.equal(controller.undoLastHumanRecording().ok, true);
  assert.deepEqual(controller.decks.A.events('lead').map((event) => event.id), ['old-event']);
  assert.equal(controller.decks.A.profile('lead')?.presetId, 'before-take');
  controller.dispose();
});

test('human recording undo conflicts with a later same-lane mutation but preserves another deck', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('bass', 'take');
  const take: RecordedTake = { instrument: 'bass', mode: 'overdub', count: 1, events: [{ id: 'take-bass', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 36, velocity: 1, articulation: 1 }] };
  assert.equal(controller.commitHumanRecording('A', take, profile).ok, true);
  controller.decks.A.addNote('bass', 40, EIGHTH_NOTE_TICKS, EIGHTH_NOTE_TICKS, 1, 1, 'later-human');
  controller.humanDeckMutation('A', 'bass');
  controller.decks.B.addNote('bass', 48, 0, EIGHTH_NOTE_TICKS, 1, 1, 'deck-b');
  const undo = controller.undoLastHumanRecording();
  assert.equal(undo.ok, false);
  assert.equal(undo.code, 'UNDO_CONFLICT');
  assert.equal(controller.decks.A.hasEventId('bass', 'later-human'), true);
  assert.equal(controller.decks.B.hasEventId('bass', 'deck-b'), true);
  controller.dispose();
});

test('recording build is immutable and zero-event take does not alter the deck', () => {
  const context = { currentTime: 0 } as unknown as AudioContext;
  const deck = new SingleDeck();
  deck.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'kept');
  const recorder = new DeckRecorder(() => context, () => 120, deck);
  assert.equal(recorder.begin('lead'), true);
  const take = recorder.buildTake();
  assert.equal(take?.count, 0);
  assert.equal(deck.hasEventId('lead', 'kept'), true);
});

test('an empty replace take changes neither events nor profile and creates no undo record', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('lead', 'stored');
  controller.decks.A.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'stored-event');
  controller.decks.A.setSoundProfile('lead', profile);
  const before = controller.decks.A.snapshot();
  const take: RecordedTake = { instrument: 'lead', mode: 'replace', events: [], count: 0 };
  const result = controller.commitHumanRecording('A', take, { ...profile, presetId: 'must-not-apply' });
  assert.equal(result.ok, true);
  assert.deepEqual(controller.decks.A.snapshot(), before);
  assert.equal(controller.undoLastHumanRecording().code, 'NOTHING_TO_UNDO');
  controller.dispose();
});

test('profile transitions interpolate at musical ticks and are exposed in state', () => {
  const controller = runningController();
  const source = controller.engine.getSoundProfile('lead', 'source');
  const controlName = Object.keys(source.controls)[0];
  const target = { ...source, controls: { ...source.controls, [controlName]: Math.min(1, source.controls[controlName] + .4) }, volume: Math.min(1, source.volume + .2), presetId: 'target' };
  const queued = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: target, transitionTicks: EIGHTH_NOTE_TICKS * 8 });
  assert.equal(queued.ok, true);
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  const state = controller.getState();
  assert.equal(state.profileTransitions.length, 1);
  assert.equal(state.profileTransitions[0].progress, 0);
  const privateController = controller as unknown as { profileForDeckTick: (deck: 'A' | 'B', instrument: 'lead', tick: number) => DeckSoundProfile | undefined };
  const middle = privateController.profileForDeckTick('A', 'lead', 1920 + EIGHTH_NOTE_TICKS * 2)!;
  assert.ok(middle.volume > source.volume && middle.volume < target.volume);
  assert.equal(middle.presetId, 'deck-A-lead-current');
  const end = privateController.profileForDeckTick('A', 'lead', 1920 + EIGHTH_NOTE_TICKS * 8)!;
  assert.equal(end.presetId, 'target');
  controller.engine.tempo = 60;
  assert.equal(privateController.profileForDeckTick('A', 'lead', 1920 + EIGHTH_NOTE_TICKS * 2)!.presetId, 'deck-A-lead-current');
  controller.dispose();
});

test('projected profile transitions use the profile at each interruption boundary', () => {
  const controller = runningController();
  const base = controller.engine.getSoundProfile('lead', 'base');
  const firstProfile = profileVariant(base, 'first', .2);
  const secondProfile = profileVariant(base, 'second', .9);
  const first = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: firstProfile, transitionTicks: BAR_TICKS * 2 });
  const second = controller.queueAction(time(2), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: secondProfile, transitionTicks: BAR_TICKS * 2 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const privateController = controller as unknown as { profileForDeckTick: (deck: 'A' | 'B', instrument: 'lead', tick: number) => DeckSoundProfile };
  const before = privateController.profileForDeckTick('A', 'lead', BAR_TICKS + BAR_TICKS / 2);
  const atInterruption = privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 2);
  const midpointAfter = privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 3);
  const end = privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 4);
  assert.ok(before.volume > Math.min(base.volume, firstProfile.volume) && before.volume < Math.max(base.volume, firstProfile.volume));
  const expectedAtInterruption = base.volume + (firstProfile.volume - base.volume) * .5;
  assert.ok(Math.abs(atInterruption.volume - expectedAtInterruption) < 1e-9);
  const expectedMidpointAfter = expectedAtInterruption + (secondProfile.volume - expectedAtInterruption) * .5;
  assert.ok(Math.abs(midpointAfter.volume - expectedMidpointAfter) < 1e-9);
  assert.equal(end.presetId, secondProfile.presetId);
  const reverseEnd = privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 4);
  const reverseMidpoint = privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 3);
  assert.deepEqual(reverseEnd, end);
  assert.deepEqual(reverseMidpoint, midpointAfter);
  assert.equal(controller.executeCueNow(first.data!.cueId).ok, true);
  assert.equal(controller.executeCueNow(second.data!.cueId).ok, true);
  assert.deepEqual(privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 3), midpointAfter);
  controller.engine.tempo = 60;
  assert.deepEqual(privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 3), midpointAfter);
  controller.dispose();
});

test('an active profile transition is interrupted from its exact effective profile', () => {
  const controller = runningController();
  const base = controller.engine.getSoundProfile('lead', 'base');
  const firstProfile = profileVariant(base, 'first-active', .1);
  const secondProfile = profileVariant(base, 'second-pending', .8);
  const first = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: firstProfile, transitionTicks: BAR_TICKS * 4 });
  assert.equal(first.ok, true);
  assert.equal(controller.executeCueNow(first.data!.cueId).ok, true);
  const second = controller.queueAction(time(2), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: secondProfile, transitionTicks: BAR_TICKS * 2 });
  assert.equal(second.ok, true);
  const privateController = controller as unknown as { profileForDeckTick: (deck: 'A' | 'B', instrument: 'lead', tick: number) => DeckSoundProfile };
  const expectedSource = base.volume + (firstProfile.volume - base.volume) * .25;
  assert.ok(Math.abs(privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 2).volume - expectedSource) < 1e-9);
  const expectedMidpoint = expectedSource + (secondProfile.volume - expectedSource) * .5;
  assert.ok(Math.abs(privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 3).volume - expectedMidpoint) < 1e-9);
  assert.equal(controller.executeCueNow(second.data!.cueId).ok, true);
  assert.ok(Math.abs(privateController.profileForDeckTick('A', 'lead', BAR_TICKS * 2).volume - expectedSource) < 1e-9);
  controller.dispose();
});

test('same-time profile cues use deterministic cue ID order and cancellation removes projection', () => {
  const controller = runningController();
  const base = controller.engine.getSoundProfile('lead', 'base');
  const firstProfile = profileVariant(base, 'same-first', .25);
  const secondProfile = profileVariant(base, 'same-second', .75);
  const first = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: firstProfile });
  const second = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile: secondProfile });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  const privateController = controller as unknown as { profileForDeckTick: (deck: 'A' | 'B', instrument: 'lead', tick: number) => DeckSoundProfile };
  const expected = first.data!.cueId.localeCompare(second.data!.cueId) < 0 ? secondProfile : firstProfile;
  assert.equal(privateController.profileForDeckTick('A', 'lead', BAR_TICKS).presetId, expected.presetId);
  assert.equal(controller.cancelCue(first.data!.cueId).ok, true);
  const afterCancel = privateController.profileForDeckTick('A', 'lead', BAR_TICKS);
  assert.equal(afterCancel.presetId, secondProfile.presetId);
  controller.dispose();
});

test('shared deck transport uses the projected profile at each note onset', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { setInterval: () => 1, clearInterval: () => {} };
  const controller = runningController();
  const context = controller.engine.context as unknown as { currentTime: number };
  const profile = profileVariant(controller.engine.getSoundProfile('lead', 'transport-source'), 'transport-target', .9);
  controller.decks.A.addNote('lead', 64, BAR_TICKS, EIGHTH_NOTE_TICKS, 1, 1, 'transport-note');
  const cue = controller.queueAction(time(1), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'lead', profile });
  assert.equal(cue.ok, true);
  const playedProfiles: DeckSoundProfile[] = [];
  const privateController = controller as unknown as { scheduledDeckView: (deck: 'A' | 'B', tick: number) => { profiles: Record<string, DeckSoundProfile> } };
  const transport = new SharedDeckTransport(
    () => controller.engine.context,
    () => controller.engine.tempo,
    controller.decks,
    {
      drum: () => {},
      note: (_instrument, _pitch, _velocity, _duration, _at, onsetProfile) => { if (onsetProfile) playedProfiles.push(onsetProfile); },
      chord: () => {},
    },
    { scheduleView: (deck, absoluteTick) => ({ events: controller.decks[deck].eventsAt(absoluteTick), profiles: privateController.scheduledDeckView(deck, absoluteTick).profiles }) },
  );
  assert.equal(transport.start(0), true);
  context.currentTime = 1.9;
  (transport as unknown as { schedule: () => void }).schedule();
  assert.equal(playedProfiles.at(-1)?.presetId, profile.presetId);
  transport.stop();
  controller.dispose();
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
});

test('human live performance feed is bounded, cursor-filtered, and excludes deck state', () => {
  const controller = runningController();
  controller.humanNoteOn('live-lead', 'lead', 60, .8, 0);
  controller.humanChordOn('live-chord', 'Dm', [50, 53, 57], 'root', .7, 0);
  const beforeRelease = controller.getState({ maxLiveEvents: 64 });
  assert.equal(beforeRelease.livePerformance.held.length, 2);
  assert.equal(beforeRelease.livePerformance.recentEvents.length, 2);
  (controller.engine.context as unknown as { currentTime: number }).currentTime = .125;
  controller.humanNoteOff('live-lead', .125);
  controller.humanChordOff('live-chord', .125);
  for (let index = 0; index < 300; index += 1) controller.humanDrumHit(index % 12, .5);
  const state = controller.getState({ maxLiveEvents: 5 });
  assert.equal(state.livePerformance.recentEvents.length, 5);
  assert.equal(state.livePerformance.held.length, 0);
  assert.equal(state.livePerformance.recentEvents.some((event) => event.symbol === 'Dm'), false);
  assert.equal(beforeRelease.livePerformance.summary.recentChordLabels.includes('Dm'), true);
  const cursor = controller.getState({ liveSinceSequence: state.livePerformance.latestSequence - 2, maxLiveEvents: 256 });
  assert.equal(cursor.livePerformance.recentEvents.length, 2);
  controller.decks.A.addNote('lead', 70, 0, EIGHTH_NOTE_TICKS);
  assert.equal(controller.getState({ includeLiveEvents: false }).livePerformance.recentEvents.length, 0);
  controller.dispose();
});

test('human cleanup records matching offs once and keeps the four-bar attack summary', () => {
  const controller = runningController();
  controller.humanNoteOn('bass-held', 'bass', 36, 1, 0);
  controller.humanNoteOn('lead-held', 'lead', 72, 1, 0);
  controller.humanChordOn('chord-held', 'Dm', [50, 53, 57], 'open', .6, 0);
  controller.clearHumanHeld('bass', .125);
  controller.humanNoteOff('bass-held', .25);
  const afterBass = controller.getState({ maxLiveEvents: 256 }).livePerformance;
  assert.equal(afterBass.held.some((entry) => entry.id === 'bass-held'), false);
  assert.equal(afterBass.held.some((entry) => entry.id === 'lead-held'), true);
  assert.equal(afterBass.held.some((entry) => entry.id === 'chord-held'), true);
  assert.equal(afterBass.recentEvents.filter((event) => event.id === 'bass-held' && event.type === 'note-off').length, 1);
  assert.equal(afterBass.recentEvents.find((event) => event.id === 'bass-held' && event.type === 'note-off')?.durationTicks, 120);
  assert.equal(afterBass.summary.summaryWindowBars, 4);
  assert.equal(afterBass.summary.recentEventDensity, 3 / 4);
  assert.deepEqual(afterBass.summary.leadRange, { min: 72, max: 72 });
  assert.deepEqual(afterBass.summary.recentChordLabels, ['Dm']);

  controller.humanSetInstrumentEnabled('lead', false);
  const afterDisable = controller.getState({ maxLiveEvents: 256 }).livePerformance;
  assert.equal(afterDisable.held.some((entry) => entry.id === 'lead-held'), false);
  assert.equal(afterDisable.held.some((entry) => entry.id === 'chord-held'), true);
  assert.equal(afterDisable.recentEvents.filter((event) => event.id === 'lead-held' && event.type === 'note-off').length, 1);
  controller.clearHumanHeld();
  const afterAll = controller.getState({ maxLiveEvents: 256 }).livePerformance;
  assert.equal(afterAll.held.length, 0);
  assert.equal(afterAll.recentEvents.filter((event) => event.type === 'chord-off' && event.id === 'chord-held').length, 1);
  controller.clearHumanHeldSilently();
  controller.dispose();
});

test('live feed max limits and cursors report omitted matching events', () => {
  const controller = runningController();
  for (let index = 0; index < 10; index += 1) controller.humanDrumHit(index % 12, .5, 0);
  const defaultState = controller.getState();
  assert.equal(defaultState.livePerformance.recentEvents.length, 10);
  assert.equal(defaultState.livePerformance.truncated, false);
  const none = controller.getState({ maxLiveEvents: 0 });
  assert.equal(none.livePerformance.recentEvents.length, 0);
  assert.equal(none.livePerformance.truncated, true);
  const all = controller.getState({ maxLiveEvents: 256 });
  assert.equal(all.livePerformance.recentEvents.length, 10);
  assert.equal(all.livePerformance.truncated, false);
  const cursor = controller.getState({ liveSinceSequence: 0, maxLiveEvents: 3 });
  assert.equal(cursor.livePerformance.recentEvents.length, 3);
  assert.equal(cursor.livePerformance.truncated, true);
  const stale = controller.getState({ liveSinceSequence: -1, maxLiveEvents: 256 });
  assert.equal(stale.livePerformance.truncated, true);
  const hidden = controller.getState({ includeLiveEvents: false, maxLiveEvents: 0 });
  assert.equal(hidden.livePerformance.recentEvents.length, 0);
  controller.dispose();
});

test('instrument controls expose the next pending enable cue', () => {
  const controller = runningController();
  const queued = controller.queueAction(time(2), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(queued.ok, true);
  const state = controller.getState();
  assert.equal(state.instrumentControls.bass.enabled, true);
  assert.equal(state.instrumentControls.bass.nextCue?.cueId, queued.data!.cueId);
  assert.equal(state.instrumentControls.bass.nextCue?.enabled, false);
  assert.equal(state.instrumentControls.bass.nextCue?.ticksUntil, 3840);
  (controller.engine.context as unknown as { currentTime: number }).currentTime = 2;
  assert.equal(controller.getState().instrumentControls.bass.nextCue?.ticksUntil, 1920);
  (controller.engine.context as unknown as { currentTime: number }).currentTime = 0;
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  assert.equal(controller.getState().instrumentControls.bass.enabled, false);
  assert.equal(controller.getState().instrumentControls.bass.nextCue, null);
  controller.dispose();
});

test('human instrument override cancels only enable cues and conflicts with agent undo', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('bass', 'pending-profile');
  const enableCue = controller.queueAction(time(2), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  const eventCue = controller.queueAction(time(2), { type: 'add-deck-events', deck: 'A', instrument: 'bass', events: [{ type: 'note', id: 'pending-bass', instrument: 'bass', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 36, velocity: 1 }] });
  const profileCue = controller.queueAction(time(2), { type: 'set-deck-sound-profile', deck: 'A', instrument: 'bass', profile });
  assert.equal(enableCue.ok, true);
  assert.equal(eventCue.ok, true);
  assert.equal(profileCue.ok, true);
  const override = controller.humanSetInstrumentEnabled('bass', true);
  assert.equal(override.ok, true);
  assert.equal(controller.getState().instrumentControls.bass.enabled, true);
  assert.equal(controller.getState().instrumentControls.bass.nextCue, null);
  const pendingActions = controller.getState().pendingCues.map((cue) => cue.action.type);
  assert.ok(pendingActions.includes('add-deck-events'));
  assert.ok(pendingActions.includes('set-deck-sound-profile'));
  assert.ok(!pendingActions.includes('set-instrument-enabled'));

  const executed = controller.queueAction(time(3), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(executed.ok, true);
  assert.equal(controller.executeCueNow(executed.data!.cueId).ok, true);
  assert.equal(controller.humanSetInstrumentEnabled('bass', true).ok, true);
  assert.equal(controller.undoLastAgentAction().code, 'UNDO_CONFLICT');
  controller.dispose();
});

test('agent event IDs are rejected before projected playback can reserve them twice', () => {
  const controller = runningController();
  controller.decks.A.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'existing');
  const existing = controller.queueAction(time(1), { type: 'add-deck-events', deck: 'A', instrument: 'lead', events: [{ type: 'note', id: 'existing', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 62, velocity: 1 }] });
  assert.equal(existing.ok, false);
  assert.equal(existing.code, 'DUPLICATE_EVENT_ID');
  const first = controller.queueAction(time(2), { type: 'add-deck-events', deck: 'B', instrument: 'lead', events: [{ type: 'note', id: 'reserved', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 62, velocity: 1 }] });
  assert.equal(first.ok, true);
  const second = controller.queueAction(time(3), { type: 'add-deck-events', deck: 'B', instrument: 'lead', events: [{ type: 'note', id: 'reserved', instrument: 'lead', startTick: EIGHTH_NOTE_TICKS, durationTicks: EIGHTH_NOTE_TICKS, pitch: 64, velocity: 1 }] });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'DUPLICATE_EVENT_ID');
  controller.dispose();
});

test('cancelling a lookahead cue removes its pre-scheduled instrument automation', () => {
  const controller = runningController();
  const queued = controller.queueAction(time(1), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(queued.ok, true);
  const privateController = controller as unknown as { pendingCues: Array<{ id: string }>; scheduleCueAudio: (cue: { id: string; action: unknown }, at: number) => void; preScheduledAudio: Map<string, unknown> };
  const cue = privateController.pendingCues[0] as { id: string; action: unknown };
  let cancelled = 0;
  let restored = 0;
  const engine = controller.engine as unknown as { cancelInstrumentAutomation: () => void; setInstrumentEnabled: () => void };
  engine.cancelInstrumentAutomation = () => { cancelled += 1; };
  engine.setInstrumentEnabled = () => { restored += 1; };
  privateController.scheduleCueAudio(cue, 1);
  const scheduledCalls = restored;
  assert.equal(privateController.preScheduledAudio.has(cue.id), true);
  const result = controller.cancelCue(cue.id);
  assert.equal(result.ok, true);
  assert.equal(privateController.preScheduledAudio.has(cue.id), false);
  assert.equal(cancelled, 1);
  assert.equal(restored, scheduledCalls + 1);
  controller.dispose();
});

test('solo note instruments must match the active solo instrument', () => {
  const controller = runningController();
  const profile: DeckSoundProfile = controller.engine.getSoundProfile('lead', 'test');
  const start = controller.queueAction(time(2), { type: 'start-solo', soloId: 'bass-solo', instrument: 'bass', description: 'bass', lengthBars: 2, soundProfile: { ...profile, presetId: 'bass-test', controls: { ...controller.engine.controls.bass }, parameters: Object.fromEntries(Object.entries(controller.engine.parameters.bass).map(([key, value]) => [key, value.value])) }, initialEvents: soloOpening('bass', 'bass-opening') });
  assert.equal(start.ok, true);
  assert.equal(controller.executeCueNow(start.data!.cueId).ok, true);
  const cue = controller.queueAction(time(2, EIGHTH_NOTE_TICKS), { type: 'add-solo-events', soloId: 'bass-solo', events: [{ type: 'note', instrument: 'lead', start: time(2, EIGHTH_NOTE_TICKS * 3), durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: 1 }] });
  assert.equal(cue.ok, false);
  assert.equal(cue.code, 'SOLO_INSTRUMENT_MISMATCH');
  controller.dispose();
});

test('state includes musical context, orchestration hints, and both deck chord contexts', () => {
  const controller = new MusicController(new SynthEngine());
  controller.decks.A.addChord('C', [48, 52, 55], 0, EIGHTH_NOTE_TICKS);
  controller.decks.B.addChord('G', [55, 59, 62], 0, EIGHTH_NOTE_TICKS);
  const state = controller.getState();
  assert.equal(state.musicalKey, 'Dm');
  assert.deepEqual(state.projectSettings, { tempo: 120, keyRoot: 2, keyMode: 'minor', quantize: '1/8', metronomeEnabled: false, switchEffect: 'blend' });
  controller.setMusicalContext({ label: 'Dm', root: 2, mode: 'minor', scalePitchClasses: [2, 4, 5, 7, 9, 10, 1] });
  const keyed = controller.getState();
  assert.equal(keyed.musicalKey, 'Dm');
  assert.equal(keyed.musicalContext?.mode, 'minor');
  assert.equal(keyed.orchestration.recommendedTargetDeck, 'B');
  assert.equal(state.chordContext.A.current?.event.symbol, 'C');
  assert.equal(state.chordContext.B.current?.event.symbol, 'G');
  controller.dispose();
});

test('explicit early solo boundaries are respected while next bar remains the normal latest start', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('lead', 'Bright Mono');
  const early = controller.queueAction({ when: 'next-eighth' }, { type: 'start-solo', soloId: 'early', instrument: 'lead', description: 'early phrase', lengthBars: 2, soundProfile: profile, initialEvents: soloOpening('lead', 'early-opening') });
  assert.equal(early.ok, true);
  assert.equal(absoluteTickOf(early.data!.normalisedAt), EIGHTH_NOTE_TICKS);
  controller.cancelCue(early.data!.cueId);
  const normal = controller.queueAction({ when: 'next-bar' }, { type: 'start-solo', soloId: 'normal', instrument: 'lead', description: 'downbeat phrase', lengthBars: 2, soundProfile: profile, initialEvents: soloOpening('lead', 'normal-opening') });
  assert.equal(normal.ok, true);
  assert.equal(absoluteTickOf(normal.data!.normalisedAt), BAR_TICKS);
  controller.dispose();
});

test('inactive decks prepare atomically and remain undoable', () => {
  const controller = runningController();
  const prepared = controller.prepareDeck('B', [
    { instrument: 'drums', mode: 'replace', events: [{ type: 'drum', id: 'prep-kick', startTick: 0, pad: 0, velocity: .9 }] },
    { instrument: 'lead', mode: 'replace', events: [{ type: 'note', id: 'prep-lead', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 74, velocity: .8 }] },
  ]);
  assert.equal(prepared.ok, true);
  assert.equal(controller.decks.B.eventCount(), 2);
  assert.equal(controller.prepareDeck('A', [{ instrument: 'drums', mode: 'replace', events: [] }]).code, 'ACTIVE_DECK_REQUIRES_CUE');
  assert.equal(controller.undoLastAgentAction().ok, true);
  assert.equal(controller.decks.B.eventCount(), 0);
  controller.dispose();
});

test('relative solo phrases extend the locked two-bar opening while pending and active', () => {
  const controller = runningController();
  const profile = controller.engine.getSoundProfile('lead', 'Bright Mono');
  const queued = controller.queueAction({ when: 'next-bar' }, { type: 'start-solo', soloId: 'stream', instrument: 'lead', description: 'streamed phrase', lengthBars: 4, soundProfile: profile, initialEvents: soloOpening('lead', 'stream-opening') });
  assert.equal(queued.ok, true);
  const locked = controller.stageSoloEvents('stream', [{ type: 'note', id: 'too-early', offsetTicks: BAR_TICKS, instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: .8 }]);
  assert.equal(locked.code, 'SOLO_OPENING_LOCKED');
  const staged = controller.stageSoloEvents('stream', [{ type: 'note', id: 'phrase-1', offsetTicks: SOLO_OPENING_TICKS, instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 76, velocity: .8 }]);
  assert.equal(staged.ok, true);
  const pending = controller.getState().pendingCues.find((cue) => cue.id === queued.data!.cueId)!;
  assert.equal(pending.action.type, 'create-solo');
  assert.equal(controller.executeCueNow(queued.data!.cueId).ok, true);
  assert.equal(controller.getState().solo?.events[0].start.bar, 1);
  assert.equal(controller.getState().solo?.events.length, 3);
  const later = controller.stageSoloEvents('stream', [{ type: 'note', id: 'phrase-2', offsetTicks: SOLO_OPENING_TICKS + BAR_TICKS, instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 79, velocity: .8 }]);
  assert.equal(later.ok, true);
  assert.equal(controller.getState().solo?.events.length, 4);
  controller.dispose();
});

test('unknown debug releases return NOTE_NOT_FOUND', () => {
  const engine = new SynthEngine();
  engine.context = { currentTime: 0, sampleRate: 48000, state: 'running', close: async () => {} } as unknown as AudioContext;
  const controller = new MusicController(engine);
  const result = controller.debugReleaseHeldNote('missing');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOTE_NOT_FOUND');
  controller.dispose();
});

test('solo starts with two atomic bars, locks them, and accepts later events inside its window', () => {
  const controller = runningController();
  const profile: DeckSoundProfile = controller.engine.getSoundProfile('lead', 'test');
  const started = controller.queueAction(time(2), { type: 'start-solo', soloId: 's1', instrument: 'lead', description: 'test', lengthBars: 4, soundProfile: profile, initialEvents: soloOpening('lead', 's1-opening') });
  assert.equal(started.ok, true);
  assert.equal(controller.executeCueNow(started.data!.cueId).ok, true);
  assert.equal(controller.getState().solo?.events.length, 2);
  const locked = controller.queueAction(time(2, 480), { type: 'add-solo-events', soloId: 's1', events: [{ type: 'note', id: 'locked', start: time(3), instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: 1 }] });
  assert.equal(locked.code, 'SOLO_OPENING_LOCKED');
  const inside = controller.queueAction(time(2, 480), { type: 'add-solo-events', soloId: 's1', events: [{ type: 'note', id: 'solo-note', start: time(4), instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: 1 }] });
  assert.equal(inside.ok, true);
  assert.equal(controller.executeCueNow(inside.data!.cueId).ok, true);
  assert.equal(controller.getState().solo?.events.length, 3);
  const outside = controller.queueAction(time(5, 1440), { type: 'add-solo-events', soloId: 's1', events: [{ type: 'note', id: 'late', start: time(6), instrument: 'lead', durationTicks: EIGHTH_NOTE_TICKS, pitch: 72, velocity: 1 }] });
  assert.equal(outside.ok, true);
  assert.equal(controller.executeCueNow(outside.data!.cueId).ok, false);
  controller.dispose();
});

test('musical cues reject before audio and clock start', () => {
  const controller = new MusicController(new SynthEngine());
  const queued = controller.queueAction(time(1), { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(queued.ok, false);
  assert.equal(queued.code, 'AUDIO_NOT_STARTED');
  controller.dispose();
});

test('shared controller owns project, crossfader, deck clear, live sound, and output settings', () => {
  const controller = new MusicController(new SynthEngine());
  const project = controller.setProjectSettings({ tempo: 137, keyRoot: 0, keyMode: 'minor', quantize: '1/16', metronomeEnabled: true, switchEffect: 'dip' });
  assert.equal(project.ok, true);
  assert.equal(controller.getState().musicalKey, 'Cm');
  assert.equal(controller.getState().clock.tempo, 137);
  assert.equal(controller.getState().projectSettings.quantize, '1/16');
  const invalidProject = controller.setProjectSettings({ tempo: 0 });
  assert.equal(invalidProject.ok, false);
  assert.equal(controller.getState().clock.tempo, 137);

  const sound = controller.setLiveSound({ instrument: 'bass', presetId: 'Acid', controls: { tone: .2 }, volume: .7 });
  assert.equal(sound.ok, true);
  assert.equal(controller.getState().liveSound.presetIndexes.bass, 2);
  assert.equal(controller.engine.controls.bass.tone, .2);
  assert.equal(controller.engine.volumes.bass, .7);
  const invalidSound = controller.setLiveSound({ instrument: 'bass', controls: { missing: .5 } });
  assert.equal(invalidSound.ok, false);
  assert.equal(controller.engine.controls.bass.tone, .2);

  assert.equal(controller.setOutput({ masterVolume: .65, eqLowDb: -3, echoMix: .25 }).ok, true);
  assert.equal(controller.getState().liveSound.output.masterVolume, .65);
  assert.equal(controller.setCrossfader(.65, 'overlap').ok, true);
  assert.equal(controller.getState().crossfadePosition, .65);

  controller.decks.B.addNote('lead', 72, 0, EIGHTH_NOTE_TICKS);
  const cleared = controller.clearDeck('B', ['lead']);
  assert.equal(cleared.ok, true);
  assert.equal(controller.decks.B.events('lead').length, 0);
  assert.equal(controller.undoLastAgentAction().ok, true);
  assert.equal(controller.decks.B.events('lead').length, 1);
  controller.dispose();
});

test('agent brief is compact, tempo-aware, and includes human playing', () => {
  const controller = runningController();
  controller.humanNoteOn('human-lead', 'lead', 72, .8);
  const brief = controller.getAgentBrief();
  assert.equal(brief.protocolVersion, 3);
  assert.equal(brief.timing.estimatedTokensPerBarAt30Tps, 60);
  assert.equal(brief.transport.inactiveDeck, 'B');
  assert.equal(brief.humanPlaying.held[0].id, 'human-lead');
  assert.equal(brief.humanPlaying.recentEvents[0].type, 'note-on');
  assert.equal(brief.recommendedActions.some((action) => action.tool === 'music_fill_inactive_deck'), true);
  controller.dispose();
});

test('progression recipe resolves C minor degrees, ticks, patterns, and presets', () => {
  const controller = new MusicController(new SynthEngine());
  controller.setProjectSettings({ keyRoot: 0, keyMode: 'minor' });
  const built = controller.fillInactiveDeck({ progression: [1, 4, 1, 5], drums: 'backbeat', drumHits: [{ bar: 1, beat: 1, eighth: 1, drum: 'open-hat', velocity: .6 }], bass: 'roots', chords: 'sustained', sounds: { bass: { presetId: 'Sub' }, chords: { presetId: 'Warm Pad' } } });
  assert.equal(built.ok, true);
  assert.equal(built.code, 'PROGRESSION_BUILT');
  assert.deepEqual(controller.decks.B.events('chords').map((event) => event.symbol), ['Cm', 'Fm', 'Cm', 'Gm']);
  assert.deepEqual(controller.decks.B.events('bass').map((event) => event.pitch), [36, 41, 36, 43]);
  assert.equal(controller.decks.B.profile('bass')?.presetId, 'Sub');
  assert.equal(controller.decks.B.events('drums').length > 30, true);
  assert.equal(controller.decks.B.events('drums').some((event) => event.pad === 3 && event.startTick === EIGHTH_NOTE_TICKS), true);
  const invalid = controller.buildProgression('B', { progression: ['ix'] });
  assert.equal(invalid.ok, false);
  assert.equal((invalid.data as { retryWith: { tool: string } }).retryWith.tool, 'music_build_progression');
  controller.dispose();
});

test('guided solo resolves shorthand and section scheduling adds a later transfer', () => {
  const controller = runningController();
  controller.setProjectSettings({ keyRoot: 0, keyMode: 'minor' });
  const guided = controller.startGuidedSolo({ soloId: 'guided', instrument: 'lead', lengthBars: 4, sound: { presetId: 'Bright Mono' }, openingNotes: [{ bar: 1, degree: 1, duration: '1/4' }, { bar: 2, degree: 3, duration: '1/4' }] });
  assert.equal(guided.ok, true);
  const guidedCue = controller.getState().pendingCues.find((cue) => cue.id === guided.data!.cueId)!;
  assert.equal(guidedCue.action.type, 'create-solo');
  if (guidedCue.action.type === 'create-solo') {
    assert.deepEqual(guidedCue.action.events.map((event) => event.type === 'note' ? event.pitch : null), [60, 63]);
    assert.equal(guidedCue.action.soundProfile.presetId, 'Bright Mono');
  }
  controller.cancelCue(guided.data!.cueId);
  const section = controller.scheduleSection({ soloId: 'section', instrument: 'lead', lengthBars: 16, notes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 9, degree: 5 }], transfer: { destination: 'B', afterBars: 8, style: 'blend', durationBeats: 1 } });
  assert.equal(section.ok, true);
  assert.equal(section.data!.eventCount, 3);
  assert.equal(section.data!.stagedEventCount, 1);
  const transfer = controller.getState().pendingCues.find((cue) => cue.id === section.data!.transferCueId)!;
  assert.equal(transfer.action.type, 'transfer-deck');
  assert.equal(transfer.normalisedAt.bar, 9);
  controller.dispose();
});

test('guided solo accepts later bars, reports the slower path, and rolls back invalid tails', () => {
  const controller = runningController();
  const extended = controller.startGuidedSolo({ soloId: 'extended-guided', instrument: 'lead', lengthBars: 6, openingNotes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 3, degree: 5 }, { bar: 6, degree: 1 }] });
  assert.equal(extended.ok, true);
  assert.equal(extended.data!.openingEventCount, 2);
  assert.equal(extended.data!.stagedEventCount, 2);
  assert.equal(extended.data!.usedExtendedInput, true);
  const pending = controller.getState().pendingCues.find((cue) => cue.id === extended.data!.cueId)!;
  assert.equal(pending.action.type, 'create-solo');
  if (pending.action.type === 'create-solo') assert.equal(pending.action.events.length, 4);
  controller.cancelCue(extended.data!.cueId);

  const missingOpeningBar = controller.startGuidedSolo({ soloId: 'missing-opening', instrument: 'lead', lengthBars: 4, openingNotes: [{ bar: 1, degree: 1 }, { bar: 3, degree: 5 }] });
  assert.equal(missingOpeningBar.ok, false);
  assert.equal(controller.getState().pendingCues.some((cue) => cue.action.type === 'create-solo' && cue.action.soloId === 'missing-opening'), false);

  const invalidTail = controller.startGuidedSolo({ soloId: 'invalid-tail', instrument: 'lead', lengthBars: 4, openingNotes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 5, degree: 5 }] });
  assert.equal(invalidTail.ok, false);
  assert.equal(controller.getState().pendingCues.some((cue) => cue.action.type === 'create-solo' && cue.action.soloId === 'invalid-tail'), false);
  controller.dispose();
});

test('stable WebMCP controls cover the full non-performance UI surface', async () => {
  const controller = new MusicController(new SynthEngine());
  const tools = buildWebMcpTools(controller);
  const names = tools.map((tool) => tool.name);
  for (const name of ['music_initialize_audio', 'music_get_catalog', 'music_set_project_settings', 'music_set_transport', 'music_set_crossfader', 'music_clear_deck', 'music_set_live_sound', 'music_set_output']) assert.ok(names.includes(name), name);
  for (const omitted of ['music_perform', 'music_control_recording', 'music_import_project', 'music_export_project']) assert.equal(names.includes(omitted), false);
  const projectTool = tools.find((tool) => tool.name === 'music_set_project_settings')!;
  const projectResult = await projectTool.execute({ tempo: 144, keyRoot: 5, keyMode: 'major', quantize: '1/4', metronomeEnabled: false, switchEffect: 'cut' });
  const projectPayload = JSON.parse((projectResult as { content: Array<{ text: string }> }).content[0].text) as { code: string };
  assert.equal(projectPayload.code, 'PROJECT_SETTINGS_UPDATED');
  assert.equal(controller.getState().musicalKey, 'F');
  const catalogTool = tools.find((tool) => tool.name === 'music_get_catalog')!;
  const catalogPayload = JSON.parse(((await catalogTool.execute({})) as { content: Array<{ text: string }> }).content[0].text) as { data: { presets: { lead: string[] } } };
  assert.ok(catalogPayload.data.presets.lead.includes('Bright Mono'));
  const outputTool = tools.find((tool) => tool.name === 'music_set_output')!;
  const invalid = await outputTool.execute({ masterVolume: .5, unknown: 1 });
  assert.equal(JSON.parse((invalid as { content: Array<{ text: string }> }).content[0].text).code, 'INVALID_INPUT');
  controller.dispose();
});

test('high-level WebMCP recipes act through the controller and reject nested unknown fields', async () => {
  const controller = runningController();
  controller.setProjectSettings({ keyRoot: 0, keyMode: 'minor' });
  controller.humanNoteOn('web-human', 'lead', 67, .7);
  const tools = buildWebMcpTools(controller);
  const call = async (name: string, input: unknown) => JSON.parse(((await tools.find((tool) => tool.name === name)!.execute(input)) as { content: Array<{ text: string }> }).content[0].text);
  const brief = await call('music_get_agent_brief', {});
  assert.equal(brief.data.humanPlaying.held[0].id, 'web-human');
  const live = await call('music_get_live_feed', { sinceSequence: 0, maxEvents: 4 });
  assert.equal(live.data.recentEvents[0].type, 'note-on');
  const filled = await call('music_fill_inactive_deck', { progression: [1, 4, 1, 5], drums: 'backbeat', drumHits: [{ bar: 1, eighth: 1, drum: 'open-hat' }], bass: 'none', chords: 'sustained' });
  assert.equal(filled.code, 'PROGRESSION_BUILT');
  assert.equal(controller.decks.B.events('chords').length, 4);
  assert.equal(controller.decks.B.events('drums').some((event) => event.pad === 3), true);
  const badRecipe = await call('music_fill_inactive_deck', { progression: [1], sounds: { bass: { presetId: 'Sub', unknown: 1 } } });
  assert.equal(badRecipe.code, 'INVALID_INPUT');
  const guided = await call('music_start_guided_solo', { soloId: 'web-guided', instrument: 'lead', lengthBars: 4, openingNotes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 4, degree: 5 }] });
  assert.equal(guided.code, 'CUE_ACCEPTED');
  assert.equal(guided.data.stagedEventCount, 1);
  controller.cancelCue(guided.data.cueId);
  const section = await call('music_schedule_section', { soloId: 'web-section', instrument: 'lead', lengthBars: 12, notes: [{ bar: 1, degree: 1 }, { bar: 2, degree: 3 }, { bar: 7, degree: 5 }], transfer: { afterBars: 6, destination: 'B', style: 'blend', durationBeats: 1 } });
  assert.equal(section.code, 'SECTION_SCHEDULED');
  assert.equal(controller.getState().pendingCues.length, 2);
  controller.dispose();
});

test('default WebMCP stays within the page limit and exposes normal tools with strict schemas', async () => {
  const controller = new MusicController(new SynthEngine());
  const tools = buildWebMcpTools(controller);
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 31);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.some((name) => name.startsWith('debug_')), false);
  assert.equal(names.includes('music_start_transport'), false);
  assert.equal(names.includes('music_stop_transport'), false);
  for (const name of ['music_get_agent_brief', 'music_get_live_feed', 'music_build_progression', 'music_fill_inactive_deck', 'music_start_guided_solo', 'music_schedule_section']) assert.ok(names.includes(name), name);
  tools.forEach((tool) => assert.equal(tool.inputSchema.additionalProperties, false));
  const stateTool = tools.find((tool) => tool.name === 'music_get_state')!;
  const guideTool = tools.find((tool) => tool.name === 'music_get_usage_guide')!;
  const guide = JSON.parse((await guideTool.execute({ topic: 'soloStreaming' }) as { content: Array<{ text: string }> }).content[0].text);
  assert.equal(guide.data.protocolVersion, 3);
  assert.match(guide.data.soloStreaming.note, /Extra bars no longer cause failure/);
  assert.equal(guide.data.realtimeBudget.estimatedTokensPerBarAt30Tps, 60);
  const stateResult = await stateTool.execute({ includeParameters: true });
  assert.equal((stateResult as { content: Array<{ text: string }> }).content.length, 1);
  const limitedState = await stateTool.execute({ includeLiveEvents: false, maxLiveEvents: 0 });
  assert.equal((limitedState as { isError?: boolean }).isError, undefined);
  const invalidState = await stateTool.execute({ maxLiveEvents: 257 });
  const invalidStatePayload = JSON.parse((invalidState as { content: Array<{ text: string }> }).content[0].text) as { ok: boolean; code: string };
  assert.equal(invalidStatePayload.ok, false);
  assert.equal(invalidStatePayload.code, 'INVALID_INPUT');
  controller.dispose();
});

test('debug WebMCP mode isolates diagnostics with only the essential read tools', () => {
  const controller = new MusicController(new SynthEngine());
  const tools = buildWebMcpTools(controller, 'debug');
  const names = tools.map((tool) => tool.name);
  assert.equal(names.length, 17);
  assert.equal(names.filter((name) => !name.startsWith('debug_')).sort().join(','), 'music_get_agent_brief,music_get_catalog,music_get_state');
  assert.equal(names.filter((name) => name.startsWith('debug_')).length, 14);
  tools.forEach((tool) => assert.equal(tool.inputSchema.additionalProperties, false));
  controller.dispose();
});

test('WebMCP registration is optional and aborts all registrations on cleanup', async () => {
  const previousDocument = (globalThis as { document?: unknown }).document;
  const registered: string[] = [];
  let aborted = false;
  (globalThis as { document?: unknown }).document = {
    modelContext: {
      registerTool: (tool: { name: string }, options?: { signal?: AbortSignal }) => {
        registered.push(tool.name);
        options?.signal?.addEventListener('abort', () => { aborted = true; });
      },
    },
  };
  const controller = new MusicController(new SynthEngine());
  const cleanup = await registerWebMcp(controller);
  assert.equal(registered.length, 31);
  cleanup();
  assert.equal(aborted, true);
  controller.dispose();
  if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else (globalThis as { document?: unknown }).document = previousDocument;
});

test('debug frequency conversion stays fractional and runtime rejects invalid optional values', async () => {
  assert.ok(Math.abs(fractionalMidiOf(466.16) - 70) < .001);
  const controller = new MusicController(new SynthEngine());
  const tone = buildWebMcpTools(controller, 'debug').find((tool) => tool.name === 'debug_play_tone')!;
  const invalid = await tone.execute({ frequencyHz: 440, durationMs: 100, gain: 1 });
  const payload = JSON.parse((invalid as { content: Array<{ text: string }> }).content[0].text) as { ok: boolean; code: string };
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'INVALID_INPUT');
  controller.dispose();
});

test('live-path debug MCP tools reject use before audio and unknown fields', async () => {
  const controller = new MusicController(new SynthEngine());
  const tools = buildWebMcpTools(controller, 'debug');
  const hold = tools.find((tool) => tool.name === 'debug_hold_instrument_frequency')!;
  const release = tools.find((tool) => tool.name === 'debug_release_held_note')!;
  const beforeAudio = await hold.execute({ id: 'bass-a', instrument: 'bass', frequencyHz: 55 });
  assert.equal(JSON.parse((beforeAudio as { content: Array<{ text: string }> }).content[0].text).code, 'AUDIO_NOT_STARTED');
  const extra = await hold.execute({ id: 'bass-a', instrument: 'bass', frequencyHz: 55, extra: true });
  assert.equal(JSON.parse((extra as { content: Array<{ text: string }> }).content[0].text).code, 'INVALID_INPUT');
  const missing = await release.execute({ id: 'bass-a' });
  assert.equal(JSON.parse((missing as { content: Array<{ text: string }> }).content[0].text).code, 'AUDIO_NOT_STARTED');
  controller.dispose();
});

test('MCP event schemas and profile transitions fail closed at runtime', async () => {
  const controller = runningController();
  const tools = buildWebMcpTools(controller);
  const add = tools.find((tool) => tool.name === 'music_cue_add_deck_events')!;
  const invalid = await add.execute({ at: time(1), deck: 'A', instrument: 'lead', events: [{ type: 'note', instrument: 'lead', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 60, velocity: 1, pad: 2 }] });
  const invalidPayload = JSON.parse((invalid as { content: Array<{ text: string }> }).content[0].text) as { code: string };
  assert.equal(invalidPayload.code, 'INVALID_DECK_EVENTS');
  const profile = controller.engine.getSoundProfile('lead', 'transition');
  const profileTool = tools.find((tool) => tool.name === 'music_cue_set_deck_sound_profile')!;
  const accepted = await profileTool.execute({ at: time(1), deck: 'A', instrument: 'lead', profile, transitionTicks: EIGHTH_NOTE_TICKS });
  const acceptedPayload = JSON.parse((accepted as { content: Array<{ text: string }> }).content[0].text) as { code: string };
  assert.equal(acceptedPayload.code, 'CUE_ACCEPTED');
  controller.dispose();
});

test('held retrigger capture filters before decimating and keeps the 5-8 kHz peak', () => {
  const controller = runningController();
  const allBands = Array.from({ length: 128 }, (_, index) => [index * 100, index * 100 + 100]);
  const samples = [
    { ageSeconds: 10, timestampMs: 0, audioTimeSeconds: 9, levelsDb: [] as number[] },
    { ageSeconds: 9, timestampMs: 1000, audioTimeSeconds: 10.1, levelsDb: [] as number[] },
    { ageSeconds: 8, timestampMs: 1100, audioTimeSeconds: 10.2, levelsDb: [] as number[] },
    { ageSeconds: 7, timestampMs: 1200, audioTimeSeconds: 10.3, levelsDb: [] as number[] },
  ];
  const histogramSnapshot = (seconds = 10, includeIntensities = false, options: { bandIndices?: number[] } = {}) => {
    const selected = options.bandIndices ?? allBands.map((_, index) => index);
    return {
      description: 'test', captureState: 'scrolling', sampleRateHz: 48000, timeSpanSeconds: 10, requestedTimeSpanSeconds: seconds, returnedTimeSpanSeconds: 1, fftSize: 2048,
      valueRange: { intensity: [0, 1], decibels: [-100, -10] }, frequencyRangeHz: [20, 20000], bandsHz: selected.map((index) => allBands[index]),
      samples: samples.map((sample, sampleIndex) => ({ ...sample, ...(includeIntensities ? { intensities: selected.map(() => 0.5) } : {}), levelsDb: selected.map((index) => index >= 50 && index < 80 ? (sampleIndex === 2 ? -5 : -30) : -80) })),
      omitted: { samples: 0, bands: 128 - selected.length, decimated: false },
    };
  };
  Object.defineProperty(controller, 'histogram', { value: { snapshot: histogramSnapshot, stop: () => {} } });
  const privateController = controller as unknown as { heldRetriggerProbes: Map<string, unknown> };
  privateController.heldRetriggerProbes.set('capture-test', { probeId: 'capture-test', status: 'complete', requested: {}, audioAnchor: 10, operations: [], captureWindow: { start: 10, end: 10.4 }, capture: { leadMs: 0, tailMs: 0, maxSamples: 1, bandIndices: [0] } });

  const result = controller.debugGetHeldRetriggerProbe('capture-test');
  assert.equal(result.ok, true);
  const data = result.data as { histogram: { samples: Array<{ audioTimeSeconds: number | null }>; bandsHz: number[][] }; summary5to8kHz: { peakDb: number; peakAudioTime: number | null; selectedBands: number[][] } };
  assert.equal(data.histogram.samples.length, 1);
  assert.equal(data.histogram.samples[0].audioTimeSeconds, 10.1);
  assert.equal(data.summary5to8kHz.peakDb, -5);
  assert.equal(data.summary5to8kHz.peakAudioTime, 10.2);
  assert.ok(data.summary5to8kHz.selectedBands.length > 0);
  assert.ok(data.histogram.bandsHz.some((band) => band[0] <= 5000 && band[1] >= 5000));
  controller.dispose();
});

test('held retrigger probe failures release voices and do not remain scheduled', async () => {
  const controller = runningController();
  const engine = controller.engine as unknown as { holdNote: () => never };
  engine.holdNote = () => { throw new Error('test hold failure'); };
  const result = controller.debugRunHeldRetriggerProbe({ firstId: 'first', firstFrequencyHz: 55, secondId: 'second', secondFrequencyHz: 65, firstHoldMs: 10, retriggerGapMs: 0, secondHoldMs: 10 });
  assert.equal(result.ok, true);
  const probeId = result.data!.probeId;
  (controller.engine.context as unknown as { currentTime: number }).currentTime = 1;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const probe = controller.debugGetHeldRetriggerProbe(probeId);
  assert.equal(probe.ok, true);
  assert.equal((probe.data as { status: string }).status, 'failed');
  assert.equal(controller.engine.hasHeldNote('first'), false);
  assert.equal(controller.engine.hasHeldNote('second'), false);
  controller.dispose();
});

test('keyboard press tokens cancel a keydown that loses its keyup during async audio start', async () => {
  const registry = new KeyboardPressRegistry<{ id: string }>();
  let holdCalls = 0;
  let resolveStart!: (value: boolean) => void;
  const start = new Promise<boolean>((resolve) => { resolveStart = resolve; });
  const press = registry.reserve('a', { id: 'keyboard-a' });
  assert.ok(press);
  const keyup = registry.take('a');
  assert.equal(keyup?.status, 'pending');
  resolveStart(true);
  await start;
  if (press && registry.isCurrent(press)) {
    registry.markStarted(press);
    holdCalls += 1;
  }
  assert.equal(holdCalls, 0);
  assert.equal(registry.values().length, 0);
});

test('persistent bass lane contract uses one graph per independent lane', () => {
  assert.deepEqual(PERSISTENT_BASS_LANES, ['live', 'deckA', 'deckB', 'solo']);
  const retriggers = Array.from({ length: 64 }, () => PERSISTENT_BASS_LANES[0]);
  assert.equal(new Set(retriggers).size, 1);
  assert.equal(retriggers.length, 64);
});

test('bass retriggers reuse one persistent graph per lane and keep live note priority', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const context = engine.context as unknown as FakeAudioContext;
  const initialOscillatorCount = context.oscillators.length;
  for (let index = 0; index < 64; index++) engine.note('bass', 36 + (index % 4), .25, context.currentTime + .02 + index * .012, undefined, false, 'live');
  engine.note('bass', 48, .25, context.currentTime + .02, undefined, true, 'deckA');
  engine.note('bass', 52, .25, context.currentTime + .02, undefined, true, 'deckB');
  assert.equal(context.oscillators.length, initialOscillatorCount);
  assert.equal(engine.getVoiceStats().bass.groups, 4);

  engine.holdNote('older', 'bass', 36);
  engine.holdNote('newer', 'bass', 41);
  assert.equal(engine.hasHeldNote('older'), true);
  assert.equal(engine.hasHeldNote('newer'), true);
  engine.releaseNote('older');
  assert.equal(engine.hasHeldNote('newer'), true);
  engine.releaseNote('newer');
  assert.equal(engine.hasHeldNote('newer'), false);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext?: unknown }).AudioContext = previousAudioContext;
});

test('bass same-profile retriggers never rewrite persistent graph settings', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const lane = bassLanesOf(engine).get('live')!;
  const before = bassGraphWrites(lane);
  for (let index = 0; index < 100; index++) engine.note('bass', 36 + index % 5, .25, .02 + index * .01, undefined, false, 'live', (index % 3 + 1) / 3);
  assertBassGraphUnchanged(lane, before);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext?: unknown }).AudioContext = previousAudioContext;
});

test('identical explicit bass profile updates are no-ops and audible changes defer graph mutation', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const profile = engine.getSoundProfile('bass', 'deck-profile');
  const lanes = (engine as unknown as { bassLanes: Map<string, { shaper: FakeNode & { curve: Float32Array | null }; pendingProfile?: unknown; profileState: unknown }> }).bassLanes;
  const lane = lanes.get('deckA')!;
  let curveWrites = 0;
  let curve: Float32Array | null = lane.shaper.curve;
  Object.defineProperty(lane.shaper, 'curve', { configurable: true, get: () => curve, set: (value) => { curveWrites += 1; curve = value; } });
  engine.updateBassLaneProfile('deckA', profile);
  const afterFirst = curveWrites;
  engine.updateBassLaneProfile('deckA', { ...profile, controls: { ...profile.controls }, parameters: { ...profile.parameters } });
  assert.equal(curveWrites, afterFirst);
  engine.note('bass', 36, .25, .02, undefined, false, 'deckA');
  (engine.context as unknown as FakeAudioContext).currentTime = .03;
  const changed = { ...profile, controls: { ...profile.controls, drive: .7 } };
  const deferred = engine.updateBassLaneProfile('deckA', changed);
  assert.equal(deferred.deferred, true);
  assert.ok(lane.pendingProfile);
  (engine.context as unknown as FakeAudioContext).currentTime = 2;
  engine.note('bass', 40, .25, 2.02, undefined, false, 'deckA');
  assert.equal(lane.pendingProfile, undefined);
  assert.ok(curveWrites > afterFirst);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext?: unknown }).AudioContext = previousAudioContext;
});

test('bass VCA controller retains earlier segments when a later segment is added', () => {
  const controller = new BassVcaController(0);
  controller.schedule(1, 1, .1);
  controller.schedule(.5, 2, .2);
  assert.equal(controller.valueAt(1.05) > 0, true);
  assert.equal(controller.valueAt(2.2), .5);
  assert.equal(controller.segments().length, 2);
});

test('bass note-only operations do not mutate cached graph settings in live, deck, solo, or debug lanes', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const lanes = bassLanesOf(engine);
  const before = new Map([...lanes].map(([name, lane]) => [name, bassGraphWrites(lane)]));

  engine.note('bass', 36, .2, .02, undefined, false, 'live', .5);
  engine.note('bass', 40, .2, .04, undefined, true, 'deckA', .7);
  engine.note('bass', 43, .2, .06, undefined, true, 'deckB', .3);
  engine.note('bass', 47, .2, .08, undefined, false, 'solo', .9);
  engine.debugNote('bass', 52, .2, .1, undefined, 'live', .4);

  for (const [name, lane] of lanes) assertBassGraphUnchanged(lane, before.get(name)!);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext?: unknown }).AudioContext = previousAudioContext;
});

test('two distinct but identical bass profiles are fingerprint no-ops', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const first = engine.getSoundProfile('bass', 'first');
  const second = { ...first, controls: { ...first.controls }, parameters: { ...first.parameters } };
  assert.notEqual(first, second);
  const lane = bassLanesOf(engine).get('deckA')!;
  engine.updateBassLaneProfile('deckA', first);
  const before = bassGraphWrites(lane);
  engine.note('bass', 36, .2, .02, first, true, 'deckA', 1);
  engine.updateBassLaneProfile('deckA', second);
  engine.note('bass', 40, .2, .04, second, true, 'deckA', 1);
  assertBassGraphUnchanged(lane, before);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = previousAudioContext;
});

test('graph-level bass profile changes defer until each lane is silent', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const context = engine.context as unknown as FakeAudioContext;
  const profiles = new Map<string, DeckSoundProfile>();
  for (const laneName of PERSISTENT_BASS_LANES) {
    const lane = bassLanesOf(engine).get(laneName)!;
    const baseline = bassGraphWrites(lane);
    const profile = engine.getSoundProfile('bass', `${laneName}-profile`);
    profiles.set(laneName, profile);
    engine.note('bass', 36, .25, .01, profile, laneName === 'deckA' || laneName === 'deckB', laneName, 1);
    context.currentTime = .02;
    const changed = { ...profile, controls: { ...profile.controls, drive: Math.min(1, (profile.controls.drive ?? 0) + .2), shape: Math.min(1, (profile.controls.shape ?? 0) + .2) } };
    const deferred = engine.updateBassLaneProfile(laneName, changed);
    assert.equal(deferred.deferred, true, laneName);
    assert.ok(lane.pendingProfile, laneName);
    assertBassGraphUnchanged(lane, baseline);
    engine.note('bass', 40, .25, .03, profile, laneName === 'deckA' || laneName === 'deckB', laneName, .6);
    assert.ok(lane.pendingProfile, `${laneName} remains deferred while audible`);
  }

  context.currentTime = 2;
  for (const laneName of PERSISTENT_BASS_LANES) {
    const lane = bassLanesOf(engine).get(laneName)!;
    const curveCount = lane.shaper.curveSetCount;
    engine.note('bass', 43, .25, 2.01, profiles.get(laneName), laneName === 'deckA' || laneName === 'deckB', laneName, 1);
    assert.equal(lane.pendingProfile, undefined, laneName);
    assert.equal(lane.shaper.curveSetCount, curveCount + 1, laneName);
  }
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = previousAudioContext;
});

test('audible bass AudioParam profile changes defer instead of jumping static settings', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const context = engine.context as unknown as FakeAudioContext;
  const lane = bassLanesOf(engine).get('live')!;
  const profile = engine.getSoundProfile('bass', 'safe-param');
  engine.note('bass', 36, .5, .01, profile, false, 'live');
  context.currentTime = .02;
  const filterOperations = lane.filter.frequency.operations.length;
  const subOperations = lane.subGain.gain.operations.length;
  const changed = { ...profile, parameters: { ...profile.parameters, filterHz: (profile.parameters.filterHz ?? 900) + 100 }, controls: { ...profile.controls, tone: Math.min(1, (profile.controls.tone ?? .5) + .1) } };
  assert.equal(engine.updateBassLaneProfile('live', changed).deferred, true);
  assert.equal(lane.filter.frequency.operations.length, filterOperations);
  assert.equal(lane.subGain.gain.operations.length, subOperations);
  assert.equal(engine.updateBassLaneProfile('live', { ...changed, controls: { ...changed.controls }, parameters: { ...changed.parameters } }).deferred, true);
  assert.equal(lane.filter.frequency.operations.length, filterOperations);
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = previousAudioContext;
});

test('overlapping bass velocities use note envelope automation and never rescale profile gain', async () => {
  const previousAudioContext = (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = FakeAudioContext;
  const engine = new SynthEngine();
  await engine.start();
  const context = engine.context as unknown as FakeAudioContext;
  const lane = bassLanesOf(engine).get('live')!;
  const profileGainWrites = lane.profileGain.gain.operations.length;
  engine.note('bass', 36, .2, .01, undefined, false, 'live', 1);
  context.currentTime = .05;
  engine.note('bass', 36, .2, .06, undefined, false, 'live', .2);
  assert.equal(lane.profileGain.gain.operations.length, profileGainWrites);
  const noteLevelOperations = lane.envelope.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime');
  assert.ok(noteLevelOperations.some((operation) => typeof operation.value === 'number' && Math.abs(operation.value - .2) < .000001));
  assert.equal(lane.envelope.gain.operations.some((operation) => operation.method === 'setValueCurveAtTime'), false);
  assert.equal(lane.envelope.gain.operations.some((operation) => operation.method === 'setValueAtTime' && operation.value !== 0), false);
  assert.ok(lane.envelope.gain.operations.some((operation) => operation.method === 'cancelAndHoldAtTime'));
  engine.dispose();
  if (previousAudioContext === undefined) delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  else (globalThis as unknown as { AudioContext: typeof FakeAudioContext }).AudioContext = previousAudioContext;
});

test('native bass VCA retriggers use cancel-and-hold plus linear ramps without curve anchoring', async () => {
  for (const phase of [
    { name: 'attack', now: .001 },
    { name: 'decay', now: .02 },
    { name: 'sustain', now: .2 },
    { name: 'release', now: .6 },
  ]) {
    await withFakeAudio((engine, context) => {
      const lane = bassLanesOf(engine).get('live')!;
      engine.note('bass', 36, .25, 0, undefined, false, 'live', 1);
      context.currentTime = phase.now;
      engine.note('bass', 36, .25, phase.now, undefined, false, 'live', .8);
      const operations = lane.gate.gain.operations;
      assert.ok(operations.some((operation) => operation.method === 'cancelAndHoldAtTime'), phase.name);
      assert.ok(operations.some((operation) => operation.method === 'linearRampToValueAtTime'), phase.name);
      assert.equal(operations.some((operation) => operation.method === 'setValueCurveAtTime'), false, phase.name);
      assert.equal(operations.some((operation) => operation.method === 'setValueAtTime'), false, phase.name);
      const onsetRamps = operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1);
      assert.ok(onsetRamps.length >= 2, `${phase.name} retrigger did not schedule a second onset`);
      assert.ok(onsetRamps.at(-1)!.start >= phase.now, phase.name);
    });
  }
});

test('same-note bass retriggers schedule a second onset at 0, 1, 5, 10, 20, 50, and 100 ms', async () => {
  for (const gapMs of [0, 1, 5, 10, 20, 50, 100]) {
    await withFakeAudio((engine, context) => {
      const lane = bassLanesOf(engine).get('live')!;
      engine.note('bass', 36, .25, 0, undefined, false, 'live', 1);
      context.currentTime = gapMs / 1000;
      engine.note('bass', 36, .25, context.currentTime, undefined, false, 'live', 1);
      const onsetRamps = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1);
      assert.ok(onsetRamps.length >= 2, `gap ${gapMs} ms did not schedule two onsets`);
      assert.ok(onsetRamps.at(-1)!.start >= context.currentTime, `gap ${gapMs} ms onset was not scheduled at the second time`);
    });
  }
});

test('finite bass native release reaches zero at the intended gate and release end', async () => {
  await withFakeAudio((engine) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 10, undefined, true, 'deckA', 1);
    const release = lane.gate.gain.operations.find((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 0);
    assert.ok(release);
    assert.equal(release!.start, 10.25);
    assert.equal(release!.duration, .5);
  });
});

test('stopping a bass lane cancels future automation and resets its inner envelope after the fade', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 0, undefined, true, 'deckA');
    context.currentTime = .01;

    engine.stopLaneVoices('deckA');

    assert.equal(lane.current, null);
    assert.ok(lane.envelope.gain.operations.some((operation) => operation.method === 'cancelAndHoldAtTime' && operation.start === .01));
    assert.ok(lane.main.frequency.operations.some((operation) => operation.method === 'cancelAndHoldAtTime' && operation.start === .01));
    assert.ok(lane.sub.frequency.operations.some((operation) => operation.method === 'cancelAndHoldAtTime' && operation.start === .01));
    assert.ok(lane.gate.gain.operations.some((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 0 && Math.abs(operation.start - .01) < .000001 && Math.abs(operation.duration - .02) < .000001));
    const reset = lane.envelope.gain.operations.find((operation) => operation.method === 'setValueAtTime' && operation.value === 0 && Math.abs(operation.start - .03) < .000001);
    assert.ok(reset);
    assert.ok(lane.envelopeState.valueAt(.029) > .01);
    assert.equal(lane.envelopeState.valueAt(.03), 0);
  });
});

test('live bass envelope stays active during release and resets after the final gate is silent', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('live')!;
    engine.holdNote('first', 'bass', 36);
    const token = lane.current!.token;
    engine.releaseNote('first');
    const releaseEnd = lane.current!.releaseEnd!;
    assert.equal(lane.envelopeResetToken, token);
    assert.ok(lane.envelopeState.valueAt(releaseEnd - .001) > .01);
    assert.equal(lane.envelopeState.valueAt(releaseEnd), 0);
    assert.equal(lane.envelopeState.valueAt(releaseEnd + .1), 0);
    const reset = lane.envelope.gain.operations.find((operation) => operation.method === 'setValueAtTime' && operation.value === 0 && Math.abs(operation.start - releaseEnd) < 1e-9);
    assert.ok(reset);
    context.currentTime = releaseEnd;
  });
});

test('finite deck bass resets its internal envelope only after releaseEnd', async () => {
  await withFakeAudio((engine) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 10, undefined, true, 'deckA');
    const releaseEnd = lane.current!.releaseEnd!;
    assert.ok(lane.envelopeState.valueAt(releaseEnd - .001) > .01);
    assert.equal(lane.envelopeState.valueAt(releaseEnd), 0);
    const reset = lane.envelope.gain.operations.find((operation) => operation.method === 'setValueAtTime' && operation.value === 0 && Math.abs(operation.start - releaseEnd) < 1e-9);
    assert.ok(reset);
  });
});

test('bass retrigger cancels a pending envelope reset before it can zero the new note', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 0, undefined, true, 'deckA');
    const oldReleaseEnd = lane.current!.releaseEnd!;
    const oldToken = lane.current!.token;
    context.currentTime = .2;
    engine.note('bass', 40, null, context.currentTime, undefined, true, 'deckA');
    assert.notEqual(lane.envelopeResetToken, oldToken);
    assert.equal(lane.envelopeState.segments().some((segment) => Math.abs(segment.start - oldReleaseEnd) < 1e-9), false);
    assert.ok(lane.envelopeState.valueAt(oldReleaseEnd) > .01);
    assert.equal(lane.current?.token === oldToken, false);
  });
});

test('a bass onset at completed release starts its internal envelope from zero and uses silence onset', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 0, undefined, true, 'deckA');
    const releaseEnd = lane.current!.releaseEnd!;
    context.currentTime = releaseEnd;
    engine.note('bass', 40, null, releaseEnd, undefined, true, 'deckA');
    const attack = lane.envelopeState.segments().find((segment) => Math.abs(segment.start - releaseEnd) < 1e-9);
    assert.ok(attack);
    assert.equal(attack!.from, 0);
    const onset = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1).at(-1)!;
    assert.ok(Math.abs(onset.duration - .005) < 1e-9);
  });
});

test('an older bass release token cannot schedule an envelope reset on a newer note', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 0, undefined, true, 'deckA');
    const oldReleaseEnd = lane.current!.releaseEnd!;
    const oldToken = lane.current!.token;
    context.currentTime = .2;
    engine.note('bass', 40, null, context.currentTime, undefined, true, 'deckA');
    const newerToken = lane.current!.token;
    const scheduleReset = (engine as unknown as { scheduleBassEnvelopeReset: (lane: TestBassLane, at: number, token: number) => unknown }).scheduleBassEnvelopeReset;
    assert.equal(scheduleReset.call(engine, lane, oldReleaseEnd, oldToken), undefined);
    assert.equal(lane.envelopeResetToken, newerToken);
    assert.ok(lane.envelopeState.valueAt(oldReleaseEnd) > .01);
  });
});

test('held live bass is an audible retrigger and uses the longer onset crossfade', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('live')!;
    engine.holdNote('first', 'bass', 36);
    assert.equal(lane.current?.releaseEnd, undefined);
    context.currentTime = .02;
    engine.note('bass', 40, null, context.currentTime, undefined, false, 'live');
    const onsets = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1);
    assert.ok(Math.abs(onsets.at(-2)!.duration - .005) < 1e-9);
    assert.ok(Math.abs(onsets.at(-1)!.duration - .02) < 1e-9);
    assert.equal((engine as unknown as { pendingBassReleases: Array<{ cause?: string }> }).pendingBassReleases.at(-1)?.cause, 'retrigger');
  });
});

test('a released held bass note retriggers until its releaseEnd, including the gateEnd-null case', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('live')!;
    engine.holdNote('first', 'bass', 36);
    engine.releaseNote('first');
    const releaseEnd = lane.current!.releaseEnd!;
    assert.equal(lane.current!.gateEnd, null);
    context.currentTime = releaseEnd - .015;
    engine.note('bass', 40, null, context.currentTime, undefined, false, 'live');
    const onset = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1).at(-1)!;
    assert.ok(Math.abs(onset.duration - .02) < 1e-9);
    assert.equal((engine as unknown as { pendingBassReleases: Array<{ cause?: string }> }).pendingBassReleases.at(-1)?.cause, 'retrigger');
  });
});

test('a held bass release is silent at and after releaseEnd and takes the silence onset path', async () => {
  for (const extraTime of [0, .01]) {
    await withFakeAudio((engine, context) => {
      const lane = bassLanesOf(engine).get('live')!;
      engine.holdNote('first', 'bass', 36);
      engine.releaseNote('first');
      const releaseEnd = lane.current!.releaseEnd!;
      const markersBefore = (engine as unknown as { pendingBassReleases: Array<unknown> }).pendingBassReleases.length;
      context.currentTime = releaseEnd + extraTime;
      engine.note('bass', 40, null, context.currentTime, undefined, false, 'live');
      const onset = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1).at(-1)!;
      assert.ok(Math.abs(onset.duration - .005) < 1e-9, `extra time ${extraTime}`);
      assert.equal((engine as unknown as { pendingBassReleases: Array<unknown> }).pendingBassReleases.length, markersBefore, `extra time ${extraTime}`);
      assert.equal(bassLaneNoteIsAudibleAt({ releaseEnd }, releaseEnd + extraTime), false);
    });
  }
});

test('finite deck bass remains audible through releaseEnd and becomes silent afterward', async () => {
  await withFakeAudio((engine, context) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 10, undefined, true, 'deckA');
    const current = lane.current!;
    assert.equal(current.gateEnd, 10.25);
    assert.equal(current.releaseEnd, 10.75);
    assert.equal(bassLaneNoteIsAudibleAt(current, 10.749999), true);
    assert.equal(bassLaneNoteIsAudibleAt(current, 10.75), false);
    context.currentTime = 10.8;
    engine.note('bass', 40, .25, 10.8, undefined, true, 'deckA');
    const onset = lane.gate.gain.operations.filter((operation) => operation.method === 'linearRampToValueAtTime' && operation.value === 1).at(-1)!;
    assert.ok(Math.abs(onset.duration - .005) < 1e-9);
  });
});

test('expired bass-state retirement cannot clear a newer note token', async () => {
  await withFakeAudio((engine) => {
    const lane = bassLanesOf(engine).get('deckA')!;
    engine.note('bass', 36, .25, 10, undefined, true, 'deckA');
    const old = lane.current!;
    engine.note('bass', 40, .25, 10.1, undefined, true, 'deckA');
    const newer = lane.current!;
    const retire = (engine as unknown as { retireBassLaneNote: (lane: TestBassLane, token: number, heldId?: string) => boolean }).retireBassLaneNote;
    assert.equal(retire(lane, old.token, old.heldId), false);
    assert.equal(lane.current?.token, newer.token);
    assert.equal(retire(lane, newer.token, newer.heldId), true);
    assert.equal(lane.current, null);
  });
});

test('BassVcaController evaluates a piecewise timeline and preserves earlier segments', () => {
  const controller = new BassVcaController(0);
  controller.schedule(1, 0, .01);
  controller.schedule(.5, .01, .2);
  controller.schedule(.5, .21, .4);
  controller.schedule(0, 1, .5);
  assert.ok(controller.valueAt(.005) >= .5 && controller.valueAt(.005) < 1);
  assert.ok(controller.valueAt(.11) > .5 && controller.valueAt(.11) < 1);
  assert.equal(controller.valueAt(.5), .5);
  assert.equal(controller.valueAt(1.5), 0);
  const beforeRelease = controller.valueAt(.3);
  controller.schedule(.8, .3, .2);
  assert.equal(controller.valueAt(.3), beforeRelease);
  assert.equal(controller.valueAt(.1) > 0, true);
  assert.equal(controller.valueAt(.5), .8);
  assert.equal(controller.segments().some((segment) => segment.start === 1), false);

  const attackRetrigger = new BassVcaController(0);
  attackRetrigger.schedule(1, 0, .1);
  const attackValue = attackRetrigger.valueAt(.05);
  attackRetrigger.schedule(.7, .05, .1);
  assert.equal(attackRetrigger.valueAt(.05), attackValue);
  assert.equal(attackRetrigger.valueAt(.15), .7);

  const decayRetrigger = new BassVcaController(0);
  decayRetrigger.schedule(1, 0, .01);
  decayRetrigger.schedule(.4, .01, .4);
  const decayValue = decayRetrigger.valueAt(.2);
  decayRetrigger.schedule(.9, .2, .1);
  assert.equal(decayRetrigger.valueAt(.2), decayValue);
  assert.equal(decayRetrigger.valueAt(.3), .9);

  const releaseRetrigger = new BassVcaController(1);
  releaseRetrigger.schedule(0, 0, .5);
  const releaseValue = releaseRetrigger.valueAt(.25);
  releaseRetrigger.schedule(1, .25, .05);
  assert.equal(releaseRetrigger.valueAt(.25), releaseValue);
  assert.equal(releaseRetrigger.valueAt(.3), 1);

  const sameTime = new BassVcaController(1);
  sameTime.schedule(0, 0, 0);
  sameTime.schedule(1, 0, 0);
  assert.equal(sameTime.valueAt(0), 1);
});

test('bass linear VCA control has no large one-sample retrigger jump at 44.1 kHz', () => {
  const sampleRate = 44100;
  const onset = new BassVcaController(0);
  const gate = new BassVcaController(0);
  onset.schedule(1, 0, .005);
  gate.schedule(1, 0, .005);
  gate.schedule(0, .1, .02);
  let maximumDelta = 0;
  let previous = 0;
  for (let index = 0; index <= Math.ceil(.125 * sampleRate); index++) {
    const seconds = index / sampleRate;
    const value = onset.valueAt(seconds) * gate.valueAt(seconds);
    maximumDelta = Math.max(maximumDelta, Math.abs(value - previous));
    previous = value;
  }
  assert.ok(maximumDelta < .01, `maximum adjacent control delta was ${maximumDelta}`);
  assert.equal(linearFadeValue(0, 1, 0, .005), 0);
  assert.equal(linearFadeValue(0, 1, .005, .005), 1);
});
