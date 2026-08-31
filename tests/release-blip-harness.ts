import { IndependentBassEngine } from '../src/synth/independent-bass.ts';
import { IndependentLeadEngine } from '../src/synth/independent-lead.ts';
import { IndependentChordEngine } from '../src/synth/independent-chords.ts';
import { BASS_PRESETS } from '../src/synth/patches/bass.ts';
import { LEAD_PRESETS, leadEffectTailSeconds, normalizeLeadProfile } from '../src/synth/patches/lead.ts';
import { CHORD_PRESETS, chordEffectTailSeconds, normalizeChordProfile } from '../src/synth/patches/chords.ts';
import { smoothstepCurve } from '../src/synth/envelope.ts';
import { sourceStopGuardSeconds } from '../src/synth/voice.ts';
import { DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS, measureReleaseBoundary, releaseDiagnosticSelfTest, type ReleaseBoundaryMetric } from '../src/synth/release-diagnostic.ts';
import type { DeckSoundProfile } from '../src/deck.ts';

type Instrument = 'bass' | 'lead' | 'chords';
type ReleaseStage = 'attack' | 'decay' | 'sustain';
type RenderCase = {
  name: string;
  instrument: Instrument;
  stage: ReleaseStage;
  sampleRate: number;
  durationSeconds: number;
  finite: boolean;
  clippedSamples: number;
  peakAbs: number;
  postStopPeak: number;
  boundaries: ReleaseBoundaryMetric[];
  effectProfileId?: string;
  effectTailSeconds?: number;
  effectTailStartPeak?: number;
  effectTailEndPeak?: number;
  postTailPeak?: number;
  effectTailObserved?: boolean;
  effectTailPassed?: boolean;
  passed: boolean;
  failureReasons: string[];
};

type EffectTailReference = {
  mode: 'lead' | 'chords';
  profile: DeckSoundProfile;
  tailSeconds: number;
};

type EnvelopeReference = {
  mode: 'linear' | 'smoothstep';
  releaseAt: number;
  releaseEnd: number;
  boundaries: ReleaseBoundaryMetric[];
  peakAbs: number;
};

const SAMPLE_RATE = 44_100;
const MASTER_GAIN = .38;
const TAIL_SECONDS = .12;
const POST_STOP_LIMIT = .00002;
const EFFECT_TAIL_LIMIT = .00002;
const EFFECT_TAIL_MINIMUM = .000001;
const instruments: Instrument[] = ['bass', 'lead', 'chords'];
const stages: ReleaseStage[] = ['attack', 'decay', 'sustain'];

const silentLead = (): DeckSoundProfile => ({ ...LEAD_PRESETS[1], controls: { ...LEAD_PRESETS[1].controls, echo: 0 }, parameters: { ...LEAD_PRESETS[1].parameters, echoMs: 0, echoFeedback: 0, chorusMix: 0 } });
const silentChords = (): DeckSoundProfile => ({ ...CHORD_PRESETS[1], controls: { ...CHORD_PRESETS[1].controls, space: 0 }, parameters: { ...CHORD_PRESETS[1].parameters, delayMs: 0, chorusMs: 0 } });

const releaseFor = (instrument: Instrument) => instrument === 'bass' ? .5 : instrument === 'lead' ? .45 : .52;
const gateFor = (instrument: Instrument, stage: ReleaseStage) => {
  if (stage === 'attack') return instrument === 'chords' ? .03 : .002;
  if (stage === 'decay') return instrument === 'chords' ? .42 : instrument === 'bass' ? .02 : .05;
  return instrument === 'chords' ? .8 : .2;
};

const outputFor = (context: OfflineAudioContext) => {
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(context.destination);
  return master;
};

const boundaryTimes = (start: number, gate: number, release: number, sampleRate: number) => {
  const releaseEnd = start + gate + release;
  const stop = releaseEnd + sourceStopGuardSeconds(sampleRate);
  return [
    { kind: 'release-start' as const, time: start + gate },
    { kind: 'release-end' as const, time: releaseEnd },
    { kind: 'source-stop' as const, time: stop },
  ];
};

const peakWindow = (samples: Float32Array, centerSeconds: number, sampleRate: number, radiusSamples = 512) => {
  const center = Math.round(centerSeconds * sampleRate);
  const start = Math.max(0, center - radiusSamples);
  const end = Math.min(samples.length, center + radiusSamples);
  let peak = 0;
  for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  return peak;
};

