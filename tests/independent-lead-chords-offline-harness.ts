import { IndependentLeadEngine } from '../src/synth/independent-lead.ts';
import { IndependentChordEngine } from '../src/synth/independent-chords.ts';
import { LEAD_PRESETS, leadEffectTailSeconds, normalizeLeadProfile } from '../src/synth/patches/lead.ts';
import { CHORD_PRESETS, chordEffectTailSeconds, normalizeChordProfile } from '../src/synth/patches/chords.ts';
import type { DeckSoundProfile } from '../src/deck.ts';

type BoundaryKind = 'onset' | 'note-off' | 'release-end';
type Boundary = {
  kind: BoundaryKind;
  audioTimeSeconds: number;
  sampleIndex: number;
  maxAdjacentSampleDelta: number;
  localMedianAdjacentDelta: number;
  localP95AdjacentDelta: number;
  boundaryThreshold: number;
  boundaryPassed: boolean;
  band2To8kRms: number;
  nearbyBandRms: number[];
  highBandThreshold: number;
  highBandPassed: boolean;
};
type RenderCase = {
  name: string;
  durationSeconds: number;
  sampleRate: number;
  finite: boolean;
  peakAbs: number;
  clippedSamples: number;
  effectTailExpected: boolean;
  effectTailPeak: number;
  effectTailObserved: boolean;
  requestedEvents: number;
  acceptedEvents: number;
  minimumOnsetEnergy: number;
  eventChecksPassed: boolean;
  postTailPeak: number;
  boundaries: Boundary[];
  boundaryChecksPassed: boolean;
  highBandChecksPassed: boolean;
  passed: boolean;
  declaredTailEndSeconds: number;
};
type SpectrumMetrics = { peak: number; rms: number; bands: Record<string, number> };
type Parity = {
  passed: boolean;
  thresholds: { levelRatio: number; coarseBandRatio: number };
  lead: { independent: SpectrumMetrics; reference: SpectrumMetrics; peakRatio: number; rmsRatio: number; coarseBandRatios: Record<string, number>; passed: boolean };
  chords: { independent: SpectrumMetrics; reference: SpectrumMetrics; peakRatio: number; rmsRatio: number; coarseBandRatios: Record<string, number>; passed: boolean };
};
type BoundarySpec = { kind: BoundaryKind; audioTimeSeconds: number };

const SAMPLE_RATE = 44_100;
const MASTER_GAIN = .38;
const RELEASE_SECONDS = .45;
const TAIL_SECONDS = .2;
const BOUNDARY_RADIUS = 6;
const EXCLUSION_RADIUS = 12;
const BASELINE_RADIUS = 96;
const BOUNDARY_RATIO = 6;
const BOUNDARY_ADDITIVE = .01;
const BOUNDARY_FLOOR = .015;
const HIGH_WINDOW = 512;
const HIGH_NEARBY = 1024;
const HIGH_RATIO = 4;
const HIGH_ADDITIVE = .001;
const HIGH_FLOOR = .0005;
const POST_TAIL_LIMIT = .02;
const EFFECT_TAIL_MINIMUM = 1e-6;
const MIN_ONSET_ENERGY = 1e-4;

export const INDEPENDENT_VOICE_THRESHOLDS = {
  clipping: 0,
  postTailPeak: POST_TAIL_LIMIT,
  boundary: { radiusSamples: BOUNDARY_RADIUS, exclusionRadiusSamples: EXCLUSION_RADIUS, baselineRadiusSamples: BASELINE_RADIUS, maxRatio: BOUNDARY_RATIO, additiveFloor: BOUNDARY_ADDITIVE, absoluteFloor: BOUNDARY_FLOOR },
  highBand: { windowSamples: HIGH_WINDOW, nearbyOffsetSamples: HIGH_NEARBY, maxRatio: HIGH_RATIO, additiveFloor: HIGH_ADDITIVE, absoluteFloor: HIGH_FLOOR },
  effectTail: { minimumObservedPeak: EFFECT_TAIL_MINIMUM },
  events: { minimumOnsetEnergy: MIN_ONSET_ENERGY },
};

const finite = (value: number) => Number.isFinite(value);
const percentile = (values: number[], fraction: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};

