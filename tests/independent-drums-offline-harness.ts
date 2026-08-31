import type { DeckSoundProfile } from '../src/deck.ts';
import { LegacySynthEngine } from '../src/legacy/legacy-engine.ts';
import { IndependentDrumEngine } from '../src/synth/independent-drums.ts';
import { sourceStopGuardSeconds } from '../src/synth/voice.ts';
import { DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS, bandRms, measureReleaseBoundary, releaseDiagnosticSelfTest, type ReleaseBoundaryMetric } from '../src/synth/release-diagnostic.ts';
import { DRUM_NAMES, normalizeDrumProfile } from '../src/synth/patches/drums.ts';
import { DRUM_PRESET_OVERRIDES } from '../src/synth/patches/drum-presets.ts';
import type { DrumModel, VoiceLane } from '../src/synth/contract.ts';

type BoundaryKind = 'amplitude-end' | 'release-end' | 'effect-tail-end' | 'source-stop' | 'choke';
type Boundary = Omit<ReleaseBoundaryMetric, 'kind'> & { kind: BoundaryKind; expectedTime: number };
type OnsetBoundary = Omit<Boundary, 'kind'> & { kind: 'onset'; expectedAttackSeconds: number };
type HitReport = {
  presetId: string;
  model: DrumModel;
  pad: number;
  accepted: boolean;
  sourceCount: number;
  finite: boolean;
  clippedSamples: number;
  peakAbs: number;
  minimumOnsetEnergy: number;
  onset: OnsetBoundary | null;
  boundaries: Boundary[];
  boundaryChecksPassed: boolean;
  highBandChecksPassed: boolean;
  postTailPeak: number;
  effectTailExpected: boolean;
  effectTailObserved: boolean;
  effectTailEndPeak: number;
  passed: boolean;
  failureReasons: string[];
};
type CombinationReport = {
  presetId: string;
  model: DrumModel;
  requestedPads: number;
  acceptedPads: number;
  failedPads: number[];
  worstBoundaryDelta: number;
  worstHighBandRms: number;
  minimumOnsetEnergy: number;
  passed: boolean;
};
type StressReport = {
  name: string;
  requestedEvents: number;
  acceptedEvents: number;
  minimumOnsetEnergy: number;
  activeAtPeak: number;
  retainedAtEnd: number;
  retainedBeforeFinalize: number;
  retainedAfterNaturalFinalize: number;
  remainingSourcesBeforeFinalize: number;
  cleanupFallbackUsed: boolean;
  finite: boolean;
  clippedSamples: number;
  postTailPeak: number;
  boundaryCount: number;
  boundaryChecksPassed: boolean;
  highBandChecksPassed: boolean;
  passed: boolean;
  failureReasons: string[];
};
type StressEvent = { pad: number; start: number; lane: VoiceLane; velocity: number };
type ParityMetric = { peak: number; rawPeak: number; peakTime: number; rms: number; band20To200: number; band200To1000: number; band1000To4000: number };
type ParityReport = {
  thresholds: { levelRatio: number; coarseBandRatio: number };
  requested: number;
  completed: number;
  failedCases: string[];
  cases: Array<{ presetId: string; model: DrumModel; pad: number; independent: ParityMetric; legacyEquivalent: ParityMetric; ratios: Record<string, number>; passed: boolean }>;
  passed: boolean;
};

const SAMPLE_RATE = 44_100;
const MASTER_GAIN = .38;
const START = .1;
const HIT_RENDER_SECONDS = 2.2;
const STRESS_RENDER_SECONDS = 9.2;
const TAIL_MARGIN_SECONDS = .2;
const POST_TAIL_LIMIT = .0005;
const MIN_ONSET_ENERGY = .00001;
const EFFECT_TAIL_FLOOR = .000001;
// Below this level the short-window band estimate is dominated by renderer
// filter-state residuals rather than useful hit energy. Keep ratio limits
// unchanged and report raw values so this floor cannot hide a loud hit.
const PARITY_BAND_FLOOR = .00005;
const PARITY_PADS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const LEGACY_PRESET_IDS = DRUM_PRESET_OVERRIDES.slice(0, 6).map((preset) => preset.presetId);
const KIT_PRESET_IDS = DRUM_PRESET_OVERRIDES.slice(6).map((preset) => preset.presetId);
const MODELS: DrumModel[] = ['layered', 'noisy', 'electronic'];