const renderCase = async (instrument: Instrument, stage: ReleaseStage, effect?: EffectTailReference): Promise<RenderCase> => {
  const start = .2;
  const gate = gateFor(instrument, stage);
  const patch = effect?.mode === 'lead'
    ? normalizeLeadProfile(effect.profile, SAMPLE_RATE)
    : effect?.mode === 'chords'
      ? normalizeChordProfile(effect.profile, SAMPLE_RATE)
      : null;
  const release = patch?.releaseSeconds ?? releaseFor(instrument);
  const effectTailSeconds = effect?.tailSeconds ?? 0;
  const releaseEnd = start + gate + release;
  const sourceStop = releaseEnd + sourceStopGuardSeconds(SAMPLE_RATE);
  const tailEnd = releaseEnd + effectTailSeconds;
  const durationSeconds = Math.max(sourceStop, tailEnd) + TAIL_SECONDS;
  const context = new OfflineAudioContext(1, Math.ceil(durationSeconds * SAMPLE_RATE), SAMPLE_RATE);
  const master = outputFor(context);
  let accepted = false;
  const profile = effect?.profile ?? (instrument === 'bass' ? BASS_PRESETS[0] : instrument === 'lead' ? silentLead() : silentChords());
  if (instrument === 'bass') accepted = new IndependentBassEngine({ context, destination: master }).note(36, gate, start, profile, 'deckA', 1).length > 0;
  if (instrument === 'lead') accepted = new IndependentLeadEngine({ context, destination: master }).note(60, gate, start, profile, 'deckA', 1).length > 0;
  if (instrument === 'chords') accepted = new IndependentChordEngine({ context, destination: master }).chord([48, 52, 55, 59], gate, start, profile, 'deckA', 1).length > 0;
  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  const boundaries = boundaryTimes(start, gate, release, SAMPLE_RATE).map(({ kind, time }) => measureReleaseBoundary(samples, time, SAMPLE_RATE, kind));
  let peakAbs = 0;
  let clippedSamples = 0;
  let finite = accepted;
  for (const sample of samples) {
    finite &&= Number.isFinite(sample);
    peakAbs = Math.max(peakAbs, Math.abs(sample));
    if (Math.abs(sample) >= 1) clippedSamples += 1;
  }
  const stopIndex = Math.min(samples.length, Math.round(sourceStop * SAMPLE_RATE));
  let postStopPeak = 0;
  for (let index = stopIndex; index < samples.length; index += 1) postStopPeak = Math.max(postStopPeak, Math.abs(samples[index]));
  const effectTailStartPeak = effectTailSeconds > 0 ? peakWindow(samples, releaseEnd, SAMPLE_RATE) : undefined;
  const effectTailEndPeak = effectTailSeconds > 0 ? peakWindow(samples, tailEnd, SAMPLE_RATE) : undefined;
  const postTailStart = Math.min(samples.length, Math.round((tailEnd + TAIL_SECONDS / 2) * SAMPLE_RATE));
  let postTailPeak = 0;
  for (let index = postTailStart; index < samples.length; index += 1) postTailPeak = Math.max(postTailPeak, Math.abs(samples[index]));
  const effectTailObserved = effectTailSeconds > 0 && (effectTailStartPeak ?? 0) >= EFFECT_TAIL_MINIMUM;
  const effectTailPassed = effectTailSeconds <= 0 || (
    effectTailObserved &&
    (effectTailEndPeak ?? Number.POSITIVE_INFINITY) <= EFFECT_TAIL_LIMIT &&
    postTailPeak <= EFFECT_TAIL_LIMIT
  );
  const failureReasons: string[] = [];
  if (!accepted) failureReasons.push('voice allocation returned no source');
  if (!finite) failureReasons.push('non-finite PCM');
  if (clippedSamples > 0) failureReasons.push(`clipped samples: ${clippedSamples}`);
  if (!effect && postStopPeak > POST_STOP_LIMIT) failureReasons.push(`post-stop peak ${postStopPeak}`);
  if (!effectTailPassed) failureReasons.push(`effect tail did not drain below ${EFFECT_TAIL_LIMIT}`);
  for (const boundary of boundaries) {
    if (!boundary.boundaryPassed) failureReasons.push(`${boundary.kind} adjacent-sample discontinuity`);
    if (!boundary.highBandPassed) failureReasons.push(`${boundary.kind} 1-8 kHz burst`);
  }
  return {
    name: effect ? `${instrument}-${effect.profile.presetId}-effects` : `${instrument}-${stage}`,
    instrument,
    stage,
    sampleRate: SAMPLE_RATE,
    durationSeconds,
    finite,
    clippedSamples,
    peakAbs,
    postStopPeak,
    boundaries,
    ...(effect ? {
      effectProfileId: effect.profile.presetId,
      effectTailSeconds,
      effectTailStartPeak,
      effectTailEndPeak,
      postTailPeak,
      effectTailObserved,
      effectTailPassed,
    } : {}),
    passed: failureReasons.length === 0,
    failureReasons,
  };
};

/** A controlled same-oscillator comparison. It intentionally has no filter,
 * effects, or profile changes, so any difference comes from the release curve
 * itself. It is a reference, not a claim that the former curve caused the
 * original live fault. */