export const dftBandRms = (samples: Float32Array, center: number, sampleRate: number, lowHz = 2000, highHz = 8000, windowSamples = HIGH_WINDOW) => {
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
      const phase = 2 * Math.PI * frequency * (index - start) / sampleRate;
      const sample = samples[index] * window;
      real += sample * Math.cos(phase);
      imaginary -= sample * Math.sin(phase);
    }
    energy += (real * real + imaginary * imaginary) / Math.max(1, length * length);
  }
  return Math.sqrt(energy / 24);
};

const nearbyCenters = (center: number, length: number) => [...new Set([
  center - HIGH_NEARBY, center + HIGH_NEARBY,
  center - HIGH_NEARBY * 2, center + HIGH_NEARBY * 2,
].map((candidate) => Math.max(0, Math.min(length - 1, candidate))).filter((candidate) => Math.abs(candidate - center) > HIGH_WINDOW / 2 + BOUNDARY_RADIUS))].slice(0, 2);

export const boundaryMetric = (samples: Float32Array, audioTimeSeconds: number, sampleRate: number, kind: BoundaryKind): Boundary => {
  const center = Math.max(0, Math.min(samples.length - 1, Math.round(audioTimeSeconds * sampleRate)));
  const deltas: number[] = [];
  const baseline: number[] = [];
  for (let index = Math.max(1, center - BASELINE_RADIUS); index <= Math.min(samples.length - 1, center + BASELINE_RADIUS); index += 1) {
    const delta = Math.abs(samples[index] - samples[index - 1]);
    if (Math.abs(index - center) <= BOUNDARY_RADIUS) deltas.push(delta);
    if (Math.abs(index - center) > EXCLUSION_RADIUS) baseline.push(delta);
  }
  const localMedianAdjacentDelta = percentile(baseline, .5);
  const localP95AdjacentDelta = percentile(baseline, .95);
  const maxAdjacentSampleDelta = Math.max(...deltas, 0);
  const boundaryThreshold = Math.max(BOUNDARY_FLOOR, localP95AdjacentDelta * BOUNDARY_RATIO + BOUNDARY_ADDITIVE);
  const nearbyBandRms = nearbyCenters(center, samples.length).map((nearby) => dftBandRms(samples, nearby, sampleRate));
  const highBandThreshold = Math.max(HIGH_FLOOR, Math.max(...nearbyBandRms, 0) * HIGH_RATIO + HIGH_ADDITIVE);
  const band2To8kRms = dftBandRms(samples, center, sampleRate);
  return { kind, audioTimeSeconds, sampleIndex: center, maxAdjacentSampleDelta, localMedianAdjacentDelta, localP95AdjacentDelta, boundaryThreshold, boundaryPassed: maxAdjacentSampleDelta <= boundaryThreshold, band2To8kRms, nearbyBandRms, highBandThreshold, highBandPassed: band2To8kRms <= highBandThreshold };
};

const silentEffectsLead = (): DeckSoundProfile => ({
  ...LEAD_PRESETS[1],
  controls: { ...LEAD_PRESETS[1].controls, echo: 0 },
  parameters: { ...LEAD_PRESETS[1].parameters, echoMs: 0, echoFeedback: 0, chorusMix: 0 },
});
const silentEffectsChord = (): DeckSoundProfile => ({
  ...CHORD_PRESETS[1],
  controls: { ...CHORD_PRESETS[1].controls, space: 0 },
  parameters: { ...CHORD_PRESETS[1].parameters, delayMs: 0, chorusMs: 0 },
});

type RenderSetupResult = {
  boundaries: BoundarySpec[];
  tailEndSeconds?: number;
  effectTailExpected?: boolean;
  requestedEvents?: number;
  acceptedEvents?: number;
  onsetTimes?: number[];
};
type RenderSetup = (context: OfflineAudioContext, master: GainNode) => RenderSetupResult;

