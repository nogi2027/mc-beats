import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridAudioEngine } from '../src/hybrid-engine.ts';
import { LegacySynthEngine } from '../src/legacy/audio.ts';
import { createAppEngine } from '../src/engine-factory.ts';
import { MusicController } from '../src/music-controller.ts';
import type { DeckInstrument, DeckSoundProfile } from '../src/deck.ts';
import type { Instrument, SynthSnapshot, VoiceLane, VoiceStatsSnapshot } from '../src/synth/contract.ts';
import { BASS_PRESETS } from '../src/synth/patches/bass.ts';
import { CHORD_PRESETS } from '../src/synth/patches/chords.ts';
import { LEAD_PRESETS } from '../src/synth/patches/lead.ts';

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
  connections: unknown[] = [];
  disconnected = false;
  connect<T>(target: T) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeFilter extends FakeNode { type: BiquadFilterType = 'lowpass'; frequency = new FakeParam(); Q = new FakeParam(); }
class FakeDelay extends FakeNode { delayTime = new FakeParam(); }
class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  detune = new FakeParam();
  type: OscillatorType = 'sine';
  starts: number[] = [];
  stops: number[] = [];
  listeners: Array<() => void> = [];
  start(at = 0) { this.starts.push(at); }
  stop(at = 0) { this.stops.push(at); }
  addEventListener(type: string, listener: () => void) { if (type === 'ended') this.listeners.push(listener); }
  end() { this.listeners.forEach((listener) => listener()); }
}
class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48_000;
  state: AudioContextState = 'running';
  destination = new FakeNode();
  oscillators: FakeOscillator[] = [];
  createGain() { return new FakeGain(); }
  createBiquadFilter() { return new FakeFilter(); }
  createDelay() { return new FakeDelay(); }
  createWaveShaper() { return new FakeShaper(); }
  createOscillator() { const oscillator = new FakeOscillator(); this.oscillators.push(oscillator); return oscillator; }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

const zeroStats = (): VoiceStatsSnapshot => ({
  bass: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
  lead: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
  chords: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
  activeSources: 0,
});

class StubLegacyEngine extends LegacySynthEngine {
  readonly fakeContext: FakeContext;
  readonly calls = { bass: 0, lead: 0, chords: 0, drums: 0, metronome: 0, disposed: 0 };
  readonly laneTargets = new Map<string, number>();
  readonly laneRamps: Array<{ lane: string; value: number; at?: number; duration?: number }> = [];
  readonly enabledState: Record<Instrument, boolean> = { drums: true, bass: true, chords: true, lead: true, metronome: true };

  constructor(fakeContext: FakeContext) { super(); this.fakeContext = fakeContext; }

  override async start() {
    this.context = this.fakeContext as unknown as AudioContext;
    this.master = this.fakeContext.createGain() as unknown as GainNode;
    this.compressor = this.fakeContext.createGain() as unknown as DynamicsCompressorNode;
    this.analyser = this.fakeContext.createGain() as unknown as AnalyserNode;
    this.destination = this.fakeContext.destination as unknown as AudioNode;
  }

  override getPresetIndexes() { return { drums: 0, bass: 0, chords: 0, lead: 0, metronome: 0 }; }

  override getSoundProfile(instrument: DeckInstrument, presetId: string): DeckSoundProfile {
    const profiles = instrument === 'bass' ? BASS_PRESETS : instrument === 'lead' ? LEAD_PRESETS : CHORD_PRESETS;
    return { ...(profiles.find((profile) => profile.presetId === presetId) ?? profiles[0]), controls: { ...(profiles.find((profile) => profile.presetId === presetId) ?? profiles[0]).controls }, parameters: { ...(profiles.find((profile) => profile.presetId === presetId) ?? profiles[0]).parameters } };
  }

