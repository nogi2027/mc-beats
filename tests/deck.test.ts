import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckRecorder, DeckTransport, EIGHTH_NOTE_TICKS, SharedDeckTransport, SingleDeck, clampArticulation, playbackDurationSeconds, quantizedDuration, quantizedStart, safeTempo, ticksToSeconds } from '../src/deck.ts';
import { adsrLevelAt, analyseBassReleaseWindow, BassVcaController, bassLaneNoteIsAudibleAt, bassVcaAutomationTiming, bassVcaRetriggerTiming, bassVcaSchedule, canChokeVoiceGroup, countMusicalVoices, countMusicalVoicesInLane, linearFadeValue, releaseEndTime, safeReleaseDuration, voiceGroupIsTracked, voiceGroupReleaseState, voiceGroupStopState } from '../src/audio.ts';

test('recording quantizes note start and end separately', () => {
  const start = EIGHTH_NOTE_TICKS * 2 + 90;
  const end = EIGHTH_NOTE_TICKS * 4 - 70;

  assert.equal(quantizedStart(start), EIGHTH_NOTE_TICKS * 2);
  assert.equal(quantizedDuration(start, end), EIGHTH_NOTE_TICKS * 2);
});

test('quantization turns a same-grid tap into one eighth note', () => {
  const tick = EIGHTH_NOTE_TICKS * 3 + 8;

  assert.equal(quantizedDuration(tick, tick + 8), EIGHTH_NOTE_TICKS);

  const deck = new SingleDeck();
  const event = deck.addNote('bass', 36, tick, 0);
  assert.equal(event.durationTicks, EIGHTH_NOTE_TICKS);
});

test('tempo accepts any positive value without capping it', () => {
  assert.equal(safeTempo(1), 1);
  assert.equal(safeTempo(347), 347);
  assert.equal(safeTempo(0), 120);
  assert.equal(safeTempo(Number.NaN), 120);
  assert.equal(ticksToSeconds(EIGHTH_NOTE_TICKS, 300), .1);
});

test('recording count-in travels through the bar before the loop start', () => {
  const context = { currentTime: 10 } as unknown as AudioContext;
  const recorder = new DeckRecorder(() => context, () => 120);
  assert.equal(recorder.begin('lead', 'overdub', 4), true);
  assert.equal(recorder.countInPositionTick(), 5760);
  context.currentTime = 11;
  assert.equal(recorder.countInPositionTick(), 6720);
  context.currentTime = 12;
  assert.equal(recorder.countInPositionTick(), null);
});

test('shared transport preserves its platter position while paused', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { setInterval: () => 1, clearInterval: () => {} };
  const context = { currentTime: 0 } as unknown as AudioContext;
  const transport = new SharedDeckTransport(
    () => context,
    () => 120,
    { A: new SingleDeck(), B: new SingleDeck() },
    { drum: () => {}, note: () => {}, chord: () => {} },
  );
  assert.equal(transport.start(0), true);
  context.currentTime = 1;
  transport.stop();
  assert.equal(transport.position().tick, 960);
  context.currentTime = 2;
  assert.equal(transport.position().tick, 960);
  if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = previousWindow;
});