const renderCase = async (name: string, durationSeconds: number, setup: RenderSetup): Promise<RenderCase> => {
  const context = new OfflineAudioContext(1, Math.ceil(durationSeconds * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(context.destination);
  const setupResult = setup(context, master);
  const boundarySpecs = setupResult.boundaries;
  const rendered = await context.startRendering();
  const samples = rendered.getChannelData(0);
  const boundaries = boundarySpecs.map((boundary) => boundaryMetric(samples, boundary.audioTimeSeconds, SAMPLE_RATE, boundary.kind));
  let peakAbs = 0;
  let clippedSamples = 0;
  let allFinite = true;
  for (const sample of samples) {
    allFinite &&= finite(sample);
    peakAbs = Math.max(peakAbs, Math.abs(sample));
    if (Math.abs(sample) >= 1) clippedSamples += 1;
  }
  const lastBoundary = Math.max(...boundaries.map((boundary) => boundary.audioTimeSeconds), 0);
  const releaseEnd = Math.max(...boundaries.filter((boundary) => boundary.kind === 'release-end').map((boundary) => boundary.audioTimeSeconds), lastBoundary);
  const tailEndSeconds = Math.max(lastBoundary, setupResult.tailEndSeconds ?? lastBoundary);
  const tailStart = Math.min(samples.length, Math.round(releaseEnd * SAMPLE_RATE));
  const declaredTailEnd = Math.min(samples.length, Math.round(tailEndSeconds * SAMPLE_RATE));
  let effectTailPeak = 0;
  for (let index = tailStart; index < declaredTailEnd; index += 1) effectTailPeak = Math.max(effectTailPeak, Math.abs(samples[index]));
  const effectTailExpected = setupResult.effectTailExpected === true;
  const effectTailObserved = !effectTailExpected || effectTailPeak >= EFFECT_TAIL_MINIMUM;
  const requestedEvents = setupResult.requestedEvents ?? 0;
  const acceptedEvents = setupResult.acceptedEvents ?? requestedEvents;
  const onsetTimes = setupResult.onsetTimes ?? [];
  const onsetEnergies = onsetTimes.map((onset) => {
    const start = Math.max(0, Math.round(onset * SAMPLE_RATE));
    const end = Math.min(samples.length, start + Math.round(.06 * SAMPLE_RATE));
    let peak = 0;
    for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
    return peak;
  });
  const minimumOnsetEnergy = onsetEnergies.length > 0 ? Math.min(...onsetEnergies) : 0;
  const eventChecksPassed = acceptedEvents === requestedEvents && (requestedEvents === 0 || minimumOnsetEnergy >= MIN_ONSET_ENERGY);
  let postTailPeak = 0;
  for (let index = declaredTailEnd; index < samples.length; index += 1) postTailPeak = Math.max(postTailPeak, Math.abs(samples[index]));
  const boundaryChecksPassed = boundaries.every((boundary) => boundary.boundaryPassed);
  const highBandChecksPassed = boundaries.every((boundary) => boundary.highBandPassed);
  const passed = allFinite && clippedSamples === 0 && postTailPeak <= POST_TAIL_LIMIT && effectTailObserved && eventChecksPassed && boundaryChecksPassed && highBandChecksPassed;
  return { name, durationSeconds, sampleRate: SAMPLE_RATE, finite: allFinite, peakAbs, clippedSamples, effectTailExpected, effectTailPeak, effectTailObserved, requestedEvents, acceptedEvents, minimumOnsetEnergy, eventChecksPassed, postTailPeak, boundaries, boundaryChecksPassed, highBandChecksPassed, passed, declaredTailEndSeconds: tailEndSeconds };
};

const voiceBoundaries = (start: number, gate: number, release = RELEASE_SECONDS) => [
  { kind: 'onset' as const, audioTimeSeconds: start },
  { kind: 'note-off' as const, audioTimeSeconds: start + gate },
  { kind: 'release-end' as const, audioTimeSeconds: start + gate + release },
];

const renderLeadRepeats = () => renderCase('lead-repeats-0-1-5-10-20-50-100ms', 2.6, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = silentEffectsLead();
  const gaps = [0, .001, .005, .01, .02, .05, .1];
  const boundaries: BoundarySpec[] = [];
  gaps.forEach((gap, index) => {
    const start = .1 + gap + index * .24;
    const gate = .11;
    engine.note(60 + index, gate, start, profile, 'deckA', .7);
    boundaries.push(...voiceBoundaries(start, gate));
  });
  return { boundaries };
});

const renderLeadSustain = () => renderCase('lead-sustained-live-equivalent', 2.1, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = silentEffectsLead();
  engine.note(69, 1.1, .1, profile, 'deckA', 1);
  return { boundaries: voiceBoundaries(.1, 1.1) };
});

const renderLeadReleaseStages = () => renderCase('lead-release-during-attack-decay-sustain', 2.9, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = silentEffectsLead();
  const gates = [.005, .05, .8];
  const boundaries: BoundarySpec[] = [];
  gates.forEach((gate, index) => {
    const start = .1 + index * .8;
    engine.note(60 + index * 2, gate, start, profile, 'deckA', .8);
    boundaries.push(...voiceBoundaries(start, gate));
  });
  return { boundaries };
});