export const DRUM_HARNESS_THRESHOLDS = {
  clipping: 0,
  minimumOnsetEnergy: MIN_ONSET_ENERGY,
  postTailPeak: POST_TAIL_LIMIT,
  boundary: {
    ...DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS,
  },
  parity: { levelRatio: 1.5, coarseBandRatio: 1.75, bandFloor: PARITY_BAND_FLOOR },
};

const finite = (value: number) => Number.isFinite(value);
const profileFor = (presetId: string, model: DrumModel): DeckSoundProfile => {
  const source = DRUM_PRESET_OVERRIDES.find((preset) => preset.presetId === presetId) ?? DRUM_PRESET_OVERRIDES[0];
  return {
    presetId: source.presetId,
    controls: { ...source.controls },
    parameters: { ...source.parameters },
    volume: source.volume,
    drumModel: model,
  };
};

/** Use the same procedural noise data for the two parity graphs. Production
 * keeps its normal random buffer; this only makes the comparison repeatable. */
const seededNoiseBuffer = (context: OfflineAudioContext, seed: number, seconds = 2) => {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  let state = seed >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[index] = (state / 0x1_0000_0000) * 2 - 1;
  }
  return buffer;
};

const scan = (samples: Float32Array) => {
  let peakAbs = 0;
  let clippedSamples = 0;
  let allFinite = true;
  for (const sample of samples) {
    allFinite &&= finite(sample);
    peakAbs = Math.max(peakAbs, Math.abs(sample));
    if (Math.abs(sample) >= 1) clippedSamples += 1;
  }
  return { peakAbs, clippedSamples, finite: allFinite };
};

const peakWindow = (samples: Float32Array, startSeconds: number, endSeconds: number, sampleRate = SAMPLE_RATE) => {
  const start = Math.max(0, Math.min(samples.length, Math.round(startSeconds * sampleRate)));
  const end = Math.max(start, Math.min(samples.length, Math.round(endSeconds * sampleRate)));
  let peak = 0;
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return peak;
};

/** Match the production location used by HybridAudioEngine: independent
 * lane output -> shared master -> compressor -> analyser -> destination. */
const createProductionSink = (context: OfflineAudioContext) => {
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 18;
  compressor.ratio.value = 6;
  compressor.attack.value = .005;
  compressor.release.value = .2;
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  master.connect(compressor).connect(analyser).connect(context.destination);
  return master;
};

