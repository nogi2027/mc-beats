export type ReleaseBoundaryKind = 'release-start' | 'release-end' | 'source-stop';

export type ReleaseDiagnosticThresholds = {
  boundaryRadiusSamples: number;
  baselineRadiusSamples: number;
  exclusionRadiusSamples: number;
  boundaryMaxRatio: number;
  boundaryAdditiveFloor: number;
  boundaryAbsoluteFloor: number;
  highBandLowHz: number;
  highBandHighHz: number;
  highBandWindowSamples: number;
  highBandNearbyOffsetSamples: number;
  highBandMaxRatio: number;
  highBandAdditiveFloor: number;
  highBandAbsoluteFloor: number;
};

export type ReleaseBoundaryMetric = {
  kind: ReleaseBoundaryKind;
  audioTimeSeconds: number;
  sampleIndex: number;
  maxAdjacentSampleDelta: number;
  localMedianAdjacentDelta: number;
  localP95AdjacentDelta: number;
  boundaryThreshold: number;
  boundaryPassed: boolean;
  highBandRms: number;
  highBandPeakRms: number;
  nearbyHighBandRms: number[];
  highBandThreshold: number;
  highBandPassed: boolean;
};

export const DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS: ReleaseDiagnosticThresholds = {
  boundaryRadiusSamples: 8,
  baselineRadiusSamples: 192,
  exclusionRadiusSamples: 16,
  boundaryMaxRatio: 6,
  boundaryAdditiveFloor: .004,
  boundaryAbsoluteFloor: .012,
  highBandLowHz: 1000,
  highBandHighHz: 8000,
  highBandWindowSamples: 512,
  highBandNearbyOffsetSamples: 1536,
  highBandMaxRatio: 4,
  highBandAdditiveFloor: .0008,
  highBandAbsoluteFloor: .0004,
};

const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};

const nearbyCenters = (center: number, length: number, offset: number, window: number) => [...new Set([
  center - offset, center + offset,
  center - offset * 2, center + offset * 2,
].map((candidate) => Math.max(0, Math.min(length - 1, candidate))).filter((candidate) =>
  Math.abs(candidate - center) > window / 2,
))].slice(0, 2);

/** A small DFT probe. It is intentionally independent of AnalyserNode so the
 * browser harness measures rendered PCM at exact sample positions. */