const renderChordRepeats = () => renderCase('chords-repeated-and-overlapping', 2.6, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = silentEffectsChord();
  const boundaries: BoundarySpec[] = [];
  [.1, .25, .4].forEach((start) => {
    const gate = .11;
    engine.chord([48, 52, 55, 59], gate, start, profile, 'deckA', .8);
    boundaries.push(...voiceBoundaries(start, gate, .52));
  });
  engine.chord([50, 53, 57, 60], .35, .65, profile, 'deckA', .8);
  boundaries.push(...voiceBoundaries(.65, .35, .52));
  return { boundaries };
});

const renderLeadStress = () => renderCase('lead-four-bar-deck-stress', 8.8, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = silentEffectsLead();
  const boundaries: BoundarySpec[] = [];
  const onsetTimes: number[] = [];
  let acceptedEvents = 0;
  for (let index = 0; index < 32; index += 1) {
    const start = index * .25;
    const gate = .111;
    onsetTimes.push(start);
    if (engine.note(48 + index % 8, gate, start, profile, 'deckA', .8).length > 0) acceptedEvents += 1;
    if (index < 3 || index > 28) boundaries.push(...voiceBoundaries(start, gate));
  }
  return { boundaries, requestedEvents: 32, acceptedEvents, onsetTimes };
});

const renderChordStress = () => renderCase('chords-four-bar-deck-stress', 8.8, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = silentEffectsChord();
  const boundaries: BoundarySpec[] = [];
  const onsetTimes: number[] = [];
  let acceptedEvents = 0;
  for (let index = 0; index < 32; index += 1) {
    const start = index * .25;
    const gate = .111;
    onsetTimes.push(start);
    if (engine.chord([48 + index % 3, 52 + index % 3, 55 + index % 3], gate, start, profile, 'deckA', .65).length > 0) acceptedEvents += 1;
    if (index < 3 || index > 28) boundaries.push(...voiceBoundaries(start, gate, .52));
  }
  return { boundaries, requestedEvents: 32, acceptedEvents, onsetTimes };
});

const renderChordReleaseStages = () => renderCase('chords-release-during-attack-decay-sustain', 3.1, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = silentEffectsChord();
  const gates = [.005, .1, .5];
  const boundaries: BoundarySpec[] = [];
  gates.forEach((gate, index) => {
    const start = .1 + index * .9;
    engine.chord([48 + index, 52 + index, 55 + index], gate, start, profile, 'deckA', .7);
    boundaries.push(...voiceBoundaries(start, gate, .52));
  });
  return { boundaries };
});

const chorusOnlyStrings = (): DeckSoundProfile => ({
  ...LEAD_PRESETS[6],
  controls: { ...LEAD_PRESETS[6].controls, echo: 0 },
  parameters: { ...LEAD_PRESETS[6].parameters, echoMs: 0, echoFeedback: 0 },
});

const renderLeadEcho = () => renderCase('lead-feedback-echo', 5.1, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = LEAD_PRESETS[5];
  engine.note(60, .25, .1, profile, 'deckA', .8);
  const patch = normalizeLeadProfile(profile, SAMPLE_RATE);
  const boundaries = voiceBoundaries(.1, .25, patch.releaseSeconds);
  return { boundaries, tailEndSeconds: boundaries.at(-1)!.audioTimeSeconds + leadEffectTailSeconds(patch), effectTailExpected: true };
});

const renderLeadStrings = () => renderCase('lead-strings-chorus', 2.4, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = chorusOnlyStrings();
  engine.note(60, .25, .1, profile, 'deckA', .8);
  const patch = normalizeLeadProfile(profile, SAMPLE_RATE);
  const boundaries = voiceBoundaries(.1, .25, patch.releaseSeconds);
  return { boundaries, tailEndSeconds: boundaries.at(-1)!.audioTimeSeconds + leadEffectTailSeconds(patch), effectTailExpected: true };
});

const renderChordSpace = () => renderCase('chords-space-delay', 3.4, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = CHORD_PRESETS[0];
  engine.chord([48, 52, 55, 59], .25, .1, profile, 'deckA', .7);
  const patch = normalizeChordProfile(profile, SAMPLE_RATE);
  const boundaries = voiceBoundaries(.1, .25, patch.releaseSeconds);
  return { boundaries, tailEndSeconds: boundaries.at(-1)!.audioTimeSeconds + chordEffectTailSeconds(patch), effectTailExpected: true };
});