  override isInstrumentEnabled(instrument: Instrument) { return this.enabledState[instrument]; }
  override setControl(_instrument: Instrument, _name: string, _value: number) {}
  override setVolume(_instrument: Instrument, _value: number) {}
  override setParameter(_instrument: Instrument, _name: string, _value: number) {}
  override resetParameter(_instrument: Instrument, _presetIndex: number, _name: string) {}
  override loadPreset(_instrument: Instrument, _index: number) {}
  override setInstrumentEnabled(instrument: Instrument, enabled: boolean, _at?: number, updateState = true) { if (updateState) this.enabledState[instrument] = enabled; }
  override commitInstrumentEnabled(instrument: Instrument, enabled: boolean) { this.enabledState[instrument] = enabled; }
  override setLaneGain(lane: Exclude<VoiceLane, 'deck'>, value: number, _at?: number, _duration?: number) { this.laneTargets.set(lane, value); }
  override setLaneGainRamp(lane: Exclude<VoiceLane, 'deck'>, value: number, at?: number, duration?: number) { this.laneTargets.set(lane, value); this.laneRamps.push({ lane, value, at, duration }); }
  override cancelLaneGainAutomation(_lane: Exclude<VoiceLane, 'deck'>, _at?: number) {}
  override cancelInstrumentAutomation(_instrument: Instrument, _at?: number) {}
  override laneGain(lane: Exclude<VoiceLane, 'deck'>) { return this.laneTargets.get(lane) ?? 1; }

  override note(instrument: Exclude<Instrument, 'drums'>, ..._rest: unknown[]) {
    if (instrument === 'bass') this.calls.bass += 1;
    if (instrument === 'lead') this.calls.lead += 1;
    if (instrument === 'chords') this.calls.chords += 1;
    return [] as OscillatorNode[];
  }
  override chord(..._args: unknown[]) { this.calls.chords += 1; return [] as OscillatorNode[]; }
  override drum(..._args: unknown[]) { this.calls.drums += 1; }
  override metronome(..._args: unknown[]) { this.calls.metronome += 1; }
  override holdNote(id: string, instrument: Exclude<Instrument, 'drums'>, midi: number) {
    const voice = this.fakeContext.createOscillator() as unknown as OscillatorNode;
    this.heldNotes.set(id, [voice]);
    this.heldNoteKinds.set(id, instrument);
    return [voice];
  }
  override releaseNote(id: string) { this.heldNotes.delete(id); this.heldNoteKinds.delete(id); return null; }
  override getLegacyOnlyVoiceStats() { return zeroStats(); }
  override getBassReleaseDiagnostics() { return []; }
  override readOutputSpectrum(_buffer: Float32Array<ArrayBuffer>) { return false; }
  override getSynthSnapshot(): SynthSnapshot {
    return {
      context: { state: this.context?.state ?? null, currentTime: this.context?.currentTime ?? null, sampleRate: this.context?.sampleRate ?? null },
      tempo: this.tempo,
      drumModel: this.drumModel,
      presetIndexes: this.getPresetIndexes(),
      instrumentEnabled: { ...this.enabledState },
      controls: this.controls,
      volumes: this.volumes,
      parameters: this.parameters,
      heldNotes: [],
      voiceStats: zeroStats(),
      bassLanes: [],
      bassReleaseDiagnostics: [],
    };
  }
  override dispose() { this.calls.disposed += 1; this.context = null; this.master = null; this.compressor = null; this.analyser = null; this.destination = null; }
}

class MutableStubLegacyEngine extends StubLegacyEngine {
  override setControl(instrument: Instrument, name: string, value: number) { this.controls[instrument][name] = value; }
  override setVolume(instrument: Instrument, value: number) { this.volumes[instrument] = value; }
  override setParameter(instrument: Instrument, name: string, value: number) { const parameter = this.parameters[instrument][name]; if (parameter) parameter.value = value; }
  override setInstrumentEnabled(instrument: Instrument, enabled: boolean, _at?: number, updateState = true) { if (updateState) this.enabledState[instrument] = enabled; }
  override commitInstrumentEnabled(instrument: Instrument, enabled: boolean) { this.enabledState[instrument] = enabled; }
  override getSoundProfile(instrument: DeckInstrument, presetId: string): DeckSoundProfile {
    const base = super.getSoundProfile(instrument, presetId);
    const parameters = Object.fromEntries(Object.entries(this.parameters[instrument]).map(([name, parameter]) => [name, parameter.value]));
    return { ...base, controls: { ...this.controls[instrument] }, parameters, volume: this.volumes[instrument] };
  }
}

