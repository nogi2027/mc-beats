import type { AudioEngine } from './synth/contract.ts';

export const SPECTRUM_COLUMNS = 600;
export const SPECTRUM_ROWS = 128;
export const SPECTRUM_SAMPLE_HZ = 60;
export const SPECTRUM_MIN_FREQUENCY = 20;
export const SPECTRUM_MAX_FREQUENCY = 20000;
export const SPECTRUM_MIN_DECIBELS = -100;
export const SPECTRUM_MAX_DECIBELS = -10;

export type FrequencyBand = { lowHz: number; highHz: number; firstBin: number; lastBin: number };
export type FrequencyHistorySample = { ageSeconds: number; timestampMs: number; audioTimeSeconds: number | null; intensities?: number[]; levelsDb: number[] };
export type FrequencyHistorySnapshotOptions = { maxSamples?: number; bandIndices?: number[]; summaryOnly?: boolean };
export type FrequencyHistorySnapshot = {
  description: string;
  captureState: 'empty' | 'scrolling' | 'frozen';
  sampleRateHz: number;
  timeSpanSeconds: number;
  requestedTimeSpanSeconds: number;
  returnedTimeSpanSeconds: number;
  fftSize: number;
  valueRange: { intensity: [number, number]; decibels: [number, number] };
  frequencyRangeHz: [number, number];
  bandsHz: [number, number][];
  samples: FrequencyHistorySample[];
  omitted: { samples: number; bands: number; decimated: boolean };
  summary?: { peakDb: number; rmsDb: number; sampleCount: number };
};

export const frequencyBands = (sampleRate: number): FrequencyBand[] => {
  const maxFrequency = Math.min(SPECTRUM_MAX_FREQUENCY, sampleRate / 2);
  const logMin = Math.log(SPECTRUM_MIN_FREQUENCY);
  const logMax = Math.log(maxFrequency);
  const binWidth = sampleRate / 2048;
  return Array.from({ length: SPECTRUM_ROWS }, (_, row) => {
    const lowHz = Math.exp(logMin + (logMax - logMin) * row / SPECTRUM_ROWS);
    const highHz = Math.exp(logMin + (logMax - logMin) * (row + 1) / SPECTRUM_ROWS);
    return { lowHz, highHz, firstBin: Math.max(0, Math.floor(lowHz / binWidth)), lastBin: Math.min(1023, Math.ceil(highHz / binWidth)) };
  });
};

export class FrequencyHistogramRecorder {
  private readonly engine: AudioEngine;
  private readonly history = new Float32Array(SPECTRUM_COLUMNS * SPECTRUM_ROWS);
  private readonly sampleTimes = new Float64Array(SPECTRUM_COLUMNS);
  private readonly sampleAudioTimes = new Float64Array(SPECTRUM_COLUMNS);
  private readonly analyserBuffer = new Float32Array(1024);
  private nextColumn = 0;
  private storedColumns = 0;
  private lastSampleMs = -Infinity;
  private latestSampleMs = 0;
  private timer: number | null = null;
  private frozen = false;
  private sampleRate = 48000;

  constructor(engine: AudioEngine) { this.engine = engine; }

  start() {
    if (this.timer !== null || typeof window === 'undefined') return;
    this.timer = window.setInterval(() => this.tick(performance.now(), this.engine.context?.currentTime ?? null), 1000 / SPECTRUM_SAMPLE_HZ / 2);
  }
  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
  setFrozen(frozen: boolean) { this.frozen = frozen; }
  isFrozen() { return this.frozen; }

  tick(timestampMs = typeof performance === 'undefined' ? Date.now() : performance.now(), audioTimeSeconds: number | null = this.engine.context?.currentTime ?? null) {
    if (this.frozen || timestampMs - this.lastSampleMs < 1000 / SPECTRUM_SAMPLE_HZ) return false;
    this.lastSampleMs = timestampMs;
    if (!this.engine.readOutputSpectrum(this.analyserBuffer)) return false;
    this.sampleRate = this.engine.context?.sampleRate ?? this.sampleRate;
    const bands = frequencyBands(this.sampleRate);
    const column = this.nextColumn;
    bands.forEach(({ firstBin, lastBin }, row) => {
      let level = SPECTRUM_MIN_DECIBELS;
      for (let bin = firstBin; bin <= lastBin; bin++) level = Math.max(level, this.analyserBuffer[bin] ?? SPECTRUM_MIN_DECIBELS);
      this.history[column * SPECTRUM_ROWS + row] = Math.min(1, Math.max(0, (level - SPECTRUM_MIN_DECIBELS) / (SPECTRUM_MAX_DECIBELS - SPECTRUM_MIN_DECIBELS)));
    });
    this.sampleTimes[column] = timestampMs;
    this.sampleAudioTimes[column] = audioTimeSeconds ?? NaN;
    this.latestSampleMs = timestampMs;
    this.nextColumn = (column + 1) % SPECTRUM_COLUMNS;
    this.storedColumns = Math.min(SPECTRUM_COLUMNS, this.storedColumns + 1);
    return true;
  }

