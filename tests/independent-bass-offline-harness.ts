import { IndependentBassEngine } from '../src/synth/independent-bass.ts';
import { BASS_PRESETS, bassDriveCurve, normalizeBassProfile } from '../src/synth/patches/bass.ts';

export type OfflineBassBoundary = {
  kind: 'onset' | 'note-off' | 'release-end';
  audioTimeSeconds: number;
  sampleIndex: number;
  maxAdjacentSampleDelta: number;
  localMedianAdjacentDelta: number;
  localP95AdjacentDelta: number;
  outlierScore: number;
  boundaryThreshold: number;
  boundaryPassed: boolean;
  band2To8kRms: number;
  nearbyBandRms: number[];
  highBandBaselineRms: number;
  highBandThreshold: number;
  highBandPassed: boolean;
};

export type OfflineBassCase = {
  name: string;
  durationSeconds: number;
  sampleRate: number;
  finite: boolean;
  peakAbs: number;
  clippedSamples: number;
  postTailPeak: number;
  boundaries: OfflineBassBoundary[];
  releaseBandRms: number[];
  nearbyBandRms: number[];
  boundaryChecksPassed: boolean;
  highBandChecksPassed: boolean;
  passed: boolean;
};

export type OfflineBassParity = {
  reference: 'legacy-equivalent-sub-path';
  passed: boolean;
  peakIndependent: number;
  peakReference: number;
  peakRatio: number;
  rmsIndependent: number;
  rmsReference: number;
  rmsRatio: number;
  coarseBandRatios: Record<string, number>;
  thresholds: { levelRatio: number; coarseBandRatio: number };
};

export type OfflineBassHarnessReport = {
  status: 'passed' | 'failed' | 'unsupported';
  sampleRate: number | null;
  thresholds: {
    clipping: number;
    postTailPeak: number;
    boundary: {
      radiusSamples: number;
      exclusionRadiusSamples: number;
      baselineRadiusSamples: number;
      maxRatio: number;
      additiveFloor: number;
      absoluteFloor: number;
    };
    highBand: {
      windowSamples: number;
      nearbyOffsetSamples: number;
      maxRatio: number;
      additiveFloor: number;
      absoluteFloor: number;
    };
    parity: { levelRatio: number; coarseBandRatio: number };
  };
  detectorSelfTest: {
    detected: boolean;
    boundaryPassed: boolean;
    highBandPassed: boolean;
    injectedBurst: number;
    boundaryObserved: number;
    boundaryThreshold: number;
    highBandObserved: number;
    highBandThreshold: number;
  };
  parity: OfflineBassParity | null;
  cases: OfflineBassCase[];
  failureReasons: string[];
};

type NoteSpec = { start: number; gate: number; midi: number };

const SAMPLE_RATE = 44_100;
const PRODUCTION_MASTER_GAIN = .38;
const TAIL_SECONDS = .12;
const RELEASE_SECONDS = .5;
const BOUNDARY_RADIUS_SAMPLES = 6;
const BOUNDARY_EXCLUSION_RADIUS_SAMPLES = 12;
const BOUNDARY_BASELINE_RADIUS_SAMPLES = 96;
const BOUNDARY_MAX_RATIO = 6;
const BOUNDARY_ADDITIVE_FLOOR = .01;
const BOUNDARY_ABSOLUTE_FLOOR = .015;
const HIGH_BAND_WINDOW_SAMPLES = 512;
const HIGH_BAND_NEARBY_OFFSET_SAMPLES = 1024;
const HIGH_BAND_MAX_RATIO = 4;
const HIGH_BAND_ADDITIVE_FLOOR = .001;
// This floor is high enough to ignore the Sub carrier's normal leakage but
// low enough for a single short broadband burst at the boundary to fail.
const HIGH_BAND_ABSOLUTE_FLOOR = .0005;
const PARITY_LEVEL_RATIO = 1.35;
const PARITY_COARSE_BAND_RATIO = 1.8;
const BAND_START = 2000;
const BAND_END = 8000;