const renderChordWideSaw = () => renderCase('chords-wide-saw-chorus-delay', 3.6, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = CHORD_PRESETS[5];
  engine.chord([48, 52, 55, 59], .25, .1, profile, 'deckA', .65);
  const patch = normalizeChordProfile(profile, SAMPLE_RATE);
  const boundaries = voiceBoundaries(.1, .25, patch.releaseSeconds);
  return { boundaries, tailEndSeconds: boundaries.at(-1)!.audioTimeSeconds + chordEffectTailSeconds(patch), effectTailExpected: true };
});

const renderLeadEffectStress = () => renderCase('lead-airy-four-bar-effect-stress', 12.5, (context, master) => {
  const engine = new IndependentLeadEngine({ context, destination: master });
  const profile = LEAD_PRESETS[5];
  const patch = normalizeLeadProfile(profile, SAMPLE_RATE);
  const boundaries: BoundarySpec[] = [];
  const onsetTimes: number[] = [];
  let acceptedEvents = 0;
  for (let index = 0; index < 32; index += 1) {
    const start = index * .25;
    onsetTimes.push(start);
    if (engine.note(48 + index % 8, .111, start, profile, 'deckA', .8).length > 0) acceptedEvents += 1;
    if (index < 2 || index > 29) boundaries.push(...voiceBoundaries(start, .111, patch.releaseSeconds));
  }
  const lastReleaseEnd = 7.75 + .111 + patch.releaseSeconds;
  return { boundaries, tailEndSeconds: lastReleaseEnd + leadEffectTailSeconds(patch), effectTailExpected: true, requestedEvents: 32, acceptedEvents, onsetTimes };
});

const renderChordEffectStress = () => renderCase('chords-wide-saw-four-bar-effect-stress', 10.2, (context, master) => {
  const engine = new IndependentChordEngine({ context, destination: master });
  const profile = CHORD_PRESETS[5];
  const patch = normalizeChordProfile(profile, SAMPLE_RATE);
  const boundaries: BoundarySpec[] = [];
  const onsetTimes: number[] = [];
  let acceptedEvents = 0;
  for (let index = 0; index < 32; index += 1) {
    const start = index * .25;
    onsetTimes.push(start);
    if (engine.chord([48 + index % 3, 52 + index % 3, 55 + index % 3], .111, start, profile, 'deckA', .65).length > 0) acceptedEvents += 1;
    if (index < 2 || index > 29) boundaries.push(...voiceBoundaries(start, .111, patch.releaseSeconds));
  }
  const lastReleaseEnd = 7.75 + .111 + patch.releaseSeconds;
  return { boundaries, tailEndSeconds: lastReleaseEnd + chordEffectTailSeconds(patch), effectTailExpected: true, requestedEvents: 32, acceptedEvents, onsetTimes };
});

// Compare the shared note body before note-off. Effect tails have their own
// rendered checks above, so delayed energy does not distort level parity.
const spectrumMetrics = (samples: Float32Array, measurementStartSeconds = .12, measurementEndSeconds = .30): SpectrumMetrics => {
  let peak = 0;
  let square = 0;
  const start = Math.max(0, Math.min(samples.length, Math.round(measurementStartSeconds * SAMPLE_RATE)));
  const end = Math.max(start + 1, Math.min(samples.length, Math.round(measurementEndSeconds * SAMPLE_RATE)));
  for (let index = start; index < end; index += 1) { const sample = samples[index]; peak = Math.max(peak, Math.abs(sample)); square += sample * sample; }
  const center = Math.round((measurementStartSeconds + measurementEndSeconds) * .5 * SAMPLE_RATE);
  const bands = {
    '20-200': dftBandRms(samples, center, SAMPLE_RATE, 20, 200),
    '200-1000': dftBandRms(samples, center, SAMPLE_RATE, 200, 1000),
    '1000-4000': dftBandRms(samples, center, SAMPLE_RATE, 1000, 4000),
  };
  return { peak, rms: Math.sqrt(square / Math.max(1, end - start)), bands };
};

const ratio = (left: number, right: number) => Math.max(left, right) / Math.max(1e-7, Math.min(left, right));