test('recording commit catches up a first-beat event after the lookahead passed it exactly once', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let runScheduler = () => {};
  (globalThis as { window?: unknown }).window = { setInterval: (callback: () => void) => { runScheduler = callback; return 1; }, clearInterval: () => {} };
  const context = { currentTime: 0 } as unknown as AudioContext;
  const deck = new SingleDeck();
  deck.addNote('lead', 55, 0, EIGHTH_NOTE_TICKS, 1, 1, 'existing');
  const played: Array<{ pitch: number; at: number }> = [];
  const transport = new SharedDeckTransport(
    () => context,
    () => 120,
    { A: deck, B: new SingleDeck() },
    { drum: () => {}, note: (_instrument, pitch, _velocity, _duration, at) => played.push({ pitch, at }), chord: () => {} },
  );

  try {
    transport.start(0);
    context.currentTime = 7.91;
    runScheduler();
    const committed = deck.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'recorded');
    context.currentTime = 8.01;
    assert.equal(transport.catchUpCommittedEvents('A', 'lead', [committed]), 1);
    assert.equal(transport.catchUpCommittedEvents('A', 'lead', [committed]), 0);
    runScheduler();
    assert.equal(played.filter(({ pitch }) => pitch === 60).length, 1);
    assert.ok(played.find(({ pitch }) => pitch === 60)!.at > context.currentTime);
    assert.equal(played.filter(({ pitch, at }) => pitch === 55 && at === 8).length, 1);
  } finally {
    transport.stop();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('recording commit does not catch up an event before the scheduler reaches its loop', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let runScheduler = () => {};
  (globalThis as { window?: unknown }).window = { setInterval: (callback: () => void) => { runScheduler = callback; return 1; }, clearInterval: () => {} };
  const context = { currentTime: 0 } as unknown as AudioContext;
  const deck = new SingleDeck();
  const played: number[] = [];
  const transport = new SharedDeckTransport(
    () => context,
    () => 120,
    { A: deck, B: new SingleDeck() },
    { drum: () => {}, note: (_instrument, pitch) => played.push(pitch), chord: () => {} },
  );

  try {
    transport.start(0);
    context.currentTime = 7.5;
    const committed = deck.addNote('lead', 60, 0, EIGHTH_NOTE_TICKS, 1, 1, 'recorded-early');
    assert.equal(transport.catchUpCommittedEvents('A', 'lead', [committed]), 0);
    context.currentTime = 7.91;
    runScheduler();
    assert.deepEqual(played, [60]);
  } finally {
    transport.stop();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('recording commit catch-up uses the normal drum, bass, and chord playback paths', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  let runScheduler = () => {};
  (globalThis as { window?: unknown }).window = { setInterval: (callback: () => void) => { runScheduler = callback; return 1; }, clearInterval: () => {} };
  const context = { currentTime: 0 } as unknown as AudioContext;
  const deck = new SingleDeck();
  const played: string[] = [];
  const transport = new SharedDeckTransport(
    () => context,
    () => 120,
    { A: deck, B: new SingleDeck() },
    {
      drum: (pad) => played.push(`drum:${pad}`),
      note: (instrument, pitch) => played.push(`${instrument}:${pitch}`),
      chord: (pitches) => played.push(`chord:${pitches.join(',')}`),
    },
  );

  try {
    transport.start(0);
    context.currentTime = 7.91;
    runScheduler();
    const drum = deck.addDrum(2, 0, 1, 'recorded-drum');
    const bass = deck.addNote('bass', 36, 0, EIGHTH_NOTE_TICKS, 1, 1, 'recorded-bass');
    const chord = deck.addChord('Dm', [50, 53, 57], 0, EIGHTH_NOTE_TICKS, 'root', 1, 'recorded-chord');
    context.currentTime = 8.01;
    assert.equal(transport.catchUpCommittedEvents('A', 'drums', [drum]), 1);
    assert.equal(transport.catchUpCommittedEvents('A', 'bass', [bass]), 1);
    assert.equal(transport.catchUpCommittedEvents('A', 'chords', [chord]), 1);
    assert.deepEqual(played, ['drum:2', 'bass:36', 'chord:50,53,57']);
  } finally {
    transport.stop();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('recording supports sixteenth-note and unquantized grids', () => {
  assert.equal(quantizedStart(190, 120), 240);
  assert.equal(quantizedDuration(190, 260, 120), 120);
  assert.equal(quantizedStart(190, 1), 190);
  assert.equal(quantizedDuration(190, 260, 1), 70);

  const context = { currentTime: 0 } as unknown as AudioContext;
  const recorder = new DeckRecorder(() => context, () => 120);
  recorder.setQuantization('1/16');
  assert.equal(recorder.begin('drums'), true);
  recorder.recordDrum(0, 1, .2);
  const take = recorder.buildTake();
  assert.equal(take?.quantizeTicks, 120);
  assert.equal(take?.events[0].startTick, 240);
});

test('bass overdubs at one quantized tick use last-write-wins while lead stays polyphonic', () => {
  const deck = new SingleDeck();
  deck.addNote('bass', 36, 8, EIGHTH_NOTE_TICKS);
  deck.addNote('bass', 43, 9, EIGHTH_NOTE_TICKS);
  deck.addNote('lead', 60, 8, EIGHTH_NOTE_TICKS);
  deck.addNote('lead', 64, 9, EIGHTH_NOTE_TICKS);

  const snapshot = deck.snapshot();
  assert.equal(snapshot.events.bass.length, 1);
  assert.equal(snapshot.events.bass[0].pitch, 43);
  assert.equal(snapshot.events.lead.length, 2);
});

test('chord events retain optional velocity for playback', () => {
  const deck = new SingleDeck();
  const event = deck.addChord('C', [48, 52, 55], 0, EIGHTH_NOTE_TICKS, 'root', 1, 'chord-quiet', .5);
  assert.equal(event.velocity, .5);
  assert.equal(deck.snapshot().events.chords[0].velocity, .5);
});

test('transport dispatches only the last legacy bass duplicate at one tick', () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const fakeWindow = { setInterval: () => 1, clearInterval: () => {} };
  (globalThis as { window?: unknown }).window = fakeWindow;
  const context = { currentTime: 0 } as unknown as AudioContext;
  const bassPitches: number[] = [];
  const legacyDeck = {
    soundProfiles: () => ({}),
    eventsAt: () => ({
      drums: [],
      bass: [
        { id: 'old', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 36, velocity: 1 },
        { id: 'new', startTick: 0, durationTicks: EIGHTH_NOTE_TICKS, pitch: 41, velocity: 1 },
      ],
      chords: [],
      lead: [],
    }),
  };
  const transport = new DeckTransport(
    () => context,
    () => 120,
    legacyDeck as unknown as SingleDeck,
    {
      drum: () => {},
      note: (_instrument, pitch) => bassPitches.push(pitch),
      chord: () => {},
      stop: () => {},
    },
  );

  try {
    assert.equal(transport.start(0), true);
    transport.stop();
    assert.deepEqual(bassPitches, [41]);
  } finally {
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test('four-note chords count four musical voices, not twelve oscillators', () => {
  const chordGroups = [{ voiceCount: 4, oscillatorCount: 12 }];

  assert.equal(countMusicalVoices(chordGroups), 4);
  assert.ok(countMusicalVoices(chordGroups) <= 8);
});

test('voice limits count each lane separately', () => {
  const groups = [
    { lane: 'live' as const, voiceCount: 1, state: 'active' as const },
    { lane: 'live' as const, voiceCount: 1, state: 'releasing' as const },
    { lane: 'deck' as const, voiceCount: 1, state: 'active' as const },
  ];

  assert.equal(countMusicalVoicesInLane(groups, 'live'), 1);
  assert.equal(countMusicalVoicesInLane(groups, 'deck'), 1);
});

test('releasing groups remain tracked and chokeable only within their lane', () => {
  const groups = [
    { at: 0, lane: 'live' as const, state: 'active' as const, voiceCount: 1 },
    { at: 0, lane: 'deck' as const, state: 'active' as const, voiceCount: 1 },
  ];
  groups[0].state = voiceGroupReleaseState(groups[0].state);

  assert.equal(voiceGroupIsTracked(groups[0].state), true);
  assert.equal(countMusicalVoicesInLane(groups, 'live'), 0);
  assert.equal(canChokeVoiceGroup(groups[0], 'live', .1), true);
  assert.equal(canChokeVoiceGroup(groups[0], 'deck', .1), false);

  groups[0].state = voiceGroupStopState(groups[0].state);
  assert.equal(voiceGroupIsTracked(groups[0].state), false);
  assert.deepEqual(groups.filter((group) => voiceGroupIsTracked(group.state)), [groups[1]]);
});

test('release timing clamps invalid or too-short fades', () => {
  assert.equal(safeReleaseDuration(.001), .012);
  assert.equal(safeReleaseDuration(Number.NaN), .012);
  assert.equal(releaseEndTime(2, .5), 2.5);
});

test('bass release diagnostic aligns a rolling buffer to the scheduled release', () => {
  const samples = new Float32Array(100);
  samples[50] = .4;
  samples[51] = -.2;

  const analysis = analyseBassReleaseWindow(samples, 1000, 1, .95, 4);

  assert.equal(analysis.windowStartAudioTime, .9);
  assert.equal(analysis.windowEndAudioTime, 1);
  assert.equal(analysis.releaseFrameIndex, 50);
  assert.ok(Math.abs(analysis.releaseFrameTime! - .95) < .000001);
  assert.ok(Math.abs(analysis.releasePeak - .4) < .000001);
  assert.ok(Math.abs(analysis.releaseMaxAdjacentSampleDelta - .6) < .000001);

  const outside = analyseBassReleaseWindow(samples, 1000, 1, .5, 4);
  assert.equal(outside.releaseFrameIndex, null);
  assert.equal(outside.releaseFrameTime, null);
  assert.equal(outside.releaseMaxAdjacentSampleDelta, 0);
});

test('finite bass final VCA releases at the gate boundary, including short articulation', () => {
  const normal = bassVcaSchedule(.25, .005, .5);
  assert.equal(normal.onsetDuration, .005);
  assert.equal(normal.releaseAt, .25);
  assert.equal(normal.releaseEnd, .75);

  const short = bassVcaSchedule(.25 * .05, .005, .5);
  assert.equal(short.releaseAt, .0125);
  assert.equal(short.onsetDuration, .005);
  assert.equal(short.releaseEnd, .5125);

  const shorterThanOnset = bassVcaSchedule(.001, .005, .5);
  assert.equal(shorterThanOnset.releaseAt, .005);
  assert.equal(shorterThanOnset.onsetDuration, .005);
});

test('bass final VCA uses native linear ramps with continuous endpoints', () => {
  assert.equal(linearFadeValue(0, 1, 0, .005), 0);
  assert.equal(linearFadeValue(0, 1, .005, .005), 1);
  assert.equal(linearFadeValue(1, 0, .25, .5), .5);
});

test('bass retrigger equal-duration linear crossfade stays at the original level', () => {
  for (const progress of [0, .1, .25, .5, .75, .9, 1]) {
    const oldVoice = linearFadeValue(1, 0, progress, 1);
    const newVoice = linearFadeValue(0, 1, progress, 1);
    assert.ok(Math.abs(oldVoice + newVoice - 1) < .000001);
  }
});

test('bass VCA controller starts a normal release from the scheduled sustain value', () => {
  const controller = new BassVcaController(0);
  const onset = controller.schedule(1, 0, .005);
  assert.equal(onset.from, 0);
  assert.equal(controller.valueAt(.005), 1);

  const release = controller.schedule(0, .25, .5);
  assert.equal(release.from, 1);
  assert.equal(controller.valueAt(.5), .5);
  assert.equal(controller.valueAt(.75), 0);
});

test('bass VCA controller preserves the value when release interrupts onset', () => {
  const controller = new BassVcaController(0);
  controller.schedule(1, 0, .005);
  const release = controller.schedule(0, .0025, .5);

  assert.ok(Math.abs(release.from - linearFadeValue(0, 1, .0025, .005)) < .000001);
  assert.equal(controller.valueAt(.0025), release.from);
});

test('bass VCA controller replaces an existing release when choked', () => {
  const controller = new BassVcaController(0);
  controller.schedule(1, 0, .005);
  controller.schedule(0, .25, .5);
  const choke = controller.schedule(0, .27, .02);
  const expected = linearFadeValue(1, 0, .02, .5);

  assert.ok(Math.abs(choke.from - expected) < .000001);
  assert.ok(Math.abs(controller.valueAt(.29)) < 0.000001);
});

test('live bass automation moves an immediate transition two render quanta forward', () => {
  const timing = bassVcaAutomationTiming(10, 10, 44100, true);

  assert.equal(timing.requestedAt, 10);
  assert.ok(Math.abs(timing.scheduledAt - (10 + 256 / 44100)) < .000000001);
  assert.ok(Math.abs(timing.safetyOffsetSeconds - 256 / 44100) < .000000001);
});

test('live bass retrigger uses one safe time for old choke and new onset', () => {
  const timing = bassVcaRetriggerTiming(10, 10, 44100, true);
  assert.equal(timing.chokeAt, timing.onsetAt);
  assert.ok(Math.abs(timing.onsetAt - (10 + 256 / 44100)) < .000000001);

  const deckTiming = bassVcaRetriggerTiming(10.25, 10, 44100, false);
  assert.equal(deckTiming.chokeAt, 10.25);
  assert.equal(deckTiming.onsetAt, 10.25);
  assert.equal(deckTiming.safetyOffsetSeconds, 0);
});

test('future deck bass automation is not shifted', () => {
  const timing = bassVcaAutomationTiming(10.25, 10, 44100, false);

  assert.equal(timing.requestedAt, 10.25);
  assert.equal(timing.scheduledAt, 10.25);
  assert.equal(timing.safetyOffsetSeconds, 0);
});

test('bass VCA controller uses the safety-shifted transition time', () => {
  const now = 10;
  const timing = bassVcaAutomationTiming(now, now, 44100, true);
  const controller = new BassVcaController(0);
  controller.schedule(1, now - .1, .005);
  const release = controller.schedule(0, timing.scheduledAt, .5);

  assert.equal(release.start, timing.scheduledAt);
  assert.equal(controller.valueAt(timing.requestedAt), 1);
  assert.equal(controller.valueAt(timing.scheduledAt), 1);
});

test('finite bass VCA scheduling releases after its gate, including a short deck articulation', () => {
  const controller = new BassVcaController(0);
  controller.schedule(1, 10, .005);
  const release = controller.schedule(0, 10.25, .5);

  assert.equal(release.start, 10.25);
  assert.equal(release.from, 1);
  assert.equal(release.end, 10.75);

  const short = new BassVcaController(0);
  short.schedule(1, 10, .005);
  const shortRelease = short.schedule(0, 10.0125, .5);
  assert.equal(shortRelease.start, 10.0125);
  assert.equal(shortRelease.from, 1);
});

test('bass note lifecycle treats held notes and release tails as audible only before releaseEnd', () => {
  assert.equal(bassLaneNoteIsAudibleAt({ gateEnd: null }, 100), true);
  assert.equal(bassLaneNoteIsAudibleAt({ gateEnd: null, releaseEnd: 100 }, 99.999), true);
  assert.equal(bassLaneNoteIsAudibleAt({ gateEnd: null, releaseEnd: 100 }, 100), false);
  assert.equal(bassLaneNoteIsAudibleAt({ gateEnd: .25, releaseEnd: .75 }, .5), true);
  assert.equal(bassLaneNoteIsAudibleAt({ gateEnd: .25, releaseEnd: .75 }, .75), false);
});

test('ADSR release starts from the scheduled attack, decay, or sustain level', () => {
  const attackLevel = adsrLevelAt(.005, .01, .1, 1, .5);
  const decayLevel = adsrLevelAt(.05, .01, .1, 1, .5);
  const sustainLevel = adsrLevelAt(.2, .01, .1, 1, .5);

  assert.ok(attackLevel > .0001 && attackLevel < 1);
  assert.ok(decayLevel > .5 && decayLevel < 1);
  assert.equal(sustainLevel, .5);
});

test('a 250 ms Sub gate uses its finite-note decay schedule without a release jump', () => {
  const peak = .7;
  const sustain = peak * .65;
  const gate = .25;
  const attack = .001;
  const scheduledDecay = Math.min(.48, gate - attack);
  const releaseAt = adsrLevelAt(gate, attack, scheduledDecay, peak, sustain);
  const justBeforeRelease = adsrLevelAt(gate - .000001, attack, scheduledDecay, peak, sustain);

  assert.equal(releaseAt, sustain);
  assert.ok(justBeforeRelease > sustain);
  assert.ok(Math.abs(releaseAt - justBeforeRelease) < .00001);
});

test('eight bass eighth notes keep 250 ms gates at 120 BPM', () => {
  const gates = Array.from({ length: 8 }, () => ticksToSeconds(EIGHTH_NOTE_TICKS, 120));

  assert.deepEqual(gates, Array(8).fill(.25));
});

test('recording keeps a short tap as articulation inside a quantized event', () => {
  const context = { currentTime: 0 } as unknown as AudioContext;
  const deck = new SingleDeck();
  const recorder = new DeckRecorder(() => context, () => 120, deck);

  assert.equal(recorder.begin('lead'), true);
  recorder.recordNoteOn('lead', 'tap', 60, 1, 0);
  recorder.recordNoteOff('lead', 'tap', .1);
  const take = recorder.buildTake();
  assert.ok(take);
  assert.equal(deck.snapshot().events.lead.length, 0);
  const event = take!.events[0] as { durationTicks: number; articulation?: number };
  assert.equal(event.durationTicks, EIGHTH_NOTE_TICKS);
  assert.equal(event.articulation, .4);
  assert.equal(playbackDurationSeconds(event.durationTicks, event.articulation, 120), .1);
  assert.equal(playbackDurationSeconds(event.durationTicks, undefined, 120), .25);
});

test('missing and out-of-range articulation values stay safe', () => {
  assert.equal(clampArticulation(undefined), 1);
  assert.equal(clampArticulation(0), .05);
  assert.equal(clampArticulation(2), 1);

  const deck = new SingleDeck();
  const event = deck.addChord('C', [48, 52, 55, 60], 0, EIGHTH_NOTE_TICKS, 'root', .4);
  assert.equal(event.articulation, .4);
  assert.equal(deck.snapshot().events.chords[0].articulation, .4);
});

test('clearing a deck also clears its sound profiles', () => {
  const deck = new SingleDeck();
  deck.addNote('bass', 36, 0, EIGHTH_NOTE_TICKS);
  deck.setSoundProfile('bass', {
    presetId: 'bass-0',
    controls: { tone: .5 },
    parameters: { releaseMs: 500 },
    volume: .6,
  });

  deck.clear();

  assert.equal(deck.eventCount(), 0);
  assert.deepEqual(deck.soundProfiles(), {});
});