const THRESHOLDS: OfflineBassHarnessReport['thresholds'] = {
  clipping: 0,
  postTailPeak: .02,
  boundary: {
    radiusSamples: BOUNDARY_RADIUS_SAMPLES,
    exclusionRadiusSamples: BOUNDARY_EXCLUSION_RADIUS_SAMPLES,
    baselineRadiusSamples: BOUNDARY_BASELINE_RADIUS_SAMPLES,
    maxRatio: BOUNDARY_MAX_RATIO,
    additiveFloor: BOUNDARY_ADDITIVE_FLOOR,
    absoluteFloor: BOUNDARY_ABSOLUTE_FLOOR,
  },
  highBand: {
    windowSamples: HIGH_BAND_WINDOW_SAMPLES,
    nearbyOffsetSamples: HIGH_BAND_NEARBY_OFFSET_SAMPLES,
    maxRatio: HIGH_BAND_MAX_RATIO,
    additiveFloor: HIGH_BAND_ADDITIVE_FLOOR,
    absoluteFloor: HIGH_BAND_ABSOLUTE_FLOOR,
  },
  parity: { levelRatio: PARITY_LEVEL_RATIO, coarseBandRatio: PARITY_COARSE_BAND_RATIO },
};

const finite = (value: number) => Number.isFinite(value);
const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};