const scheduleLegacyAdsr = (gain: GainNode, peak: number, patch: { attackSeconds: number; decaySeconds: number; sustain: number; releaseSeconds: number }, start: number, gate: number) => {
  const attack = Math.min(patch.attackSeconds, gate * .35);
  const decay = Math.min(patch.decaySeconds, Math.max(0, gate - attack));
  const attackAt = start + attack;
  const decayAt = attackAt + decay;
  const releaseAt = start + gate;
  gain.gain.setValueAtTime(.0001, start);
  if (attack > 0) gain.gain.exponentialRampToValueAtTime(peak, attackAt);
  else gain.gain.setValueAtTime(peak, start);
  if (decay > 0) gain.gain.exponentialRampToValueAtTime(peak * patch.sustain, decayAt);
  else gain.gain.setValueAtTime(peak * patch.sustain, decayAt);
  gain.gain.cancelAndHoldAtTime(releaseAt);
  gain.gain.exponentialRampToValueAtTime(.0001, releaseAt + patch.releaseSeconds);
};

const addLegacyLeadChorus = (context: OfflineAudioContext, input: AudioNode, output: AudioNode, patch: ReturnType<typeof normalizeLeadProfile>, start: number, end: number) => {
  if (patch.chorusMix <= 0 || patch.chorusDelaySeconds <= 0) { input.connect(output); return; }
  const dry = context.createGain();
  dry.gain.value = 1 - patch.chorusMix * .35;
  input.connect(dry).connect(output);
  const taps = [
    { delay: patch.chorusDelaySeconds, depth: patch.chorusDepthSeconds, rate: patch.chorusRateHz },
    { delay: Math.min(.09, patch.chorusDelaySeconds * 1.55), depth: patch.chorusDepthSeconds * .82, rate: patch.chorusRateHz * 1.17 },
    { delay: Math.min(.09, patch.chorusDelaySeconds * .72), depth: patch.chorusDepthSeconds * .62, rate: patch.chorusRateHz * .83 },
  ];
  taps.forEach((tap) => {
    const delay = context.createDelay(.1); const wet = context.createGain(); const lfo = context.createOscillator(); const depth = context.createGain();
    wet.gain.value = patch.chorusMix / taps.length;
    delay.delayTime.setValueAtTime(tap.delay, start);
    lfo.frequency.setValueAtTime(tap.rate, start);
    depth.gain.setValueAtTime(Math.min(tap.depth, tap.delay * .9), start);
    input.connect(delay).connect(wet).connect(output);
    lfo.connect(depth).connect(delay.delayTime);
    lfo.start(start); lfo.stop(end + .05);
  });
};

const addLegacyLeadEcho = (context: OfflineAudioContext, input: AudioNode, output: AudioNode, patch: ReturnType<typeof normalizeLeadProfile>, profile: DeckSoundProfile, start: number, end: number) => {
  if (patch.echoSeconds <= 0 || (profile.controls.echo ?? .15) <= 0) return;
  const echo = context.createDelay(1.2); const wet = context.createGain(); const feedback = context.createGain();
  echo.delayTime.setValueAtTime(patch.echoSeconds, start);
  wet.gain.value = (profile.controls.echo ?? .15) * .35;
  feedback.gain.value = patch.echoFeedback;
  input.connect(echo).connect(wet).connect(output);
  echo.connect(feedback).connect(echo);
  feedback.gain.setValueAtTime(patch.echoFeedback, end);
  feedback.gain.linearRampToValueAtTime(0, end + leadEffectTailSeconds(patch));
  wet.gain.setValueAtTime(wet.gain.value, end);
  wet.gain.linearRampToValueAtTime(0, end + leadEffectTailSeconds(patch));
};

