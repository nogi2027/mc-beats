import type { DeckSoundProfile } from '../src/deck.ts';
import { LegacySynthEngine } from '../src/legacy/legacy-engine.ts';
import { IndependentMetronomeEngine } from '../src/synth/independent-metronome.ts';
import { sourceStopGuardSeconds } from '../src/synth/voice.ts';
import { DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS, measureReleaseBoundary, releaseDiagnosticSelfTest, type ReleaseBoundaryMetric } from '../src/synth/release-diagnostic.ts';
import { METRONOME_PRESETS, normalizeMetronomeProfile } from '../src/synth/patches/metronome.ts';

const SAMPLE_RATE = 44_100;
const MASTER_GAIN = .38;
const START = .1;
const CASE_SECONDS = 1.1;
const REPEAT_SECONDS = 4.5;
const MIN_ONSET_ENERGY = .00001;
const POST_TAIL_LIMIT = .00002;

type ClickCase = {
  presetId: string;
  accent: boolean;
  accepted: boolean;
  sourceCount: number;
  finite: boolean;
  clippedSamples: number;
  peakAbs: number;
  onsetEnergy: number;
  releaseEnd: number;
  stopAt: number;
  boundaries: ReleaseBoundaryMetric[];
  postTailPeak: number;
  retainedAtEnd: number;
  passed: boolean;
  failureReasons: string[];
};

type Metric = { peak: number; rms: number };

export const METRONOME_HARNESS_THRESHOLDS = {
  clipping: 0,
  minimumOnsetEnergy: MIN_ONSET_ENERGY,
  postTailPeak: POST_TAIL_LIMIT,
  parityLevelRatio: 1.5,
  release: DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS,
};

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

const scan = (samples: Float32Array) => {
  let peakAbs = 0;
  let clippedSamples = 0;
  let finite = true;
  for (const sample of samples) {
    finite &&= Number.isFinite(sample);
    peakAbs = Math.max(peakAbs, Math.abs(sample));
    if (Math.abs(sample) >= 1) clippedSamples += 1;
  }
  return { peakAbs, clippedSamples, finite };
};

const peakWindow = (samples: Float32Array, startSeconds: number, endSeconds: number) => {
  const start = Math.max(0, Math.min(samples.length, Math.round(startSeconds * SAMPLE_RATE)));
  const end = Math.max(start, Math.min(samples.length, Math.round(endSeconds * SAMPLE_RATE)));
  let peak = 0;
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return peak;
};

const profileMetric = (samples: Float32Array, startSeconds: number, endSeconds: number): Metric => {
  const start = Math.max(0, Math.min(samples.length, Math.round(startSeconds * SAMPLE_RATE)));
  const end = Math.max(start + 1, Math.min(samples.length, Math.round(endSeconds * SAMPLE_RATE)));
  let peak = 0;
  let square = 0;
  for (let index = start; index < end; index += 1) {
    peak = Math.max(peak, Math.abs(samples[index]));
    square += samples[index] * samples[index];
  }
  return { peak, rms: Math.sqrt(square / Math.max(1, end - start)) };
};

const directParityWindow = (profile: DeckSoundProfile) => {
  const patch = normalizeMetronomeProfile(profile, SAMPLE_RATE);
  const length = Math.min(.05, Math.max(.018, patch.attackSeconds + .012));
  return { start: START, end: START + length };
};