const runningHybridController = async () => {
  const context = new FakeContext();
  const legacy = new MutableStubLegacyEngine(context);
  const hybrid = new HybridAudioEngine(legacy);
  const controller = new MusicController(hybrid);
  assert.equal((await controller.startAudio()).ok, true);
  (controller as unknown as { clockRunning: boolean }).clockRunning = true;
  controller.transport.isPlaying = () => true;
  return { context, legacy, hybrid, controller };
};

const pendingController = (controller: MusicController) => controller as unknown as {
  pendingCues: Array<{ id: string; action: unknown }>;
  scheduleCueAudio: (cue: { id: string; action: unknown }, at: number) => void;
  preScheduledAudio: Map<string, unknown>;
};

test('hybrid uses one legacy context/master and routes migrated instruments only to independent engines', async () => {
  const fakeContext = new FakeContext();
  const legacy = new StubLegacyEngine(fakeContext);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  assert.equal(hybrid.context, fakeContext);
  assert.equal((hybrid as unknown as { bass: { context: BaseAudioContext } }).bass.context, fakeContext);
  assert.equal((hybrid as unknown as { lead: { context: BaseAudioContext } }).lead.context, fakeContext);
  assert.equal((hybrid as unknown as { chords: { context: BaseAudioContext } }).chords.context, fakeContext);
  assert.equal((hybrid as unknown as { bass: { destination: AudioNode } }).bass.destination, legacy.master);
  assert.equal((hybrid as unknown as { lead: { runtime: { destination: AudioNode } } }).lead.runtime.destination, legacy.master);
  assert.equal((hybrid as unknown as { chords: { runtime: { destination: AudioNode } } }).chords.runtime.destination, legacy.master);

  assert.ok(hybrid.note('bass', 36, .1, 0, undefined, false, 'live', 1).length > 0);
  assert.ok(hybrid.note('lead', 60, .1, 0, undefined, false, 'live', 1).length > 0);
  assert.ok(hybrid.chord([48, 52, 55], .1, 0, undefined, false, 'deckA', 1).length > 0);
  assert.equal(legacy.calls.bass, 0);
  assert.equal(legacy.calls.lead, 0);
  assert.equal(legacy.calls.chords, 0);

  hybrid.drum(0, 0);
  hybrid.metronome(false, 0);
  assert.equal(legacy.calls.drums, 0);
  assert.equal(legacy.calls.metronome, 0);
  const metronome = (hybrid as unknown as { metronomeEngine: { runtime: { destination: AudioNode; pool: { retainedCount: (instrument: Instrument) => number } } } }).metronomeEngine;
  assert.equal(metronome.runtime.destination, legacy.master);
  assert.equal(metronome.runtime.pool.retainedCount('metronome'), 1);
  assert.equal((hybrid.getSynthSnapshot() as SynthSnapshot & { independentMetronomeVoices: unknown[] }).independentMetronomeVoices.length, 1);
  fakeContext.oscillators.forEach((oscillator) => oscillator.end());
  fakeContext.currentTime = 1;
  metronome.runtime.pool.all().forEach((voice) => voice.finishIfSilent(1));
  hybrid.dispose();
});