const renderReferenceLead = async (profile: DeckSoundProfile) => {
  const patch = normalizeLeadProfile(profile, SAMPLE_RATE);
  const start = .1; const gate = .25; const tailEnd = start + gate + patch.releaseSeconds + leadEffectTailSeconds(patch);
  const context = new OfflineAudioContext(1, Math.ceil((tailEnd + .2) * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain(); master.gain.value = MASTER_GAIN; master.connect(context.destination);
  const bus = context.createGain(); bus.gain.value = profile.volume; bus.connect(master);
  const input = context.createGain(); const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = patch.filterHz; input.connect(filter);
  const filtered = context.createGain(); filter.connect(filtered); addLegacyLeadChorus(context, filtered, bus, patch, start, start + gate + patch.releaseSeconds);
  addLegacyLeadEcho(context, input, bus, patch, profile, start, start + gate + patch.releaseSeconds);
  const frequency = 440 * Math.pow(2, (60 - 69) / 12);
  for (const [amount, detune] of [[.46, 0], [.2, patch.detuneCents]] as const) {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = patch.type; oscillator.frequency.setValueAtTime(frequency * Math.pow(2, detune / 1200), start);
    scheduleLegacyAdsr(gain, amount, patch, start, gate);
    oscillator.connect(gain).connect(input); oscillator.start(start); oscillator.stop(start + gate + patch.releaseSeconds + .03);
  }
  const rendered = await context.startRendering();
  return spectrumMetrics(rendered.getChannelData(0));
};

const addLegacyChordEffects = (context: OfflineAudioContext, input: AudioNode, output: AudioNode, patch: ReturnType<typeof normalizeChordProfile>, profile: DeckSoundProfile, start: number, end: number) => {
  input.connect(output);
  const space = Math.max(0, Math.min(1, profile.controls.space ?? .25));
  if (patch.delaySeconds > 0 && space > 0) {
    const delay = context.createDelay(1); const wet = context.createGain(); delay.delayTime.setValueAtTime(patch.delaySeconds, start); wet.gain.value = space * .22;
    input.connect(delay).connect(wet).connect(output); wet.gain.setValueAtTime(wet.gain.value, end); wet.gain.linearRampToValueAtTime(0, end + patch.delaySeconds + .05);
  }
  if (patch.chorusSeconds > 0 && space > 0) {
    const chorus = context.createDelay(.1); const wet = context.createGain(); chorus.delayTime.setValueAtTime(patch.chorusSeconds, start); wet.gain.value = Math.min(.3, patch.chorusSeconds * 100);
    input.connect(chorus).connect(wet).connect(output); wet.gain.setValueAtTime(wet.gain.value, end); wet.gain.linearRampToValueAtTime(0, end + patch.chorusSeconds + .05);
  }
};

const renderReferenceChords = async (profile: DeckSoundProfile) => {
  const patch = normalizeChordProfile(profile, SAMPLE_RATE);
  const start = .1; const gate = .25; const tailEnd = start + gate + patch.releaseSeconds + chordEffectTailSeconds(patch);
  const context = new OfflineAudioContext(1, Math.ceil((tailEnd + .2) * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain(); master.gain.value = MASTER_GAIN; master.connect(context.destination);
  const bus = context.createGain(); bus.gain.value = profile.volume; bus.connect(master);
  const input = context.createGain(); const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = patch.filterHz; input.connect(filter);
  const filtered = context.createGain(); filter.connect(filtered); addLegacyChordEffects(context, filtered, bus, patch, profile, start, start + gate + patch.releaseSeconds);
  const detuneDelta = patch.detuneCents / 1200;
  const layers: Array<[number, number, OscillatorType]> = [[.22, 1 - detuneDelta, patch.type], [.2 * patch.oscillatorMix, 1 + detuneDelta, patch.type], [.12 * patch.harmonicLevel, 2, 'sine']];
  for (const midi of [48, 52, 55, 59]) {
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    for (const [amount, multiplier, type] of layers) {
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.type = type; oscillator.frequency.setValueAtTime(frequency * multiplier, start);
      scheduleLegacyAdsr(gain, amount, patch, start, gate);
      oscillator.connect(gain).connect(input); oscillator.start(start); oscillator.stop(start + gate + patch.releaseSeconds + .03);
    }
  }
  const rendered = await context.startRendering();
  return spectrumMetrics(rendered.getChannelData(0));
};

const renderIndependentLeadMetrics = async (profile: DeckSoundProfile) => {
  const patch = normalizeLeadProfile(profile, SAMPLE_RATE);
  const duration = Math.max(.9, .1 + .25 + patch.releaseSeconds + leadEffectTailSeconds(patch) + .2);
  const context = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain(); master.gain.value = MASTER_GAIN; master.connect(context.destination);
  const engine = new IndependentLeadEngine({ context, destination: master });
  engine.note(60, .25, .1, profile, 'deckA', 1);
  const rendered = await context.startRendering();
  return spectrumMetrics(rendered.getChannelData(0));
};

const renderIndependentChordMetrics = async (profile: DeckSoundProfile) => {
  const patch = normalizeChordProfile(profile, SAMPLE_RATE);
  const duration = Math.max(1.1, .1 + .25 + patch.releaseSeconds + chordEffectTailSeconds(patch) + .2);
  const context = new OfflineAudioContext(1, Math.ceil(duration * SAMPLE_RATE), SAMPLE_RATE);
  const master = context.createGain(); master.gain.value = MASTER_GAIN; master.connect(context.destination);
  const engine = new IndependentChordEngine({ context, destination: master });
  engine.chord([48, 52, 55, 59], .25, .1, profile, 'deckA', 1);
  const rendered = await context.startRendering();
  return spectrumMetrics(rendered.getChannelData(0));
};

const renderParity = async (): Promise<Parity> => {
  const leadProfiles = [silentEffectsLead(), LEAD_PRESETS[5]];
  const chordProfiles = [silentEffectsChord(), CHORD_PRESETS[5]];
  const leadPairs = await Promise.all(leadProfiles.map(async (profile) => ({ independent: await renderIndependentLeadMetrics(profile), reference: await renderReferenceLead(profile), profileId: profile.presetId })));
  const chordPairs = await Promise.all(chordProfiles.map(async (profile) => ({ independent: await renderIndependentChordMetrics(profile), reference: await renderReferenceChords(profile), profileId: profile.presetId })));
  const thresholds = { levelRatio: 1.25, coarseBandRatio: 1.5 };
  const compare = (independent: SpectrumMetrics, reference: SpectrumMetrics) => {
    const coarseBandRatios = Object.fromEntries(Object.keys(independent.bands).map((key) => [key, ratio(independent.bands[key], reference.bands[key])]));
    const peakRatio = ratio(independent.peak, reference.peak);
    const rmsRatio = ratio(independent.rms, reference.rms);
    const passed = peakRatio <= thresholds.levelRatio && rmsRatio <= thresholds.levelRatio && Object.values(coarseBandRatios).every((value) => value <= thresholds.coarseBandRatio);
    return { independent, reference, peakRatio, rmsRatio, coarseBandRatios, passed };
  };
  const combine = (pairs: Array<{ independent: SpectrumMetrics; reference: SpectrumMetrics; profileId: string }>) => {
    const results = pairs.map((pair) => ({ profileId: pair.profileId, ...compare(pair.independent, pair.reference) }));
    return { ...results[0], cases: results, passed: results.every((item) => item.passed) };
  };
  const lead = combine(leadPairs);
  const chords = combine(chordPairs);
  return { passed: lead.passed && chords.passed, thresholds, lead, chords };
};

const detectorSelfTest = () => {
  const samples = new Float32Array(4096);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index * .05) * .01;
  // A short alternating burst has both a boundary step and broadband energy;
  // a single sample can be rejected by the high-band windowing itself.
  for (let index = 2044; index <= 2052; index += 1) samples[index] = index % 2 === 0 ? .5 : -.5;
  const metric = boundaryMetric(samples, 2048 / SAMPLE_RATE, SAMPLE_RATE, 'note-off');
  return { detected: !metric.boundaryPassed || !metric.highBandPassed, boundaryPassed: metric.boundaryPassed, highBandPassed: metric.highBandPassed, observedDelta: metric.maxAdjacentSampleDelta, boundaryThreshold: metric.boundaryThreshold, highBandObserved: metric.band2To8kRms, highBandThreshold: metric.highBandThreshold };
};

export const runIndependentLeadChordsOfflineHarness = async () => {
  const cases = [
    await renderLeadRepeats(), await renderLeadSustain(), await renderLeadReleaseStages(),
    await renderChordRepeats(), await renderChordReleaseStages(),
    await renderLeadStress(), await renderChordStress(),
    await renderLeadEcho(), await renderLeadStrings(), await renderChordSpace(), await renderChordWideSaw(),
    await renderLeadEffectStress(), await renderChordEffectStress(),
  ];
  const selfTest = detectorSelfTest();
  const parity = await renderParity();
  const failureReasons = cases.flatMap((item) => item.passed ? [] : [item.name]);
  if (!parity.passed) failureReasons.push('legacy-equivalent-parity');
  const report = { status: failureReasons.length === 0 && selfTest.detected ? 'passed' as const : 'failed' as const, sampleRate: SAMPLE_RATE, thresholds: INDEPENDENT_VOICE_THRESHOLDS, detectorSelfTest: selfTest, parity, cases, failureReasons };
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify(report, null, 2);
  return report;
};

if (typeof document !== 'undefined') runIndependentLeadChordsOfflineHarness().catch((error) => {
  const output = document.querySelector('pre');
  if (output) output.textContent = JSON.stringify({ status: 'failed', error: String(error) }, null, 2);
});