const renderEnvelopeReference = async (mode: EnvelopeReference['mode']): Promise<EnvelopeReference> => {
  const start = .2;
  const gate = .3;
  const release = .5;
  const releaseAt = start + gate;
  const releaseEnd = releaseAt + release;
  const stop = releaseEnd + sourceStopGuardSeconds(SAMPLE_RATE);
  const context = new OfflineAudioContext(1, Math.ceil((stop + .12) * SAMPLE_RATE), SAMPLE_RATE);
  const master = outputFor(context);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(220, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(1, start + .01);
  gain.gain.setValueAtTime(1, releaseAt);
  if (mode === 'linear') gain.gain.linearRampToValueAtTime(0, releaseEnd);
  else {
    gain.gain.cancelAndHoldAtTime(releaseAt);
    gain.gain.setValueCurveAtTime(smoothstepCurve(1, 0), releaseAt, release);
  }
  oscillator.connect(gain).connect(master);
  oscillator.start(start);
  oscillator.stop(stop);
  const buffer = await context.startRendering();
  const samples = buffer.getChannelData(0);
  let peakAbs = 0;
  for (const sample of samples) peakAbs = Math.max(peakAbs, Math.abs(sample));
  const boundaries = [
    { kind: 'release-start' as const, time: releaseAt },
    { kind: 'release-end' as const, time: releaseEnd },
    { kind: 'source-stop' as const, time: stop },
  ].map(({ kind, time }) => measureReleaseBoundary(samples, time, SAMPLE_RATE, kind));
  return { mode, releaseAt, releaseEnd, boundaries, peakAbs };
};

export const runReleaseBlipHarness = async () => {
  if (typeof OfflineAudioContext === 'undefined') return { status: 'unsupported' as const, failureReasons: ['OfflineAudioContext is not available.'] };
  const featureProbe = new OfflineAudioContext(1, 128, SAMPLE_RATE).createGain().gain;
  const cases: RenderCase[] = [];
  const failureReasons: string[] = [];
  for (const instrument of instruments) {
    for (const stage of stages) {
      try {
        const result = await renderCase(instrument, stage);
        cases.push(result);
        if (!result.passed) failureReasons.push(result.name, ...result.failureReasons.map((reason) => `${result.name}: ${reason}`));
      } catch (error) {
        failureReasons.push(`${instrument}-${stage}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const effects: EffectTailReference[] = [
    { mode: 'lead', profile: LEAD_PRESETS.find((profile) => profile.presetId === 'Airy')!, tailSeconds: leadEffectTailSeconds(normalizeLeadProfile(LEAD_PRESETS.find((profile) => profile.presetId === 'Airy')!, SAMPLE_RATE)) },
    { mode: 'lead', profile: LEAD_PRESETS.find((profile) => profile.presetId === 'Strings')!, tailSeconds: leadEffectTailSeconds(normalizeLeadProfile(LEAD_PRESETS.find((profile) => profile.presetId === 'Strings')!, SAMPLE_RATE)) },
    { mode: 'chords', profile: CHORD_PRESETS.find((profile) => profile.presetId === 'Wide Saw')!, tailSeconds: chordEffectTailSeconds(normalizeChordProfile(CHORD_PRESETS.find((profile) => profile.presetId === 'Wide Saw')!, SAMPLE_RATE)) },
  ];
  for (const effect of effects) {
    try {
      const result = await renderCase(effect.mode, 'sustain', effect);
      cases.push(result);
      if (!result.passed) failureReasons.push(result.name, ...result.failureReasons.map((reason) => `${result.name}: ${reason}`));
    } catch (error) {
      failureReasons.push(`${effect.mode}-${effect.profile.presetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let linearReference: { linear: EnvelopeReference; smoothstep: EnvelopeReference } | null = null;
  try {
    const linear = await renderEnvelopeReference('linear');
    const smoothstep = await renderEnvelopeReference('smoothstep');
    linearReference = { linear, smoothstep };
  } catch (error) {
    failureReasons.push(`linear/smoothstep reference: ${error instanceof Error ? error.message : String(error)}`);
  }
  const selfTest = releaseDiagnosticSelfTest(SAMPLE_RATE);
  if (!selfTest.detected) failureReasons.push('detector self-test did not detect injected release fault');
  return {
    status: failureReasons.length === 0 ? 'passed' as const : 'failed' as const,
    sampleRate: SAMPLE_RATE,
    audioParamFeatures: {
      cancelAndHoldAtTime: typeof featureProbe.cancelAndHoldAtTime === 'function',
      setValueCurveAtTime: typeof featureProbe.setValueCurveAtTime === 'function',
    },
    thresholds: { ...DEFAULT_RELEASE_DIAGNOSTIC_THRESHOLDS, postStopPeak: POST_STOP_LIMIT },
    detectorSelfTest: selfTest,
    linearReference,
    cases,
    failureReasons,
  };
};

if (typeof document !== 'undefined') {
  const output = document.querySelector('pre');
  void runReleaseBlipHarness().then((report) => {
    if (output) output.textContent = JSON.stringify(report, null, 2);
  }).catch((error) => {
    if (output) output.textContent = JSON.stringify({ status: 'failed', error: String(error) }, null, 2);
  });
}