export const bandRms = (
  samples: Float32Array,
  center: number,
  sampleRate: number,
  lowHz: number,
  highHz: number,
  windowSamples: number,
) => {
  const half = Math.floor(windowSamples / 2);
  const start = Math.max(0, Math.min(samples.length, Math.round(center) - half));
  const end = Math.min(samples.length, start + windowSamples);
  const length = end - start;
  if (length <= 0) return 0;
  let energy = 0;
  const bins = 32;
  for (let bin = 0; bin < bins; bin += 1) {
    const frequency = lowHz + (highHz - lowHz) * bin / Math.max(1, bins - 1);
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

const highBandPeak = (samples: Float32Array, center: number, sampleRate: number, thresholds: ReleaseDiagnosticThresholds) => {
  const half = Math.floor(thresholds.highBandWindowSamples / 2);
  let peak = 0;
  for (let offset = -half; offset <= half; offset += Math.max(1, Math.floor(half / 4))) {
    peak = Math.max(peak, bandRms(samples, center + offset, sampleRate, thresholds.highBandLowHz, thresholds.highBandHighHz, thresholds.highBandWindowSamples));
  }
  return peak;
};

export const measureReleaseBoundary = (
  samples: Float32Array,
  audioTimeSeconds: number,
  sampleRate: number,
  kind: ReleaseBoundaryKind,
  thresholds: ReleaseDiagnosticThresholds = DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS,
): ReleaseBoundaryMetric => {
  const center = Math.max(0, Math.min(samples.length - 1, Math.round(audioTimeSeconds * sampleRate)));
  const boundaryDeltas: number[] = [];
  const baselineDeltas: number[] = [];
  const start = Math.max(1, center - thresholds.baselineRadiusSamples);
  const end = Math.min(samples.length - 1, center + thresholds.baselineRadiusSamples);
  for (let index = start; index <= end; index += 1) {
    const delta = Math.abs(samples[index] - samples[index - 1]);
    if (Math.abs(index - center) <= thresholds.boundaryRadiusSamples) boundaryDeltas.push(delta);
    if (Math.abs(index - center) > thresholds.exclusionRadiusSamples) baselineDeltas.push(delta);
  }
  const localMedianAdjacentDelta = percentile(baselineDeltas, .5);
  const localP95AdjacentDelta = percentile(baselineDeltas, .95);
  const maxAdjacentSampleDelta = Math.max(...boundaryDeltas, 0);
  const boundaryThreshold = Math.max(
    thresholds.boundaryAbsoluteFloor,
    localP95AdjacentDelta * thresholds.boundaryMaxRatio + thresholds.boundaryAdditiveFloor,
  );
  const highBandRms = bandRms(samples, center, sampleRate, thresholds.highBandLowHz, thresholds.highBandHighHz, thresholds.highBandWindowSamples);
  const highBandPeakRms = highBandPeak(samples, center, sampleRate, thresholds);
  const nearbyHighBandRms = nearbyCenters(center, samples.length, thresholds.highBandNearbyOffsetSamples, thresholds.highBandWindowSamples)
    .map((nearby) => bandRms(samples, nearby, sampleRate, thresholds.highBandLowHz, thresholds.highBandHighHz, thresholds.highBandWindowSamples));
  const highBandThreshold = Math.max(
    thresholds.highBandAbsoluteFloor,
    Math.max(...nearbyHighBandRms, 0) * thresholds.highBandMaxRatio + thresholds.highBandAdditiveFloor,
  );
  return {
    kind,
    audioTimeSeconds,
    sampleIndex: center,
    maxAdjacentSampleDelta,
    localMedianAdjacentDelta,
    localP95AdjacentDelta,
    boundaryThreshold,
    boundaryPassed: maxAdjacentSampleDelta <= boundaryThreshold,
    highBandRms,
    highBandPeakRms,
    nearbyHighBandRms,
    highBandThreshold,
    highBandPassed: highBandPeakRms <= highBandThreshold,
  };
};

export const releaseDiagnosticSelfTest = (sampleRate = 44_100) => {
  const center = 4096;
  const baseline = () => {
    const samples = new Float32Array(8192);
    for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(2 * Math.PI * 70 * index / sampleRate) * .01;
    return samples;
  };

  const discontinuitySamples = baseline();
  for (let offset = -10; offset <= 10; offset += 1) {
    discontinuitySamples[center + offset] += (offset % 2 === 0 ? 1 : -1) * .45;
  }
  const discontinuity = measureReleaseBoundary(discontinuitySamples, center / sampleRate, sampleRate, 'release-start');

  // The burst is deliberately band-limited and tapered by the finite window.
  // Its amplitude is high enough to fail the high-band detector but low enough
  // that its ordinary waveform slope remains below the boundary detector.
  const burstSamples = baseline();
  for (let offset = -256; offset <= 256; offset += 1) {
    const taper = .5 + .5 * Math.cos(Math.PI * offset / 256);
    burstSamples[center + offset] += Math.sin(2 * Math.PI * 3000 * offset / sampleRate) * .04 * taper;
  }
  const highBandBurst = measureReleaseBoundary(burstSamples, center / sampleRate, sampleRate, 'release-start');

  return {
    detected: !discontinuity.boundaryPassed && discontinuity.highBandPassed && highBandBurst.boundaryPassed && !highBandBurst.highBandPassed,
    boundaryFault: {
      detected: !discontinuity.boundaryPassed,
      boundaryPassed: discontinuity.boundaryPassed,
      highBandPassed: discontinuity.highBandPassed,
      observedAdjacentDelta: discontinuity.maxAdjacentSampleDelta,
      boundaryThreshold: discontinuity.boundaryThreshold,
      observedHighBandRms: discontinuity.highBandPeakRms,
      highBandThreshold: discontinuity.highBandThreshold,
    },
    highBandFault: {
      detected: !highBandBurst.highBandPassed,
      boundaryPassed: highBandBurst.boundaryPassed,
      highBandPassed: highBandBurst.highBandPassed,
      observedAdjacentDelta: highBandBurst.maxAdjacentSampleDelta,
      boundaryThreshold: highBandBurst.boundaryThreshold,
      observedHighBandRms: highBandBurst.highBandPeakRms,
      highBandThreshold: highBandBurst.highBandThreshold,
    },
    // Preserve the compact fields used by older debug readers.
    boundaryPassed: discontinuity.boundaryPassed,
    highBandPassed: highBandBurst.highBandPassed,
    observedAdjacentDelta: discontinuity.maxAdjacentSampleDelta,
    boundaryThreshold: discontinuity.boundaryThreshold,
    observedHighBandRms: highBandBurst.highBandPeakRms,
    highBandThreshold: highBandBurst.highBandThreshold,
  };
};