export const dftBandRms = (samples: Float32Array, center: number, sampleRate: number, lowHz = BAND_START, highHz = BAND_END, windowSamples = HIGH_BAND_WINDOW_SAMPLES) => {
  const halfWindow = Math.floor(windowSamples / 2);
  const start = Math.max(0, Math.min(samples.length, Math.round(center) - halfWindow));
  const end = Math.min(samples.length, start + windowSamples);
  const length = end - start;
  if (length <= 0) return 0;
  let energy = 0;
  const bins = 24;
  for (let bin = 0; bin < bins; bin += 1) {
    const frequency = lowHz + (highHz - lowHz) * bin / (bins - 1);
    let real = 0;
    let imaginary = 0;
    for (let index = start; index < end; index += 1) {
      const window = .5 - .5 * Math.cos(2 * Math.PI * (index - start) / Math.max(1, length - 1));
      const phase = 2 * Math.PI * frequency * (index - start) / sampleRate;
      const sample = samples[index] * window;
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    energy += (real * real + imaginary * imaginary) / Math.max(1, length * length);
  }
  return Math.sqrt(energy / bins);
};

const nearbyCenters = (center: number, length: number) => [...new Set([
  center - HIGH_BAND_NEARBY_OFFSET_SAMPLES,
  center + HIGH_BAND_NEARBY_OFFSET_SAMPLES,
  center - HIGH_BAND_NEARBY_OFFSET_SAMPLES * 2,
  center + HIGH_BAND_NEARBY_OFFSET_SAMPLES * 2,
].map((candidate) => Math.max(0, Math.min(length - 1, candidate))).filter((candidate) =>
  Math.abs(candidate - center) > HIGH_BAND_WINDOW_SAMPLES / 2 + BOUNDARY_RADIUS_SAMPLES,
))].slice(0, 2);

/** Returns the boundary metric and pass/fail decisions used by the harness. */
export const boundaryMetric = (samples: Float32Array, audioTimeSeconds: number, sampleRate: number, kind: OfflineBassBoundary['kind']): OfflineBassBoundary => {
  const center = Math.max(0, Math.min(samples.length - 1, Math.round(audioTimeSeconds * sampleRate)));
  const deltas: number[] = [];
  const baseline: number[] = [];
  const from = Math.max(1, center - BOUNDARY_BASELINE_RADIUS_SAMPLES);
  const to = Math.min(samples.length - 1, center + BOUNDARY_BASELINE_RADIUS_SAMPLES);
  for (let index = from; index <= to; index += 1) {
    const delta = Math.abs(samples[index] - samples[index - 1]);
    if (Math.abs(index - center) <= BOUNDARY_RADIUS_SAMPLES) deltas.push(delta);
    if (Math.abs(index - center) > BOUNDARY_EXCLUSION_RADIUS_SAMPLES) baseline.push(delta);
  }
  const localMedianAdjacentDelta = percentile(baseline, .5);
  const localP95AdjacentDelta = percentile(baseline, .95);
  const maxAdjacentSampleDelta = Math.max(...deltas, 0);
  const boundaryThreshold = Math.max(BOUNDARY_ABSOLUTE_FLOOR, localP95AdjacentDelta * BOUNDARY_MAX_RATIO + BOUNDARY_ADDITIVE_FLOOR);
  const boundaryPassed = maxAdjacentSampleDelta <= boundaryThreshold;
  const band2To8kRms = dftBandRms(samples, center, sampleRate);
  const nearbyBandRms = nearbyCenters(center, samples.length).map((nearby) => dftBandRms(samples, nearby, sampleRate));
  const highBandBaselineRms = Math.max(...nearbyBandRms, 0);
  const highBandThreshold = Math.max(HIGH_BAND_ABSOLUTE_FLOOR, highBandBaselineRms * HIGH_BAND_MAX_RATIO + HIGH_BAND_ADDITIVE_FLOOR);
  const highBandPassed = band2To8kRms <= highBandThreshold;
  return {
    kind,
    audioTimeSeconds,
    sampleIndex: center,
    maxAdjacentSampleDelta,
    localMedianAdjacentDelta,
    localP95AdjacentDelta,
    outlierScore: maxAdjacentSampleDelta / Math.max(1e-7, localMedianAdjacentDelta),
    boundaryThreshold,
    boundaryPassed,
    band2To8kRms,
    nearbyBandRms,
    highBandBaselineRms,
    highBandThreshold,
    highBandPassed,
  };
};

const renderOutput = (context: OfflineAudioContext) => {
  const master = context.createGain();
  master.gain.value = PRODUCTION_MASTER_GAIN;
  master.connect(context.destination);
  return master;
};

const renderCase = async (name: string, notes: NoteSpec[], sampleRate = SAMPLE_RATE): Promise<OfflineBassCase> => {
  const lastEnd = Math.max(...notes.map((note) => note.start + note.gate + RELEASE_SECONDS));
  const durationSeconds = lastEnd + TAIL_SECONDS;
  const context = new OfflineAudioContext(1, Math.ceil(durationSeconds * sampleRate), sampleRate);
  const engine = new IndependentBassEngine({ context, destination: renderOutput(context) });
  notes.forEach((note) => engine.note(note.midi, note.gate, note.start, BASS_PRESETS[0], 'deckA', 1));
  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  engine.dispose();

  const boundaries = notes.flatMap((note) => [
    boundaryMetric(samples, note.start, sampleRate, 'onset'),
    boundaryMetric(samples, note.start + note.gate, sampleRate, 'note-off'),
    boundaryMetric(samples, note.start + note.gate + RELEASE_SECONDS, sampleRate, 'release-end'),
  ]);
  const releaseBoundaries = boundaries.filter((boundary) => boundary.kind === 'note-off');
  const releaseBandRms = releaseBoundaries.map((boundary) => boundary.band2To8kRms);
  const nearbyBandRms = releaseBoundaries.flatMap((boundary) => boundary.nearbyBandRms);
  const tailStart = Math.min(samples.length, Math.round(lastEnd * sampleRate));
  let postTailPeak = 0;
  for (let index = tailStart; index < samples.length; index += 1) postTailPeak = Math.max(postTailPeak, Math.abs(samples[index]));
  let clippedSamples = 0;
  let peakAbs = 0;
  let allFinite = true;
  for (const sample of samples) {
    if (!finite(sample)) allFinite = false;
    peakAbs = Math.max(peakAbs, Math.abs(sample));
    if (Math.abs(sample) >= 1) clippedSamples += 1;
  }
  const boundaryChecksPassed = boundaries.every((boundary) => boundary.boundaryPassed);
  const highBandChecksPassed = boundaries.every((boundary) => boundary.highBandPassed);
  const passed = allFinite && clippedSamples === 0 && postTailPeak <= THRESHOLDS.postTailPeak && boundaryChecksPassed && highBandChecksPassed;
  return { name, durationSeconds, sampleRate, finite: allFinite, peakAbs, clippedSamples, postTailPeak, boundaries, releaseBandRms, nearbyBandRms, boundaryChecksPassed, highBandChecksPassed, passed };
};

/** A deterministic reference with the legacy Sub oscillator/filter/drive
 * path and the same production master gain. It checks level and coarse tone,
 * not phase, so the independent patch cannot silently lose 6 dB. */
const renderReferenceSub = async (sampleRate = SAMPLE_RATE) => {
  const durationSeconds = 1.1;
  const context = new OfflineAudioContext(1, Math.ceil(durationSeconds * sampleRate), sampleRate);
  const master = renderOutput(context);
  const patch = normalizeBassProfile(BASS_PRESETS[0], sampleRate);
  const main = context.createOscillator();
  const sub = context.createOscillator();
  const mainGain = context.createGain();
  const subGain = context.createGain();
  const envelope = context.createGain();
  const filter = context.createBiquadFilter();
  const shaper = context.createWaveShaper();
  const profileGain = context.createGain();
  main.type = patch.mainType;
  sub.type = patch.subType;
  main.frequency.value = 440 * Math.pow(2, (36 - 69) / 12);
  sub.frequency.value = main.frequency.value * Math.pow(2, patch.subOctave);
  mainGain.gain.value = patch.mainGain;
  subGain.gain.value = patch.subLevel;
  envelope.gain.setValueAtTime(0, 0);
  envelope.gain.linearRampToValueAtTime(1, patch.attackSeconds);
  envelope.gain.linearRampToValueAtTime(patch.sustain, patch.attackSeconds + patch.decaySeconds);
  filter.type = 'lowpass';
  filter.frequency.value = patch.filterHz;
  filter.Q.value = patch.filterQ;
  shaper.curve = bassDriveCurve(patch.drive);
  shaper.oversample = patch.oversample;
  profileGain.gain.value = patch.profile.volume;
  main.connect(mainGain).connect(envelope);
  sub.connect(subGain).connect(envelope);
  envelope.connect(filter).connect(shaper).connect(profileGain).connect(master);
  main.start(0); sub.start(0);
  main.stop(durationSeconds); sub.stop(durationSeconds);
  const buffer = await context.startRendering();
  return buffer.getChannelData(0);
};

const rangePeak = (samples: Float32Array, start: number, end: number) => {
  let peak = 0;
  for (let index = Math.max(0, start); index < Math.min(samples.length, end); index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return peak;
};

const rangeRms = (samples: Float32Array, start: number, end: number) => {
  const from = Math.max(0, start);
  const to = Math.min(samples.length, end);
  if (to <= from) return 0;
  let energy = 0;
  for (let index = from; index < to; index += 1) energy += samples[index] * samples[index];
  return Math.sqrt(energy / (to - from));
};

const renderParity = async (): Promise<OfflineBassParity> => {
  const context = new OfflineAudioContext(1, Math.ceil(1.1 * SAMPLE_RATE), SAMPLE_RATE);
  const engine = new IndependentBassEngine({ context, destination: renderOutput(context) });
  engine.note(36, .25, 0, BASS_PRESETS[0], 'deckA', 1);
  const independentBuffer = await context.startRendering();
  const independent = independentBuffer.getChannelData(0);
  engine.dispose();
  const reference = await renderReferenceSub(SAMPLE_RATE);
  const windowStart = Math.round(.06 * SAMPLE_RATE);
  const windowEnd = Math.round(.2 * SAMPLE_RATE);
  const peakIndependent = rangePeak(independent, windowStart, windowEnd);
  const peakReference = rangePeak(reference, windowStart, windowEnd);
  const rmsIndependent = rangeRms(independent, windowStart, windowEnd);
  const rmsReference = rangeRms(reference, windowStart, windowEnd);
  const ratio = (left: number, right: number) => Math.max(left, right) / Math.max(1e-7, Math.min(left, right));
  const coarseBands: Record<string, [number, number]> = { '20-200Hz': [20, 200], '200-1000Hz': [200, 1000], '1000-4000Hz': [1000, 4000] };
  const coarseBandRatios = Object.fromEntries(Object.entries(coarseBands).map(([name, [low, high]]) => [
    name,
    ratio(dftBandRms(independent, Math.round(.14 * SAMPLE_RATE), SAMPLE_RATE, low, high, 2048), dftBandRms(reference, Math.round(.14 * SAMPLE_RATE), SAMPLE_RATE, low, high, 2048)),
  ]));
  return {
    reference: 'legacy-equivalent-sub-path',
    passed: ratio(peakIndependent, peakReference) <= PARITY_LEVEL_RATIO && ratio(rmsIndependent, rmsReference) <= PARITY_LEVEL_RATIO && Object.values(coarseBandRatios).every((value) => value <= PARITY_COARSE_BAND_RATIO),
    peakIndependent,
    peakReference,
    peakRatio: ratio(peakIndependent, peakReference),
    rmsIndependent,
    rmsReference,
    rmsRatio: ratio(rmsIndependent, rmsReference),
    coarseBandRatios,
    thresholds: { levelRatio: PARITY_LEVEL_RATIO, coarseBandRatio: PARITY_COARSE_BAND_RATIO },
  };
};

const detectorSelfTest = () => {
  const samples = new Float32Array(4096);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(2 * Math.PI * 60 * index / SAMPLE_RATE) * .02;
  const center = 2048;
  const injectedBurst = .5;
  // A short 4 kHz burst models the broadband edge that this harness is meant
  // to catch. The single center sample also makes the adjacent-delta check
  // independently sensitive to a step.
  for (let offset = -8; offset <= 8; offset += 1) samples[center + offset] += injectedBurst * Math.sin(2 * Math.PI * 4000 * offset / SAMPLE_RATE);
  samples[center] += injectedBurst;
  const boundary = boundaryMetric(samples, center / SAMPLE_RATE, SAMPLE_RATE, 'note-off');
  return {
    detected: !boundary.boundaryPassed || !boundary.highBandPassed,
    boundaryPassed: boundary.boundaryPassed,
    highBandPassed: boundary.highBandPassed,
    injectedBurst,
    boundaryObserved: boundary.maxAdjacentSampleDelta,
    boundaryThreshold: boundary.boundaryThreshold,
    highBandObserved: boundary.band2To8kRms,
    highBandThreshold: boundary.highBandThreshold,
  };
};

const cases = (): Array<{ name: string; notes: NoteSpec[] }> => [
  { name: 'first-onset', notes: [{ start: 0, gate: .25, midi: 36 }] },
  { name: 'release-during-attack', notes: [{ start: 0, gate: .002, midi: 36 }] },
  { name: 'release-during-decay', notes: [{ start: 0, gate: .02, midi: 36 }] },
  { name: 'release-during-sustain', notes: [{ start: 0, gate: .2, midi: 36 }] },
  ...[0, .001, .005, .01, .02, .05, .1].map((gap) => ({
    name: `retrigger-${Math.round(gap * 1000)}ms`,
    notes: [{ start: .2, gate: .111, midi: 36 }, { start: .2 + gap, gate: .111, midi: 36 }],
  })),
  { name: 'three-rapid-notes', notes: [{ start: .2, gate: .111, midi: 36 }, { start: .21, gate: .111, midi: 40 }, { start: .22, gate: .111, midi: 43 }] },
  {
    name: 'four-bar-deck-stress',
    notes: Array.from({ length: 32 }, (_, index) => ({ start: index * .25, gate: .111, midi: 36 + index % 5 })),
  },
];

const emptyReport = (status: OfflineBassHarnessReport['status'], failureReasons: string[]): OfflineBassHarnessReport => ({
  status,
  sampleRate: status === 'unsupported' ? null : SAMPLE_RATE,
  thresholds: THRESHOLDS,
  detectorSelfTest: detectorSelfTest(),
  parity: null,
  cases: [],
  failureReasons,
});

export const runIndependentBassOfflineHarness = async (): Promise<OfflineBassHarnessReport> => {
  const selfTest = detectorSelfTest();
  if (typeof OfflineAudioContext === 'undefined') return { ...emptyReport('unsupported', ['OfflineAudioContext is not available in this browser.']), detectorSelfTest: selfTest };
  const rendered: OfflineBassCase[] = [];
  const failureReasons: string[] = [];
  if (!selfTest.detected) failureReasons.push('detector self-test did not detect its injected one-sample burst');
  let parity: OfflineBassParity | null = null;
  try {
    parity = await renderParity();
    if (!parity.passed) failureReasons.push('independent Sub level or coarse spectrum differs from the legacy-equivalent reference beyond the declared parity thresholds');
  } catch (error) {
    failureReasons.push(`Sub parity render failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const definition of cases()) {
    try {
      const result = await renderCase(definition.name, definition.notes);
      rendered.push(result);
      if (!result.finite) failureReasons.push(`${result.name}: non-finite PCM sample`);
      if (result.clippedSamples > THRESHOLDS.clipping) failureReasons.push(`${result.name}: ${result.clippedSamples} clipped PCM samples`);
      if (result.postTailPeak > THRESHOLDS.postTailPeak) failureReasons.push(`${result.name}: post-tail peak ${result.postTailPeak.toFixed(6)} exceeds ${THRESHOLDS.postTailPeak}`);
      if (!result.boundaryChecksPassed) failureReasons.push(`${result.name}: boundary discontinuity exceeded its local baseline threshold`);
      if (!result.highBandChecksPassed) failureReasons.push(`${result.name}: 2-8 kHz boundary energy exceeded its paired local threshold`);
    } catch (error) {
      failureReasons.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { status: failureReasons.length === 0 ? 'passed' : 'failed', sampleRate: SAMPLE_RATE, thresholds: THRESHOLDS, detectorSelfTest: selfTest, parity, cases: rendered, failureReasons };
};

if (typeof document !== 'undefined') {
  const output = document.querySelector('pre');
  void runIndependentBassOfflineHarness().then((report) => {
    if (output) output.textContent = JSON.stringify(report, null, 2);
  });
}