test('hybrid held chord ownership stays at the engine boundary and releases only its own ID', async () => {
  const fakeContext = new FakeContext();
  const legacy = new StubLegacyEngine(fakeContext);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  assert.ok(hybrid.holdChord('chord-a', [48, 52, 55]).length > 0);
  assert.ok(hybrid.holdChord('chord-b', [50, 53, 57]).length > 0);
  assert.equal(hybrid.hasHeldNote('chord-a'), true);
  assert.equal(hybrid.hasHeldNote('chord-b'), true);
  hybrid.releaseNote('chord-a');
  assert.equal(hybrid.hasHeldNote('chord-a'), false);
  assert.equal(hybrid.hasHeldNote('chord-b'), true);
  assert.equal(legacy.calls.chords, 0);
});

test('hybrid combines independent voice stats and preserves the migrated engine mode in snapshots', async () => {
  const fakeContext = new FakeContext();
  const legacy = new StubLegacyEngine(fakeContext);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  hybrid.note('bass', 36, .1, 0, undefined, false, 'deckA');
  hybrid.note('lead', 60, .1, 0, undefined, false, 'deckB');
  hybrid.chord([48, 52], .1, 0, undefined, false, 'solo');
  const stats = hybrid.getVoiceStats();
  assert.equal(stats.bass.musicalVoices, 1);
  assert.equal(stats.lead.musicalVoices, 1);
  assert.equal(stats.chords.musicalVoices, 2);
  assert.equal((hybrid.getSynthSnapshot() as SynthSnapshot & Record<string, unknown>).engineMode, 'hybrid');
  hybrid.dispose();
  assert.equal(legacy.calls.disposed, 0);
  const independent = hybrid as unknown as { bass: { pool: { all: () => Array<{ finishIfSilent: (at: number) => void }>; } }; lead: { runtime: { pool: { all: () => Array<{ finishIfSilent: (at: number) => void }>; } }; }; chords: { runtime: { pool: { all: () => Array<{ finishIfSilent: (at: number) => void }>; } }; } };
  fakeContext.oscillators.forEach((oscillator) => oscillator.end());
  fakeContext.currentTime = 2;
  [...independent.bass.pool.all(), ...independent.lead.runtime.pool.all(), ...independent.chords.runtime.pool.all()].forEach((voice) => voice.finishIfSilent(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(legacy.calls.disposed, 1);
});

test('hybrid synchronizes deck lane defaults and pre-start active deck selection', async () => {
  const firstContext = new FakeContext();
  const first = new HybridAudioEngine(new StubLegacyEngine(firstContext));
  await first.start();
  assert.equal(first.laneGain('deckA'), 1);
  assert.equal(first.laneGain('deckB'), 0);
  assert.ok(first.note('bass', 36, .1, 0, undefined, true, 'deckA').length > 0);
  assert.ok(first.note('bass', 48, .1, 0, undefined, true, 'deckB').length > 0);
  const bass = (first as unknown as { bass: { laneGain: (lane: VoiceLane) => number } }).bass;
  assert.equal(bass.laneGain('deckA'), 1);
  assert.equal(bass.laneGain('deckB'), 0);
  first.dispose();

  const secondContext = new FakeContext();
  const secondLegacy = new StubLegacyEngine(secondContext);
  const second = new HybridAudioEngine(secondLegacy);
  const controller = new MusicController(second);
  controller.selectActiveDeck('B');
  const started = await controller.startAudio();
  assert.equal(started.ok, true);
  assert.equal(second.laneGain('deckA'), 0);
  assert.equal(second.laneGain('deckB'), 1);
  assert.equal(secondLegacy.laneGain('deckA'), 0);
  assert.equal(secondLegacy.laneGain('deckB'), 1);
  controller.dispose();
});

test('hybrid routes debug holds to the debug lane and scoped debug stop clears held state', async () => {
  const context = new FakeContext();
  const hybrid = new HybridAudioEngine(new StubLegacyEngine(context));
  const controller = new MusicController(hybrid);
  assert.equal((await controller.startAudio()).ok, true);
  const held = controller.debugHoldInstrumentFrequency({ id: 'debug-bass', instrument: 'bass', frequencyHz: 55 });
  assert.equal(held.ok, true);
  assert.equal(hybrid.hasHeldNote('debug-bass'), true);
  assert.equal(hybrid.laneGain('debug'), 1);
  const stopped = controller.debugStopAll('debug');
  assert.equal(stopped.ok, true);
  assert.equal(hybrid.hasHeldNote('debug-bass'), false);
  const released = controller.debugReleaseHeldNote('debug-bass');
  assert.equal(released.ok, false);
  assert.equal(released.code, 'NOTE_NOT_FOUND');
  controller.dispose();
});

test('hybrid mirrors delegated held notes and clears only the stopped lane', async () => {
  const context = new FakeContext();
  const hybrid = new HybridAudioEngine(new StubLegacyEngine(context));
  await hybrid.start();
  hybrid.holdNote('metronome-live', 'metronome', 60);
  assert.equal(hybrid.hasHeldNote('metronome-live'), true);
  hybrid.stopLaneVoices('solo');
  assert.equal(hybrid.hasHeldNote('metronome-live'), true);
  hybrid.stopLaneVoices('live');
  assert.equal(hybrid.hasHeldNote('metronome-live'), false);
  hybrid.dispose();
});

test('hybrid applies one transfer time and duration to every instrument lane path', async () => {
  const context = new FakeContext();
  const legacy = new StubLegacyEngine(context);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  hybrid.setLaneGainRamp('deckA', 0, 3, .25);
  hybrid.setLaneGainRamp('deckB', 1, 3, .25);
  assert.deepEqual(legacy.laneRamps.slice(-2), [
    { lane: 'deckA', value: 0, at: 3, duration: .25 },
    { lane: 'deckB', value: 1, at: 3, duration: .25 },
  ]);
  const getOps = (engine: 'bass' | 'lead' | 'chords', lane: VoiceLane) => {
    const value = hybrid as unknown as Record<string, { laneState?: unknown; runtime?: { laneState: (lane: VoiceLane) => { output: { gain: { operations: Array<{ start?: number; end?: number }> } } } } }>;
    const target = value[engine];
    const output = engine === 'bass'
      ? (target as unknown as { laneState: (lane: VoiceLane) => { output: { gain: { operations: Array<{ start?: number; end?: number }> } } } }).laneState(lane).output
      : target.runtime!.laneState(lane).output;
    return output.gain.operations.at(-1);
  };
  for (const engine of ['bass', 'lead', 'chords'] as const) {
    assert.equal(getOps(engine, 'deckA')?.end, 3.25);
    assert.equal(getOps(engine, 'deckB')?.end, 3.25);
  }
  hybrid.dispose();
});

test('engine factory keeps the explicit legacy rollback switch', () => {
  assert.equal((createAppEngine('?synth=legacy') as unknown as { mode?: string }).mode, undefined);
  assert.equal((createAppEngine('') as unknown as { mode?: string }).mode, 'hybrid');
});

test('hybrid controls and profiles affect only future independent voices', async () => {
  const context = new FakeContext();
  const hybrid = new HybridAudioEngine(new MutableStubLegacyEngine(context));
  await hybrid.start();
  hybrid.note('bass', 36, null, 0, undefined, false, 'live', 1);
  const bass = (hybrid as unknown as { bass: { pool: { all: () => Array<{ profile: { profile?: DeckSoundProfile } }> } } }).bass;
  const firstProfile = bass.pool.all()[0].profile.profile!;
  const initialTone = firstProfile.controls.tone;
  const initialVolume = firstProfile.volume;
  hybrid.setControl('bass', 'tone', .91);
  hybrid.setParameter('bass', 'filterHz', 700);
  hybrid.setVolume('bass', .21);
  hybrid.note('bass', 43, null, 0, undefined, false, 'live', 1);
  const profiles = bass.pool.all().map((voice) => voice.profile.profile!);
  assert.equal(firstProfile.controls.tone, initialTone);
  assert.equal(profiles.some((profile) => profile.controls.tone === .91), true);
  assert.equal(firstProfile.volume, initialVolume);
  assert.equal(profiles.some((profile) => profile.volume === .21), true);
  hybrid.dispose();
});

test('hybrid disable stops migrated voices, blocks new notes, and re-enable starts fresh voices', async () => {
  const context = new FakeContext();
  const legacy = new MutableStubLegacyEngine(context);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  assert.ok(hybrid.note('lead', 60, null, 0, undefined, false, 'live').length > 0);
  hybrid.setInstrumentEnabled('lead', false);
  assert.equal(hybrid.isInstrumentEnabled('lead'), false);
  assert.equal(hybrid.note('lead', 62, null, 0, undefined, false, 'live').length, 0);
  hybrid.setInstrumentEnabled('lead', true);
  assert.equal(hybrid.isInstrumentEnabled('lead'), true);
  assert.ok(hybrid.note('lead', 62, null, 0, undefined, false, 'live').length > 0);
  hybrid.holdNote('held-lead', 'lead', 64);
  hybrid.stopLaneVoices('live');
  assert.equal(hybrid.hasHeldNote('held-lead'), false);
  hybrid.panic();
  assert.equal(hybrid.hasHeldNote('held-lead'), false);
  hybrid.dispose();
});

test('future migrated disable only schedules gain and preserves held state until its boundary', async () => {
  const { context, hybrid, controller } = await runningHybridController();
  assert.ok(hybrid.holdNote('held-bass', 'bass', 36).length > 0);
  const queued = controller.queueAction({ cycle: 0, bar: 1, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  assert.equal(queued.ok, true);
  const privateController = pendingController(controller);
  const cue = privateController.pendingCues[0];
  privateController.scheduleCueAudio(cue, 2);
  const bass = (hybrid as unknown as { bass: { isInstrumentEnabled: () => boolean; pool: { all: () => Array<{ stateAt: (at: number) => string }> } } }).bass;
  context.currentTime = .01;
  assert.equal(hybrid.hasHeldNote('held-bass'), true);
  assert.equal(hybrid.isInstrumentEnabled('bass'), true);
  assert.equal(bass.isInstrumentEnabled(), true);
  assert.equal(bass.pool.all()[0].stateAt(context.currentTime), 'active');
  assert.ok(hybrid.note('bass', 43, .1, 0, undefined, false, 'live').length > 0);
  context.currentTime = 1.99;
  assert.equal(hybrid.hasHeldNote('held-bass'), true);
  assert.equal(controller.getState().instrumentEnabled.bass, true);
  controller.dispose();
});

test('cancelling a future migrated disable restores automation without releasing its held voice', async () => {
  const { context, hybrid, controller } = await runningHybridController();
  assert.ok(hybrid.holdNote('held-lead', 'lead', 60).length > 0);
  const queued = controller.queueAction({ cycle: 0, bar: 1, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'lead', enabled: false });
  assert.equal(queued.ok, true);
  const privateController = pendingController(controller);
  privateController.scheduleCueAudio(privateController.pendingCues[0], 2);
  assert.equal(controller.cancelCue(queued.data!.cueId).ok, true);
  context.currentTime = 2.1;
  const lead = (hybrid as unknown as { lead: { runtime: { isEnabled: () => boolean }; getVoiceSnapshots: () => Array<{ state: string }> } }).lead;
  assert.equal(hybrid.hasHeldNote('held-lead'), true);
  assert.equal(hybrid.isInstrumentEnabled('lead'), true);
  assert.equal(lead.runtime.isEnabled(), true);
  assert.equal(lead.getVoiceSnapshots()[0].state, 'active');
  assert.equal(controller.getState().instrumentEnabled.lead, true);
  controller.dispose();
});

test('executing a future disable commits controller, legacy, and independent state at the boundary', async () => {
  const { context, legacy, hybrid, controller } = await runningHybridController();
  assert.ok(hybrid.holdNote('held-chords', 'chords', 48).length > 0);
  const queued = controller.queueAction({ cycle: 0, bar: 1, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'chords', enabled: false });
  assert.equal(queued.ok, true);
  const privateController = pendingController(controller);
  privateController.scheduleCueAudio(privateController.pendingCues[0], 2);
  context.currentTime = 2;
  assert.equal(controller.executeCueNow(queued.data!.cueId, 2).ok, true);
  const chords = (hybrid as unknown as { chords: { runtime: { isEnabled: () => boolean }; getVoiceSnapshots: () => Array<{ state: string }> } }).chords;
  assert.equal(controller.getState().instrumentEnabled.chords, false);
  assert.equal(legacy.isInstrumentEnabled('chords'), false);
  assert.equal(hybrid.isInstrumentEnabled('chords'), false);
  assert.equal(chords.runtime.isEnabled(), false);
  assert.equal(hybrid.hasHeldNote('held-chords'), false);
  assert.equal(chords.getVoiceSnapshots()[0].state, 'releasing');
  const snapshot = hybrid.getSynthSnapshot() as SynthSnapshot & Record<string, unknown>;
  assert.equal(snapshot.instrumentEnabled.chords, false);
  controller.dispose();
});

test('future off/on cues remain deterministic when the off cue is cancelled and automation is reinstalled', async () => {
  const { context, hybrid, legacy, controller } = await runningHybridController();
  const off = controller.queueAction({ cycle: 0, bar: 1, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'bass', enabled: false });
  const on = controller.queueAction({ cycle: 0, bar: 2, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'bass', enabled: true });
  assert.equal(off.ok, true);
  assert.equal(on.ok, true);
  const privateController = pendingController(controller);
  privateController.pendingCues.forEach((cue) => privateController.scheduleCueAudio(cue, cue.id === off.data!.cueId ? 2 : 4));
  assert.equal(controller.cancelCue(off.data!.cueId).ok, true);
  assert.equal(privateController.preScheduledAudio.has(on.data!.cueId), true);
  context.currentTime = 4;
  assert.equal(controller.executeCueNow(on.data!.cueId, 4).ok, true);
  assert.equal(controller.getState().instrumentEnabled.bass, true);
  assert.equal(legacy.isInstrumentEnabled('bass'), true);
  assert.equal(hybrid.isInstrumentEnabled('bass'), true);
  controller.dispose();
});

test('future legacy drum disable commits logical legacy state at execution', async () => {
  const { context, legacy, hybrid, controller } = await runningHybridController();
  const queued = controller.queueAction({ cycle: 0, bar: 1, tick: 0 }, { type: 'set-instrument-enabled', instrument: 'drums', enabled: false });
  assert.equal(queued.ok, true);
  const privateController = pendingController(controller);
  privateController.scheduleCueAudio(privateController.pendingCues[0], 2);
  assert.equal(controller.getState().instrumentEnabled.drums, true);
  assert.equal(legacy.isInstrumentEnabled('drums'), true);
  context.currentTime = 2;
  assert.equal(controller.executeCueNow(queued.data!.cueId, 2).ok, true);
  assert.equal(controller.getState().instrumentEnabled.drums, false);
  assert.equal(legacy.isInstrumentEnabled('drums'), false);
  assert.equal(hybrid.isInstrumentEnabled('drums'), false);
  controller.dispose();
});

test('suspended hybrid disposal reaches final cleanup through the bounded wall-clock fallback', async () => {
  const context = new FakeContext();
  context.state = 'suspended';
  const legacy = new StubLegacyEngine(context);
  const hybrid = new HybridAudioEngine(legacy);
  await hybrid.start();
  assert.ok(hybrid.note('lead', 60, null, 0, undefined, false, 'live').length > 0);
  context.state = 'suspended';
  const independent = hybrid as unknown as { lead: { retainedCount: () => number } };
  hybrid.dispose();
  assert.equal(legacy.calls.disposed, 0);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(legacy.calls.disposed, 1);
  assert.equal(independent.lead.retainedCount(), 0);
  hybrid.dispose();
  assert.equal(legacy.calls.disposed, 1);
});