const legacyContext = (context: OfflineAudioContext) => {
  const original = window.AudioContext;
  const offlineAudioContext = new Proxy(context, {
    get(target, property) {
      if (property === 'resume') return () => Promise.resolve();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const AudioContextShim = class { constructor() { return offlineAudioContext as unknown as AudioContext; } };
  window.AudioContext = AudioContextShim as unknown as typeof AudioContext;
  return () => { window.AudioContext = original; };
};

const renderClick = async (profile: DeckSoundProfile, presetIndex: number, accent: boolean, independent: boolean) => {
  const context = new OfflineAudioContext(1, Math.ceil(CASE_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const master = independent ? createProductionSink(context) : undefined;
  let build: { voice: import('../src/synth/voice.ts').SynthVoice; sources: OscillatorNode[] } | null = null;
  let releaseEnd = START;
  let stopAt = START;
  let retainedAtEnd = 0;
  let cleanup = () => {};
  if (independent) {
    const engine = new IndependentMetronomeEngine({ context, destination: master, defaultProfile: profile });
    const result = engine.metronome(accent, START, profile, 'deckA', .8);
    if (result) {
      build = result;
      releaseEnd = result.voice.timing.releaseEndAt ?? START;
      stopAt = result.voice.timing.stopAt ?? releaseEnd + sourceStopGuardSeconds(SAMPLE_RATE);
    }
    cleanup = () => {
      retainedAtEnd = engine.retainedCount();
      if (retainedAtEnd > 0 && result) result.voice.forceDispose();
      retainedAtEnd = engine.retainedCount();
      engine.dispose();
    };
  } else {
    const restore = legacyContext(context);
    const engine = new LegacySynthEngine();
    await engine.start();
    engine.loadPreset('metronome', presetIndex);
    engine.metronome(accent, START);
    cleanup = () => { engine.dispose(); restore(); };
  }
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const result = scan(samples);
  const boundaries = build ? [
    measureReleaseBoundary(samples, releaseEnd, SAMPLE_RATE, 'release-end'),
    measureReleaseBoundary(samples, stopAt, SAMPLE_RATE, 'source-stop'),
  ] : [];
  const onsetEnergy = peakWindow(samples, START, START + .08);
  const postTailPeak = peakWindow(samples, stopAt + .05, CASE_SECONDS);
  const failureReasons: string[] = [];
  if (independent && !build) failureReasons.push('voice allocation rejected');
  if (!result.finite) failureReasons.push('non-finite PCM');
  if (result.clippedSamples > METRONOME_HARNESS_THRESHOLDS.clipping) failureReasons.push(`clipped samples: ${result.clippedSamples}`);
  if (independent && onsetEnergy < MIN_ONSET_ENERGY) failureReasons.push(`onset energy below ${MIN_ONSET_ENERGY}`);
  for (const boundary of boundaries) {
    if (!boundary.boundaryPassed) failureReasons.push(`${boundary.kind} adjacent-sample outlier`);
    if (!boundary.highBandPassed) failureReasons.push(`${boundary.kind} high-band burst`);
  }
  if (independent && postTailPeak > POST_TAIL_LIMIT) failureReasons.push(`post-tail peak ${postTailPeak}`);
  cleanup();
  return { result, boundaries, onsetEnergy, postTailPeak, releaseEnd, stopAt, retainedAtEnd, build, failureReasons };
};

const renderRepeated = async (profile: DeckSoundProfile, presetIndex: number) => {
  const context = new OfflineAudioContext(1, Math.ceil(REPEAT_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const master = createProductionSink(context);
  const engine = new IndependentMetronomeEngine({ context, destination: master, defaultProfile: profile });
  const builds: Array<{ start: number; voice: import('../src/synth/voice.ts').SynthVoice }> = [];
  for (let index = 0; index < 16; index += 1) {
    const result = engine.metronome(index % 4 === 0, index * .25, profile, 'deckA', .8);
    if (result) builds.push({ start: index * .25, voice: result.voice });
  }
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const scanResult = scan(samples);
  const onsetEnergies = builds.map(({ start }) => peakWindow(samples, start, start + .08));
  const failureReasons: string[] = [];
  if (builds.length !== 16) failureReasons.push(`accepted ${builds.length}/16 repeated clicks`);
  if (onsetEnergies.length === 0 || Math.min(...onsetEnergies) < MIN_ONSET_ENERGY) failureReasons.push('repeated onset energy below threshold');
  if (!scanResult.finite) failureReasons.push('non-finite repeated PCM');
  if (scanResult.clippedSamples > 0) failureReasons.push(`repeated clipped samples: ${scanResult.clippedSamples}`);
  const retainedBeforeFinalize = engine.retainedCount();
  builds.forEach(({ voice }) => voice.finishIfSilent(Math.max(voice.cleanupAt, REPEAT_SECONDS)));
  const retainedAfterFinalize = engine.retainedCount();
  if (retainedAfterFinalize > 0) builds.forEach(({ voice }) => voice.forceDispose());
  const retainedAtEnd = engine.retainedCount();
  if (retainedAtEnd !== 0) failureReasons.push(`retained voices at end ${retainedAtEnd}`);
  engine.dispose();
  return { requestedEvents: 16, acceptedEvents: builds.length, minimumOnsetEnergy: Math.min(...onsetEnergies), retainedBeforeFinalize, retainedAfterFinalize, retainedAtEnd, finite: scanResult.finite, clippedSamples: scanResult.clippedSamples, passed: failureReasons.length === 0, failureReasons };
};

const renderParity = async (profile: DeckSoundProfile, presetIndex: number, accent: boolean) => {
  const independentContext = new OfflineAudioContext(1, Math.ceil(CASE_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const independentMaster = createProductionSink(independentContext);
  const independent = new IndependentMetronomeEngine({ context: independentContext, destination: independentMaster, defaultProfile: profile });
  const independentBuild = independent.metronome(accent, START, profile, 'deckA', 1);
  const independentRendered = await independentContext.startRendering();
  const window = directParityWindow(profile);
  const independentMetric = profileMetric(independentRendered.getChannelData(0), window.start, window.end);
  independent.dispose();

  const legacyContextValue = new OfflineAudioContext(1, Math.ceil(CASE_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
  const restore = legacyContext(legacyContextValue);
  const legacy = new LegacySynthEngine();
  try {
    await legacy.start();
    legacy.loadPreset('metronome', presetIndex);
    legacy.metronome(accent, START);
    const legacyRendered = await legacyContextValue.startRendering();
    const legacyMetric = profileMetric(legacyRendered.getChannelData(0), window.start, window.end);
    const peakRatio = Math.max(independentMetric.peak, legacyMetric.peak) / Math.max(.000001, Math.min(independentMetric.peak, legacyMetric.peak));
    const rmsRatio = Math.max(independentMetric.rms, legacyMetric.rms) / Math.max(.000001, Math.min(independentMetric.rms, legacyMetric.rms));
    return { presetId: profile.presetId, accent, independent: independentMetric, legacy: legacyMetric, peakRatio, rmsRatio, passed: peakRatio <= 1.5 && rmsRatio <= 1.5 };
  } finally {
    legacy.dispose();
    restore();
  }
};

export const runIndependentMetronomeOfflineHarness = async () => {
  if (typeof OfflineAudioContext === 'undefined') return { status: 'unsupported' as const, failureReasons: ['OfflineAudioContext is not available.'] };
  const cases: ClickCase[] = [];
  const parity: Array<Awaited<ReturnType<typeof renderParity>>> = [];
  const repeats = [];
  for (let index = 0; index < METRONOME_PRESETS.length; index += 1) {
    const profile = METRONOME_PRESETS[index];
    for (const accent of [false, true]) {
      const rendered = await renderClick(profile, index, accent, true);
      cases.push({ presetId: profile.presetId, accent, accepted: rendered.build !== null, sourceCount: rendered.build?.sources.length ?? 0, finite: rendered.result.finite, clippedSamples: rendered.result.clippedSamples, peakAbs: rendered.result.peakAbs, onsetEnergy: rendered.onsetEnergy, releaseEnd: rendered.releaseEnd, stopAt: rendered.stopAt, boundaries: rendered.boundaries, postTailPeak: rendered.postTailPeak, retainedAtEnd: rendered.retainedAtEnd, passed: rendered.failureReasons.length === 0, failureReasons: rendered.failureReasons });
      parity.push(await renderParity(profile, index, accent));
    }
    repeats.push({ presetId: profile.presetId, ...(await renderRepeated(profile, index)) });
  }
  const detectorSelfTest = releaseDiagnosticSelfTest(SAMPLE_RATE);
  const failures = [
    ...cases.filter((item) => !item.passed).map((item) => `${item.presetId}/${item.accent ? 'accent' : 'normal'}: ${item.failureReasons.join(', ')}`),
    ...repeats.filter((item) => !item.passed).map((item) => `${item.presetId}/repeated: ${item.failureReasons.join(', ')}`),
    ...parity.filter((item) => !item.passed).map((item) => `${item.presetId}/${item.accent ? 'accent' : 'normal'} parity`),
    ...(detectorSelfTest.detected ? [] : ['detector self-test']),
  ];
  const report = {
    status: failures.length === 0 ? 'passed' as const : 'failed' as const,
    sampleRate: SAMPLE_RATE,
    masterGain: MASTER_GAIN,
    presetIds: METRONOME_PRESETS.map((profile) => profile.presetId),
    requestedCases: cases.length,
    acceptedCases: cases.filter((item) => item.accepted).length,
    cases,
    repeats,
    parity,
    detectorSelfTest,
    thresholds: METRONOME_HARNESS_THRESHOLDS,
    failureReasons: failures,
    profileNormalizationCheck: METRONOME_PRESETS.map((profile) => normalizeMetronomeProfile(profile, SAMPLE_RATE).profile.presetId),
  };
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify(report, null, 2);
  return report;
};

if (typeof document !== 'undefined') runIndependentMetronomeOfflineHarness().catch((error) => {
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify({ status: 'failed', error: String(error) }, null, 2);
});