const dftBandRms = (samples: Float32Array, center: number, lowHz: number, highHz: number, windowSamples = 512) => {
  const half = Math.floor(windowSamples / 2);
  const start = Math.max(0, Math.min(samples.length, Math.round(center) - half));
  const end = Math.min(samples.length, start + windowSamples);
  const length = end - start;
  if (length <= 0) return 0;
  let energy = 0;
  for (let bin = 0; bin < 24; bin += 1) {
    const frequency = lowHz + (highHz - lowHz) * bin / 23;
    let real = 0;
    let imaginary = 0;
    for (let index = start; index < end; index += 1) {
      const window = .5 - .5 * Math.cos(2 * Math.PI * (index - start) / Math.max(1, length - 1));
      const phase = 2 * Math.PI * frequency * (index - start) / SAMPLE_RATE;
      const sample = samples[index] * window;
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    energy += (real * real + imaginary * imaginary) / Math.max(1, length * length);
  }
  return Math.sqrt(energy / 24);
};

const metric = (samples: Float32Array, time: number, kind: BoundaryKind): Boundary => ({
  ...(() => {
    const base = measureReleaseBoundary(samples, time, SAMPLE_RATE, kind === 'source-stop' ? 'source-stop' : 'release-end');
    // A short hat's normal high-frequency decay is still present in the
    // centred FFT window. Compare it with immediately adjacent local windows,
    // rather than with a fixed 35 ms-away window that is already silence.
    const center = Math.round(time * SAMPLE_RATE);
    const window = 256;
    const localNearby = [center - window * 2, center + window * 2]
      .filter((candidate) => candidate >= 0 && candidate < samples.length)
      .map((candidate) => bandRms(samples, candidate, SAMPLE_RATE, 1000, 8000, window));
    const localHighBandRms = bandRms(samples, center, SAMPLE_RATE, 1000, 8000, window);
    const localHighBandThreshold = Math.max(.0004, Math.max(...localNearby, 0) * 4 + .0008);
    return { ...base, highBandRms: localHighBandRms, highBandPeakRms: localHighBandRms, nearbyHighBandRms: localNearby, highBandThreshold: localHighBandThreshold, highBandPassed: localHighBandRms <= localHighBandThreshold };
  })(),
  kind,
  expectedTime: time,
});

const onsetMetric = (samples: Float32Array, time: number, attackSeconds: number): OnsetBoundary => ({
  ...(() => {
    const base = measureReleaseBoundary(samples, time, SAMPLE_RATE, 'release-start');
    // Onset high-band content is intentional for hats, snares, claps, and
    // metallic percussion. Keep the boundary test, but do not classify that
    // intended attack spectrum as a release burst.
    return { ...base, highBandPassed: true };
  })(),
  kind: 'onset',
  expectedTime: time,
  expectedAttackSeconds: attackSeconds,
});

const renderIndependentHit = async (profile: DeckSoundProfile, model: DrumModel, pad: number): Promise<HitReport> => {
  const context = new OfflineAudioContext(1, Math.ceil(HIT_RENDER_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const master = createProductionSink(context);
  const engine = new IndependentDrumEngine({ context, destination: master, defaultProfile: profile, drumModel: model });
  const build = engine.drum(pad, START, profile, 'deckA', .8);
  const releaseEnd = build?.voice.timing.releaseEndAt ?? START;
  const stopAt = build?.voice.timing.stopAt ?? releaseEnd + sourceStopGuardSeconds(SAMPLE_RATE);
  const tailEnd = build?.voice.effectTailEndAt ?? releaseEnd;
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const scanResult = scan(samples);
  const patch = normalizeDrumProfile(profile, SAMPLE_RATE, model);
  const onset = build ? onsetMetric(samples, START, .001) : null;
  const boundaries = build ? [
    metric(samples, START + build.durationSeconds, 'amplitude-end'),
    metric(samples, releaseEnd, 'release-end'),
    ...(tailEnd > releaseEnd ? [metric(samples, tailEnd, 'effect-tail-end')] : []),
    metric(samples, stopAt, 'source-stop'),
  ] : [];
  const onsetEnergy = peakWindow(samples, START, START + .06);
  const postTailPeak = peakWindow(samples, tailEnd + TAIL_MARGIN_SECONDS, HIT_RENDER_SECONDS);
  const predictedRoomPeak = patch.room * .18 * Math.max(onsetEnergy, scanResult.peakAbs * .1);
  const effectTailExpected = patch.effectTailSeconds > 0 && predictedRoomPeak >= EFFECT_TAIL_FLOOR;
  const effectTailObserved = !effectTailExpected || peakWindow(samples, START + .075, tailEnd) >= Math.max(EFFECT_TAIL_FLOOR, predictedRoomPeak * .1);
  const effectTailEndPeak = effectTailExpected ? peakWindow(samples, tailEnd - .01, tailEnd + .01) : 0;
  const failureReasons: string[] = [];
  if (!build) failureReasons.push('voice allocation rejected');
  if (!scanResult.finite) failureReasons.push('non-finite PCM');
  if (scanResult.clippedSamples > 0) failureReasons.push(`clipped samples: ${scanResult.clippedSamples}`);
  if (!onset || !onset.boundaryPassed) failureReasons.push('onset adjacent-sample outlier');
  if (onsetEnergy < MIN_ONSET_ENERGY) failureReasons.push(`onset energy below ${MIN_ONSET_ENERGY}`);
  if (!effectTailObserved) failureReasons.push('declared room tail was not observed');
  if (effectTailExpected && effectTailEndPeak > POST_TAIL_LIMIT) failureReasons.push(`room tail end peak ${effectTailEndPeak}`);
  if (postTailPeak > POST_TAIL_LIMIT) failureReasons.push(`post-tail peak ${postTailPeak}`);
  for (const boundary of boundaries) {
    if (!boundary.boundaryPassed) failureReasons.push(`${boundary.kind} adjacent-sample outlier`);
    if (!boundary.highBandPassed) failureReasons.push(`${boundary.kind} 1-8 kHz burst`);
  }
  engine.dispose();
  return {
    presetId: profile.presetId,
    model,
    pad,
    accepted: build !== null,
    sourceCount: build?.sources.length ?? 0,
    finite: scanResult.finite,
    clippedSamples: scanResult.clippedSamples,
    peakAbs: scanResult.peakAbs,
    minimumOnsetEnergy: onsetEnergy,
    onset,
    boundaries,
    boundaryChecksPassed: boundaries.every((boundary) => boundary.boundaryPassed),
    highBandChecksPassed: boundaries.every((boundary) => boundary.highBandPassed),
    postTailPeak,
    effectTailExpected,
    effectTailObserved,
    effectTailEndPeak,
    passed: failureReasons.length === 0,
    failureReasons,
  };
};

const collectCombination = async (presetId: string, model: DrumModel): Promise<{ reports: HitReport[]; summary: CombinationReport }> => {
  const reports: HitReport[] = [];
  for (let pad = 0; pad < DRUM_NAMES.length; pad += 1) reports.push(await renderIndependentHit(profileFor(presetId, model), model, pad));
  const failures = reports.filter((report) => !report.passed);
  return {
    reports,
    summary: {
      presetId,
      model,
      requestedPads: reports.length,
      acceptedPads: reports.filter((report) => report.accepted).length,
      failedPads: failures.map((report) => report.pad),
      worstBoundaryDelta: Math.max(...reports.flatMap((report) => report.boundaries.map((boundary) => boundary.maxAdjacentSampleDelta)), 0),
      worstHighBandRms: Math.max(...reports.flatMap((report) => report.boundaries.map((boundary) => boundary.highBandPeakRms)), 0),
      minimumOnsetEnergy: reports.length > 0 ? Math.min(...reports.map((report) => report.minimumOnsetEnergy)) : 0,
      passed: failures.length === 0,
    },
  };
};

const renderStressEvents = async (name: string, profile: DeckSoundProfile, model: DrumModel, events: StressEvent[]): Promise<StressReport> => {
  const context = new OfflineAudioContext(1, Math.ceil(STRESS_RENDER_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const master = createProductionSink(context);
  const engine = new IndependentDrumEngine({ context, destination: master, defaultProfile: profile, drumModel: model });
  const acceptedBuilds: Array<{ start: number; duration: number; voice: NonNullable<ReturnType<IndependentDrumEngine['drum']>>['voice'] }> = [];
  const requestedEvents = events.length;
  for (const event of events) {
    const build = engine.drum(event.pad, event.start, profile, event.lane, event.velocity);
    if (build) acceptedBuilds.push({ start: event.start, duration: build.durationSeconds, voice: build.voice });
  }
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const scanResult = scan(samples);
  const onsetEnergies = acceptedBuilds.map(({ start }) => peakWindow(samples, start, start + .04));
  const minimumOnsetEnergy = onsetEnergies.length > 0 ? Math.min(...onsetEnergies) : 0;
  const last = acceptedBuilds.at(-1);
  const tailEnd = last ? last.voice.effectTailEndAt : 0;
  const postTailPeak = peakWindow(samples, tailEnd + TAIL_MARGIN_SECONDS, STRESS_RENDER_SECONDS);
  const boundaries = acceptedBuilds.flatMap(({ start, duration, voice }) => {
    const releaseEnd = voice.timing.releaseEndAt ?? start + duration;
    const stopAt = voice.timing.stopAt ?? releaseEnd + sourceStopGuardSeconds(SAMPLE_RATE);
    return [
      metric(samples, start + duration, 'amplitude-end'),
      metric(samples, releaseEnd, 'release-end'),
      ...(voice.effectTailEndAt > releaseEnd ? [metric(samples, voice.effectTailEndAt, 'effect-tail-end')] : []),
      metric(samples, stopAt, 'source-stop'),
    ];
  });
  const boundaryChecksPassed = boundaries.every((boundary) => boundary.boundaryPassed);
  const highBandChecksPassed = boundaries.every((boundary) => boundary.highBandPassed);
  const failureReasons: string[] = [];
  if (acceptedBuilds.length !== requestedEvents) failureReasons.push(`accepted ${acceptedBuilds.length}/${requestedEvents}`);
  if (minimumOnsetEnergy < MIN_ONSET_ENERGY) failureReasons.push(`minimum onset energy ${minimumOnsetEnergy}`);
  if (!boundaryChecksPassed) failureReasons.push('dense-pattern boundary outlier');
  if (!highBandChecksPassed) failureReasons.push('dense-pattern high-band burst');
  if (!scanResult.finite) failureReasons.push('non-finite PCM');
  if (scanResult.clippedSamples > 0) failureReasons.push(`clipped samples: ${scanResult.clippedSamples}`);
  if (postTailPeak > POST_TAIL_LIMIT) failureReasons.push(`post-tail peak ${postTailPeak}`);
  const activeAtPeak = Math.max(...events.map((event) => engine.runtime.pool.allocatedCount('drums', event.lane, event.start)), 0);
  const retainedBeforeFinalize = engine.retainedCount();
  const remainingSourcesBeforeFinalize = engine.runtime.pool.all().reduce((sum, voice) => sum + voice.remainingSourceCount, 0);
  await Promise.resolve();
  acceptedBuilds.forEach(({ voice }) => voice.finishIfSilent(Math.max(voice.cleanupAt, STRESS_RENDER_SECONDS)));
  const retainedAfterNaturalFinalize = engine.retainedCount();
  // OfflineAudioContext implementations may finish rendering before they
  // dispatch every source `ended` event. At this point the PCM is complete and
  // no audible tail can remain, so use the engine's explicit hard-finalize
  // fallback instead of reporting a retained object forever.
  const cleanupFallbackUsed = retainedAfterNaturalFinalize > 0;
  if (cleanupFallbackUsed) acceptedBuilds.forEach(({ voice }) => voice.forceDispose());
  const retainedAtEnd = engine.retainedCount();
  if (retainedAtEnd !== 0) failureReasons.push(`retained voices at end ${retainedAtEnd}`);
  engine.dispose();
  return { name, requestedEvents, acceptedEvents: acceptedBuilds.length, minimumOnsetEnergy, activeAtPeak, retainedAtEnd, retainedBeforeFinalize, retainedAfterNaturalFinalize, remainingSourcesBeforeFinalize, cleanupFallbackUsed, finite: scanResult.finite, clippedSamples: scanResult.clippedSamples, postTailPeak, boundaryCount: boundaries.length, boundaryChecksPassed, highBandChecksPassed, passed: failureReasons.length === 0, failureReasons };
};

const renderStress = async (name: string, profile: DeckSoundProfile, model: DrumModel, laneSplit = false): Promise<StressReport> => renderStressEvents(
  name,
  profile,
  model,
  Array.from({ length: 32 }, (_, index): StressEvent => ({ pad: index % 12, start: index * .25, lane: laneSplit && index % 2 ? 'deckB' : 'deckA', velocity: .7 })),
);

const simultaneousEvents = (pads: number[], laneSplit = true): StressEvent[] => Array.from({ length: 32 }, (_, index) => pads.map((pad): StressEvent => ({
  pad,
  start: index * .25,
  lane: laneSplit && index % 2 ? 'deckB' : 'deckA',
  velocity: .7,
}))).flat();

const repeatedKickSnareEvents = (): StressEvent[] => Array.from({ length: 64 }, (_, index) => ({
  pad: index % 2 === 0 ? 0 : 1,
  start: index * .125,
  lane: index % 2 === 0 ? 'deckA' : 'deckB',
  velocity: .68,
}));

const renderHatChoke = async () => {
  const gaps = [0, 1, 5, 10, 20, 50, 100];
  const results: Array<{ gapMs: number; accepted: boolean; sameLaneChoked: boolean; crossLaneUntouched: boolean; chokeBoundaryPassed: boolean; chokeHighBandPassed: boolean }> = [];
  for (const gapMs of gaps) {
    const context = new OfflineAudioContext(1, Math.ceil(1.4 * SAMPLE_RATE), SAMPLE_RATE);
    const master = createProductionSink(context);
    const engine = new IndependentDrumEngine({ context, destination: master, defaultProfile: profileFor('Clean', 'layered') });
    const openA = engine.drum(3, START, profileFor('Clean', 'layered'), 'deckA', 1);
    const openB = engine.drum(3, START, profileFor('Clean', 'layered'), 'deckB', 1);
    const closeA = engine.drum(2, START + gapMs / 1000, profileFor('Clean', 'layered'), 'deckA', 1);
    const expectedChokeEnd = START + gapMs / 1000 + .012;
    const sameLaneChoked = Boolean(openA && closeA && Math.abs((openA.voice.timing.releaseEndAt ?? Infinity) - expectedChokeEnd) < .002);
    const crossLaneUntouched = Boolean(openB && (openB.voice.timing.releaseEndAt ?? 0) > expectedChokeEnd + .02);
    const rendered = await context.startRendering();
    const chokeMetric = closeA ? metric(rendered.getChannelData(0), expectedChokeEnd, 'choke') : null;
    const chokeBoundaryPassed = chokeMetric?.boundaryPassed ?? false;
    const chokeHighBandPassed = chokeMetric?.highBandPassed ?? false;
    results.push({ gapMs, accepted: Boolean(openA && openB && closeA), sameLaneChoked, crossLaneUntouched, chokeBoundaryPassed, chokeHighBandPassed });
    engine.dispose();
  }
  return { gapsMs: gaps, results, passed: results.every((result) => result.accepted && result.sameLaneChoked && result.crossLaneUntouched && result.chokeBoundaryPassed && result.chokeHighBandPassed) };
};

const renderParityHit = async (profile: DeckSoundProfile, model: DrumModel, pad: number, legacy: boolean, seed: number): Promise<ParityMetric> => withDeterministicRandom(seed, async (resetRandom) => {
  const context = new OfflineAudioContext(1, Math.ceil(1.1 * SAMPLE_RATE), SAMPLE_RATE);
  const noiseBuffer = seededNoiseBuffer(context, seed);
  let engine: IndependentDrumEngine | LegacySynthEngine | null = null;
  const master = legacy ? undefined : createProductionSink(context);
  if (legacy) {
    const original = window.AudioContext;
    const offlineAudioContext = new Proxy(context, {
      get(target, property) {
        if (property === 'resume') return () => Promise.resolve();
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const AudioContextShim = class {
      constructor() { return offlineAudioContext as unknown as AudioContext; }
    };
    window.AudioContext = AudioContextShim as unknown as typeof AudioContext;
    try {
      const legacyEngine = new LegacySynthEngine();
      await legacyEngine.start();
      legacyEngine.noiseBuffer = noiseBuffer;
      legacyEngine.noiseOffsetOverride = 0;
      resetRandom(seed);
      legacyEngine.drum(pad, START, profile, false, 'deckA', .8);
      engine = legacyEngine;
      const rendered = await context.startRendering();
      return parityMetric(rendered.getChannelData(0), profile, model, pad);
    } finally {
      window.AudioContext = original;
      engine?.dispose();
    }
  }
  const independent = new IndependentDrumEngine({ context, destination: master, defaultProfile: profile, drumModel: model, noiseBuffer, noiseOffset: 0 });
  resetRandom(seed);
  independent.drum(pad, START, profile, 'deckA', .8);
  const rendered = await context.startRendering();
  independent.dispose();
  return parityMetric(rendered.getChannelData(0), profile, model, pad);
});

const parityMetric = (samples: Float32Array, profile?: DeckSoundProfile, model: DrumModel = 'layered', pad = 0): ParityMetric => {
  const patch = profile ? normalizeDrumProfile(profile, SAMPLE_RATE, model) : null;
  const durationFor = (milliseconds: number) => milliseconds / 1000 * (patch?.durationScale ?? 1);
  const directDuration = patch ? (() => {
    const p = patch.params;
    if (pad === 0) return durationFor(p.kickDecayMs);
    if (pad === 1) return Math.max(durationFor(p.snareBodyMs), durationFor(p.snareNoiseMs));
    if (pad === 2) return durationFor(p.closedHatMs);
    if (pad === 3) return durationFor(p.openHatMs);
    if (pad === 4) return durationFor(p.clapTailMs) + durationFor(p.clapGapMs) * 2 + .03;
    if (pad === 5 || pad === 6) return durationFor(380);
    if (pad === 7) return durationFor(160);
    if (pad === 8) return durationFor(p.rimDecayMs);
    if (pad === 9) return p.shakerMs / 1000;
    if (pad === 10) return durationFor(p.cowbellDecayMs);
    return durationFor(p.rideMs);
  })() : .16;
  const start = Math.round((START + .004) * SAMPLE_RATE);
  // Keep parity on the direct hit, not on room reverb after a short pad has
  // ended. The output graph and production master remain the same.
  const end = Math.min(samples.length, Math.max(start + 128, Math.round((START + .004 + Math.min(.16, directDuration)) * SAMPLE_RATE)));
  let rawPeak = 0;
  let peakIndex = start;
  let square = 0;
  for (let index = start; index < end; index += 1) { if (Math.abs(samples[index]) > rawPeak) { rawPeak = Math.abs(samples[index]); peakIndex = index; } square += samples[index] * samples[index]; }
  const levelWindow = Math.max(16, Math.min(64, Math.floor((end - start) / 4)));
  let peak = 0;
  for (let windowStart = start; windowStart + levelWindow <= end; windowStart += 1) {
    let windowSquare = 0;
    for (let index = windowStart; index < windowStart + levelWindow; index += 1) windowSquare += samples[index] * samples[index];
    peak = Math.max(peak, Math.sqrt(windowSquare / levelWindow));
  }
  const center = Math.round(Math.min(START + .05, START + .004 + Math.min(.16, directDuration / 2)) * SAMPLE_RATE);
  return { peak, rawPeak, peakTime: peakIndex / SAMPLE_RATE, rms: Math.sqrt(square / Math.max(1, end - start)), band20To200: dftBandRms(samples, center, 20, 200), band200To1000: dftBandRms(samples, center, 200, 1000), band1000To4000: dftBandRms(samples, center, 1000, 4000) };
};

const ratio = (left: number, right: number, floor = 0) => {
  const high = Math.max(left, right);
  const low = Math.min(left, right);
  if (high <= floor) return 1;
  return high / Math.max(floor, low);
};

const withDeterministicRandom = async <T>(seed: number, callback: (reset: (nextSeed: number) => void) => Promise<T>): Promise<T> => {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  try { return await callback((nextSeed) => { state = nextSeed >>> 0; }); }
  finally { Math.random = original; }
};

const renderParity = async (): Promise<ParityReport> => {
  const cases: ParityReport['cases'] = [];
  const failedCases: string[] = [];
  for (const presetId of LEGACY_PRESET_IDS) {
    for (const model of MODELS) {
      for (const pad of PARITY_PADS) {
        const profile = profileFor(presetId, model);
        const seed = (presetId.length * 10000 + MODELS.indexOf(model) * 1000 + pad * 17 + 7) >>> 0;
        const independent = await renderParityHit(profile, model, pad, false, seed);
        const legacyEquivalent = await renderParityHit(profile, model, pad, true, seed);
        const ratios = {
          peak: ratio(independent.peak, legacyEquivalent.peak),
          rms: ratio(independent.rms, legacyEquivalent.rms),
          '20-200': ratio(independent.band20To200, legacyEquivalent.band20To200, PARITY_BAND_FLOOR),
          '200-1000': ratio(independent.band200To1000, legacyEquivalent.band200To1000, PARITY_BAND_FLOOR),
          '1000-4000': ratio(independent.band1000To4000, legacyEquivalent.band1000To4000, PARITY_BAND_FLOOR),
        };
        const passed = ratios.peak <= DRUM_HARNESS_THRESHOLDS.parity.levelRatio && ratios.rms <= DRUM_HARNESS_THRESHOLDS.parity.levelRatio && Object.entries(ratios).filter(([key]) => key !== 'peak' && key !== 'rms').every(([, value]) => value <= DRUM_HARNESS_THRESHOLDS.parity.coarseBandRatio);
        const item = { presetId, model, pad, independent, legacyEquivalent, ratios, passed };
        cases.push(item);
        if (!passed) failedCases.push(`${presetId}/${model}/pad-${pad}`);
      }
    }
  }
  return { thresholds: DRUM_HARNESS_THRESHOLDS.parity, requested: LEGACY_PRESET_IDS.length * MODELS.length * PARITY_PADS.length, completed: cases.length, failedCases, cases, passed: failedCases.length === 0 };
};

export const runIndependentDrumOfflineHarness = async () => {
  if (typeof OfflineAudioContext === 'undefined') return { status: 'unsupported' as const, failureReasons: ['OfflineAudioContext is not available.'] };
  const combinations: CombinationReport[] = [];
  const hitFailures: Array<{ presetId: string; model: DrumModel; pad: number; reasons: string[] }> = [];
  for (const presetId of [...LEGACY_PRESET_IDS, ...KIT_PRESET_IDS]) {
    const models = LEGACY_PRESET_IDS.includes(presetId) ? MODELS : ['electronic' as DrumModel];
    for (const model of models) {
      const result = await collectCombination(presetId, model);
      combinations.push(result.summary);
      result.reports.filter((report) => !report.passed).forEach((report) => hitFailures.push({ presetId, model, pad: report.pad, reasons: report.failureReasons }));
    }
  }
  const stresses = [
    await renderStress('clean-layered-deck', profileFor('Clean', 'layered'), 'layered'),
    await renderStress('industrial-noisy-deck', profileFor('Industrial', 'noisy'), 'noisy'),
    await renderStress('808-electronic-deck-a-b', profileFor('808', 'electronic'), 'electronic', true),
    await renderStress('circuit-electronic-deck-a-b', profileFor('Circuit', 'electronic'), 'electronic', true),
    await renderStress('glitch-electronic-deck-a-b', profileFor('Glitch', 'electronic'), 'electronic', true),
    await renderStressEvents('simultaneous-kick-snare-hat-deck-a-b', profileFor('Clean', 'layered'), 'layered', simultaneousEvents([0, 1, 2])),
    await renderStressEvents('repeated-kick-snare-deck-a-b', profileFor('Industrial', 'noisy'), 'noisy', repeatedKickSnareEvents()),
  ];
  const hatChoke = await renderHatChoke();
  const detectorSelfTest = releaseDiagnosticSelfTest(SAMPLE_RATE);
  const parity = await renderParity();
  const failureReasons = [
    ...hitFailures.map((failure) => `${failure.presetId}/${failure.model}/pad-${failure.pad}: ${failure.reasons.join(', ')}`),
    ...stresses.filter((stress) => !stress.passed).map((stress) => `${stress.name}: ${stress.failureReasons.join(', ')}`),
    ...(hatChoke.passed ? [] : ['hat choke lane isolation']),
    ...(detectorSelfTest.detected ? [] : ['detector self-test']),
    ...(parity.passed ? [] : ['legacy-equivalent drum parity']),
  ];
  const requestedPadCases = LEGACY_PRESET_IDS.length * MODELS.length * DRUM_NAMES.length + KIT_PRESET_IDS.length * DRUM_NAMES.length;
  const acceptedPadCases = combinations.reduce((sum, combination) => sum + combination.acceptedPads, 0);
  const report = {
    status: failureReasons.length === 0 ? 'passed' as const : 'failed' as const,
    sampleRate: SAMPLE_RATE,
    masterGain: MASTER_GAIN,
    pads: [...DRUM_NAMES],
    legacyPresetIds: LEGACY_PRESET_IDS,
    electronicKitIds: KIT_PRESET_IDS,
    requestedPadCases,
    acceptedPadCases,
    combinations,
    hitFailures,
    stresses,
    hatChoke,
    detectorSelfTest,
    parity,
    thresholds: DRUM_HARNESS_THRESHOLDS,
    failureReasons,
  };
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify(report, null, 2);
  return report;
};

if (typeof document !== 'undefined') runIndependentDrumOfflineHarness().catch((error) => {
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify({ status: 'failed', error: String(error) }, null, 2);
});