  clear() {
    this.history.fill(0);
    this.sampleTimes.fill(0);
    this.sampleAudioTimes.fill(NaN);
    this.nextColumn = 0;
    this.storedColumns = 0;
    this.lastSampleMs = -Infinity;
  }
  sampleCount() { return this.storedColumns; }
  chronologicalIntensities() {
    const oldestColumn = this.storedColumns === SPECTRUM_COLUMNS ? this.nextColumn : 0;
    return Array.from({ length: this.storedColumns }, (_, index) => {
      const column = (oldestColumn + index) % SPECTRUM_COLUMNS;
      return Array.from({ length: SPECTRUM_ROWS }, (_, row) => this.history[column * SPECTRUM_ROWS + row]);
    });
  }
  snapshot(seconds = 10, includeIntensities = false, options: FrequencyHistorySnapshotOptions = {}): FrequencyHistorySnapshot {
    const requestedSeconds = Math.max(.25, Math.min(10, seconds ?? 10));
    const requestedColumns = Math.min(this.storedColumns, Math.ceil(requestedSeconds * SPECTRUM_SAMPLE_HZ));
    const oldestColumn = this.storedColumns === SPECTRUM_COLUMNS ? this.nextColumn : 0;
    const startIndex = this.storedColumns - requestedColumns;
    const maxSamples = options.maxSamples === undefined ? requestedColumns : Math.max(1, Math.min(requestedColumns || 1, Math.round(options.maxSamples)));
    const sampleIndexes = requestedColumns <= maxSamples
      ? Array.from({ length: requestedColumns }, (_, index) => startIndex + index)
      : Array.from({ length: maxSamples }, (_, index) => startIndex + Math.round(index * (requestedColumns - 1) / Math.max(1, maxSamples - 1)));
    const newestTime = this.latestSampleMs;
    const bands = frequencyBands(this.sampleRate);
    const selectedBands = (options.bandIndices?.length ? [...new Set(options.bandIndices)].filter((index) => index >= 0 && index < SPECTRUM_ROWS) : bands.map((_, index) => index));
    const samples = sampleIndexes.map((chronologicalIndex) => {
      const column = (oldestColumn + chronologicalIndex) % SPECTRUM_COLUMNS;
      const intensities = selectedBands.map((row) => Number(this.history[column * SPECTRUM_ROWS + row].toFixed(4)));
      const levelsDb = intensities.map((intensity) => Number((SPECTRUM_MIN_DECIBELS + intensity * (SPECTRUM_MAX_DECIBELS - SPECTRUM_MIN_DECIBELS)).toFixed(2)));
      const timestampMs = this.sampleTimes[column];
      const audioTime = this.sampleAudioTimes[column];
      return { ageSeconds: Number(Math.max(0, (newestTime - timestampMs) / 1000).toFixed(3)), timestampMs, audioTimeSeconds: Number.isFinite(audioTime) ? audioTime : null, ...(includeIntensities && !options.summaryOnly ? { intensities } : {}), levelsDb: options.summaryOnly ? [Math.max(...levelsDb, SPECTRUM_MIN_DECIBELS)] : levelsDb };
    });
    const allLevels = samples.flatMap((sample) => sample.levelsDb);
    const peakDb = allLevels.length ? Math.max(...allLevels) : SPECTRUM_MIN_DECIBELS;
    const rmsDb = allLevels.length ? 20 * Math.log10(Math.sqrt(allLevels.reduce((sum, db) => sum + Math.pow(10, db / 10), 0) / allLevels.length)) : SPECTRUM_MIN_DECIBELS;
    const returnedSpanSeconds = samples.length > 1 ? Math.max(0, (samples[0].timestampMs - samples[samples.length - 1].timestampMs) / -1000) : 0;
    return {
      description: 'Chronological FFT band samples. The first sample is oldest and the last sample is newest.',
      captureState: this.frozen ? 'frozen' : this.storedColumns === 0 ? 'empty' : 'scrolling',
      sampleRateHz: this.sampleRate,
      timeSpanSeconds: Number((SPECTRUM_COLUMNS / SPECTRUM_SAMPLE_HZ).toFixed(3)),
      requestedTimeSpanSeconds: Number(requestedSeconds.toFixed(3)),
      returnedTimeSpanSeconds: Number(returnedSpanSeconds.toFixed(3)),
      fftSize: 2048,
      valueRange: { intensity: [0, 1], decibels: [SPECTRUM_MIN_DECIBELS, SPECTRUM_MAX_DECIBELS] },
      frequencyRangeHz: [SPECTRUM_MIN_FREQUENCY, Math.min(SPECTRUM_MAX_FREQUENCY, this.sampleRate / 2)],
      bandsHz: selectedBands.map((index) => [Number(bands[index].lowHz.toFixed(3)), Number(bands[index].highHz.toFixed(3))]),
      samples,
      omitted: { samples: Math.max(0, requestedColumns - sampleIndexes.length), bands: SPECTRUM_ROWS - selectedBands.length, decimated: sampleIndexes.length < requestedColumns },
      ...(options.summaryOnly ? { summary: { peakDb: Number(peakDb.toFixed(2)), rmsDb: Number(rmsDb.toFixed(2)), sampleCount: samples.length } } : {}),
    };
  }
}
