import type { DeckInstrument, DeckSoundProfile } from '../deck';
import type { AudioEngine, Controls, DrumModel, Instrument, OutputControls, Parameter, VoiceGroupState, VoiceLane } from '../synth/contract';
import { DRUM_PRESET_OVERRIDES } from '../synth/patches/drum-presets.ts';
export type { AudioEngine, Controls, DrumModel, Instrument, Parameter, VoiceGroupState, VoiceLane } from '../synth/contract';

const drumNames = ['Kick', 'Snare', 'Closed Hat', 'Open Hat', 'Clap', 'Low Tom', 'High Tom', 'Perc', 'Rim', 'Shaker', 'Cowbell', 'Ride'];
const metalRatios = [1, 1.483, 1.932, 2.546, 2.63, 3.897];
const clamp = (n: number, min = 0, max = 1) => Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
type PresetProfile = { controls: Controls; volume: number; parameters: Record<string, number> };
type BassVcaScheduleResult = BassVcaTiming & { end: number };
type VoiceGroup = { at: number; voices: OscillatorNode[]; voiceCount: number; lane: VoiceLane; state: VoiceGroupState; choke?: (at: number, duration?: number, atIsSafe?: boolean) => void | BassVcaScheduleResult; release?: (at: number, duration: number) => void | BassVcaScheduleResult };
type OpenHatHit = { gain: GainNode; sources: Set<AudioScheduledSourceNode>; lane: VoiceLane };
type CachedProfileDestination = { output: GainNode; nodes: AudioNode[]; users: number };
type BassLaneNote = { token: number; midi: number; frequency: number; gateEnd: number | null; releaseEnd?: number; heldId?: string };
export type BassGraphProfile = {
  mainType: OscillatorType;
  subType: OscillatorType;
  clickType: OscillatorType;
  mainGain: number;
  subLevel: number;
  filterHz: number;
  clickHz: number;
  clickFilterHz: number;
  drive: number;
  oversample: OverSampleType;
  profileGain: number;
};
type BassLaneProfile = { profile?: DeckSoundProfile; fingerprint: string; graph: BassGraphProfile; graphFingerprint: string };
type PendingBassProfile = BassLaneProfile;
type PersistentBassLane = {
  lane: VoiceLane;
  main: OscillatorNode;
  sub: OscillatorNode;
  click: OscillatorNode;
  mainGain: GainNode;
  subGain: GainNode;
  envelope: GainNode;
  clickGain: GainNode;
  filter: BiquadFilterNode;
  clickFilter: BiquadFilterNode;
  shaper: WaveShaperNode;
  gate: GainNode;
  profileGain: GainNode;
  envelopeState: BassVcaController;
  clickState: BassVcaController;
  vca: BassVcaController;
  current: BassLaneNote | null;
  currentHeldId?: string;
  envelopeResetToken?: number;
  profile?: DeckSoundProfile;
  profileState: BassLaneProfile | null;
  pendingProfile?: PendingBassProfile;
  pendingProfileTimer?: number;
};
const MIN_GATE_SECONDS = .005;
const FADE_SECONDS = .02;
export const voiceGroupCountsTowardLimit = (state: VoiceGroupState | undefined) => state === undefined || state === 'active';
export const voiceGroupIsTracked = (state: VoiceGroupState) => state !== 'stopped';
export const voiceGroupReleaseState = (state: VoiceGroupState): VoiceGroupState => state === 'stopped' ? 'stopped' : 'releasing';
export const voiceGroupStopState = (_state: VoiceGroupState): VoiceGroupState => 'stopped';
export const canChokeVoiceGroup = (group: { at: number; lane: VoiceLane; state: VoiceGroupState }, lane: VoiceLane, at: number) =>
  group.state !== 'stopped' && group.lane === lane && group.at <= at + .001;
export const countMusicalVoices = (groups: ReadonlyArray<{ voiceCount: number }>) => groups.reduce((count, group) => count + group.voiceCount, 0);
export const countMusicalVoicesInLane = (groups: ReadonlyArray<{ voiceCount: number; lane: VoiceLane; state?: VoiceGroupState }>, lane: VoiceLane) => countMusicalVoices(groups.filter((group) => group.lane === lane && voiceGroupCountsTowardLimit(group.state)));
export const safeReleaseDuration = (duration: number) => Number.isFinite(duration) ? Math.max(.012, duration) : .012;
export const releaseEndTime = (at: number, duration: number) => at + safeReleaseDuration(duration);
export const linearFadeValue = (from: number, to: number, elapsed: number, duration: number) => {
  const span = Number.isFinite(duration) ? Math.max(.000001, duration) : .000001;
  const progress = Number.isFinite(elapsed) ? Math.min(1, Math.max(0, elapsed / span)) : 0;
  return from + (to - from) * progress;
};
export const smoothstepProgress = (progress: number) => {
  const t = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return t * t * (3 - 2 * t);
};
export const smoothstepDerivative = (progress: number) => {
  const t = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return 6 * t * (1 - t);
};
export const smoothstepValue = (from: number, to: number, progress: number) => from + (to - from) * smoothstepProgress(progress);
export const sampledSmoothstepCurve = (from: number, to: number, sampleCount = 33) => {
  const count = Math.max(2, Math.round(Number.isFinite(sampleCount) ? sampleCount : 33));
  const values = new Float32Array(count);
  for (let index = 0; index < count; index++) values[index] = smoothstepValue(from, to, index / (count - 1));
  return values;
};
const sortedRecordEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
export const bassGraphProfileFingerprint = (profile: BassGraphProfile) => JSON.stringify([
  profile.mainType,
  profile.subType,
  profile.clickType,
  profile.mainGain,
  profile.subLevel,
  profile.filterHz,
  profile.clickHz,
  profile.clickFilterHz,
  profile.drive,
  profile.oversample,
  profile.profileGain,
]);
export const bassDeckProfileFingerprint = (profile?: DeckSoundProfile) => profile
  ? JSON.stringify([profile.presetId, sortedRecordEntries(profile.controls), sortedRecordEntries(profile.parameters), profile.volume, profile.drumModel ?? null])
  : 'live';
export type BassVcaCurve = { from: number; to: number; start: number; duration: number; end: number };
export type BassVcaTiming = { requestedAt: number; scheduledAt: number; safetyOffsetSeconds: number };
export const PERSISTENT_BASS_LANES = ['live', 'deckA', 'deckB', 'solo'] as const;
const BASS_RENDER_QUANTUM_SAMPLES = 128;
const BASS_SAFETY_QUANTA = 2;
export const bassVcaAutomationTiming = (requestedAt: number, now: number, sampleRate: number, protectLateAutomation: boolean): BassVcaTiming => {
  const requested = Number.isFinite(requestedAt) ? requestedAt : now;
  const current = Number.isFinite(now) ? now : 0;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const safetyOffsetSeconds = protectLateAutomation ? BASS_RENDER_QUANTUM_SAMPLES * BASS_SAFETY_QUANTA / rate : 0;
  const scheduledAt = protectLateAutomation ? Math.max(requested, current + safetyOffsetSeconds) : requested;
  return { requestedAt: requested, scheduledAt, safetyOffsetSeconds: scheduledAt - requested };
};
export type BassVcaRetriggerTiming = BassVcaTiming & { chokeAt: number; onsetAt: number };
export const bassVcaRetriggerTiming = (requestedAt: number, now: number, sampleRate: number, protectLateAutomation: boolean): BassVcaRetriggerTiming => {
  const timing = bassVcaAutomationTiming(requestedAt, now, sampleRate, protectLateAutomation);
  return { ...timing, chokeAt: timing.scheduledAt, onsetAt: timing.scheduledAt };
};
export class BassVcaController {
  private readonly initialValue: number;
  private curves: BassVcaCurve[] = [];

  constructor(initialValue = 0) {
    this.initialValue = Number.isFinite(initialValue) ? Math.max(0, initialValue) : 0;
  }

  valueAt(time: number) {
    const at = Number.isFinite(time) ? time : 0;
    let value = this.initialValue;
    let selected: BassVcaCurve | null = null;
    for (const curve of this.curves) {
      if (at < curve.start) break;
      selected = curve;
      value = curve.to;
    }
    if (selected && selected.duration > .000001 && at < selected.end) return linearFadeValue(selected.from, selected.to, at - selected.start, selected.duration);
    return value;
  }

  schedule(to: number, start: number, duration: number): BassVcaCurve {
    const when = Number.isFinite(start) ? start : 0;
    const safeDuration = Number.isFinite(duration) ? Math.max(.000001, duration) : .000001;
    const target = Number.isFinite(to) ? Math.max(0, to) : 0;
    const curve: BassVcaCurve = { from: this.valueAt(when), to: target, start: when, duration: safeDuration, end: when + safeDuration };
    // Keep the earlier piecewise history for diagnostics and retriggers, but
    // discard segments that would otherwise override this new transition.
    this.curves = [...this.curves.filter((existing) => existing.start < when), curve].sort((left, right) => left.start - right.start);
    return curve;
  }

  segments() { return this.curves.map((curve) => ({ ...curve })); }
}
export type BassReleaseDiagnostic = {
  releaseAt: number;
  requestedAt: number;
  scheduledAt: number;
  safetyOffsetSeconds: number;
  capturedAt: number;
  sampleRate: number;
  sampleCount: number;
  windowSeconds: number;
  peak: number;
  rms: number;
  maxAdjacentSampleDelta: number;
  cause?: 'natural-release' | 'retrigger' | 'choke' | 'deck-gate-off';
  lane?: VoiceLane;
  voiceId?: string;
  windowStartAudioTime: number;
  windowEndAudioTime: number;
  releaseFrameIndex: number | null;
  releaseFrameTime: number | null;
  releasePeak: number;
  releaseMaxAdjacentSampleDelta: number;
};
type PendingBassRelease = Pick<BassReleaseDiagnostic, 'requestedAt' | 'scheduledAt' | 'safetyOffsetSeconds' | 'cause' | 'lane' | 'voiceId'>;

export type BassReleaseWindowAnalysis = {
  windowStartAudioTime: number;
  windowEndAudioTime: number;
  releaseFrameIndex: number | null;
  releaseFrameTime: number | null;
  releasePeak: number;
  releaseMaxAdjacentSampleDelta: number;
};

/**
 * Estimates where a scheduled release falls in a rolling time-domain buffer.
 * The buffer still comes from AnalyserNode, so this is an alignment aid rather
 * than a sample-accurate capture. Keeping the calculation pure lets tests and
 * exported diagnostics use the same definition.
 */
export const analyseBassReleaseWindow = (
  samples: ArrayLike<number>,
  sampleRate: number,
  capturedAt: number,
  releaseAt: number,
  radiusSamples = 128,
): BassReleaseWindowAnalysis => {
  const count = Math.max(0, Math.floor(samples.length));
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  const end = Number.isFinite(capturedAt) ? capturedAt : 0;
  const start = end - count / rate;
  const candidate = Math.round((releaseAt - start) * rate);
  const inWindow = candidate >= 0 && candidate < count;
  const center = inWindow ? candidate : null;
  const radius = Math.max(1, Math.round(Number.isFinite(radiusSamples) ? radiusSamples : 128));
  let releasePeak = 0;
  let releaseMaxAdjacentSampleDelta = 0;
  if (center !== null) {
    const from = Math.max(0, center - radius);
    const to = Math.min(count - 1, center + radius);
    for (let index = from; index <= to; index++) {
      const sample = Number(samples[index] ?? 0);
      releasePeak = Math.max(releasePeak, Math.abs(sample));
      if (index > from) releaseMaxAdjacentSampleDelta = Math.max(releaseMaxAdjacentSampleDelta, Math.abs(sample - Number(samples[index - 1] ?? 0)));
    }
  }
  return {
    windowStartAudioTime: start,
    windowEndAudioTime: end,
    releaseFrameIndex: center,
    releaseFrameTime: center === null ? null : start + center / rate,
    releasePeak,
    releaseMaxAdjacentSampleDelta,
  };
};
const exponentialEnvelopeValue = (from: number, to: number, progress: number) => {
  const start = Math.max(.0001, from);
  const end = Math.max(.0001, to);
  return start * Math.pow(end / start, clamp(progress));
};
export const adsrLevelAt = (elapsedSeconds: number, attackSeconds: number, decaySeconds: number, peak: number, sustainAmount: number) => {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const attack = Number.isFinite(attackSeconds) ? Math.max(0, attackSeconds) : 0;
  const decay = Number.isFinite(decaySeconds) ? Math.max(0, decaySeconds) : 0;
  if (attack > 0 && elapsed < attack) return exponentialEnvelopeValue(.0001, peak, elapsed / attack);
  if (elapsed < attack + decay) return exponentialEnvelopeValue(peak, sustainAmount, decay > 0 ? (elapsed - attack) / decay : 1);
  return Math.max(.0001, sustainAmount);
};
const safeGateDuration = (duration: number | null) => duration === null ? null : Number.isFinite(duration) ? Math.max(MIN_GATE_SECONDS, duration) : MIN_GATE_SECONDS;
export type BassVcaSchedule = { onsetDuration: number; releaseAt: number | null; releaseEnd: number | null; releaseDuration: number };
export const bassLaneNoteIsAudibleAt = (note: { releaseEnd?: number }, at: number) => note.releaseEnd === undefined || at < note.releaseEnd;
export const bassVcaSchedule = (gateDuration: number | null, onsetFade: number, releaseDuration: number): BassVcaSchedule => {
  const gate = safeGateDuration(gateDuration);
  const onset = Number.isFinite(onsetFade) ? Math.max(0, onsetFade) : MIN_GATE_SECONDS;
  const release = safeReleaseDuration(releaseDuration);
  return {
    onsetDuration: gate === null ? onset : Math.min(onset, gate),
    releaseAt: gate,
    releaseEnd: gate === null ? null : gate + release,
    releaseDuration: release,
  };
};

// Every preset starts with the instrument's base values below, then applies these
// overrides. That gives every preset a complete parameter set while keeping the
// collection easy to tune by hand.
const presetProfiles: Record<Instrument, PresetProfile[]> = {
  drums: [
    ...DRUM_PRESET_OVERRIDES,
  ],
  bass: [
    { controls: { tone: .25, shape: .1, glide: 0, drive: .05 }, volume: .62, parameters: { subLevel: .42, filterHz: 900, dwellMs: 180, decayMs: 480, releaseMs: 500, clickLevel: 0 } },
    { controls: { tone: .52, shape: .3, glide: .12, drive: .18 }, volume: .6, parameters: { subLevel: .35, filterHz: 1800, attackMs: 12, dwellMs: 150, decayMs: 400, releaseMs: 500 } },
    { controls: { tone: .7, shape: .68, glide: .28, drive: .42 }, volume: .52, parameters: { subLevel: .24, filterHz: 3400, attackMs: 4, dwellMs: 90, decayMs: 240, releaseMs: 500, glideMs: 220 } },
    { controls: { tone: .8, shape: .6, glide: .05, drive: .12 }, volume: .56, parameters: { subLevel: .2, filterHz: 4200, attackMs: 2, dwellMs: 45, decayMs: 120, releaseMs: 500, clickLevel: .18 } },
    { controls: { tone: .58, shape: .9, glide: .1, drive: .25 }, volume: .55, parameters: { subLevel: .3, filterHz: 2600, dwellMs: 110, releaseMs: 500, clickHz: 2400, clickLevel: .1 } },
    { controls: { tone: .72, shape: .72, glide: .18, drive: .85 }, volume: .45, parameters: { subLevel: .18, filterHz: 5200, attackMs: 5, dwellMs: 220, decayMs: 600, releaseMs: 500, clickLevel: .2, glideMs: 180 } },
  ],
  chords: [
    { controls: { tone: .42, attack: .65, width: .38, space: .55 }, volume: .38, parameters: { attackMs: 360, releaseMs: 1200, detuneCents: 5, filterHz: 2600, delayMs: 420 } },
    { controls: { tone: .35, attack: .3, width: .22, space: .3 }, volume: .42, parameters: { attackMs: 90, releaseMs: 520, detuneCents: 3, filterHz: 4200, delayMs: 220 } },
    { controls: { tone: .85, attack: .2, width: .65, space: .4 }, volume: .34, parameters: { attackMs: 40, releaseMs: 800, detuneCents: 18, filterHz: 7600, harmonicLevel: .55, delayMs: 300 } },
    { controls: { tone: .5, attack: .45, width: .3, space: .25 }, volume: .4, parameters: { attackMs: 120, releaseMs: 900, detuneCents: 2, filterHz: 5000, harmonicLevel: .7 } },
    { controls: { tone: .72, attack: .08, width: .45, space: .2 }, volume: .4, parameters: { attackMs: 8, releaseMs: 300, detuneCents: 10, filterHz: 6200, delayMs: 160 } },
    { controls: { tone: .78, attack: .18, width: .9, space: .65 }, volume: .32, parameters: { attackMs: 35, releaseMs: 1100, detuneCents: 24, filterHz: 7200, chorusMs: 13, delayMs: 480 } },
  ],
  lead: [
    { controls: { tone: .8, bite: .45, motion: .12, echo: .18 }, volume: .46, parameters: { attackMs: 5, decayMs: 360, sustainLevel: .72, releaseMs: 450, filterHz: 7200, detuneCents: 4, vibratoHz: 4, vibratoCents: 8, echoMs: 220 } },
    { controls: { tone: .08, bite: .12, motion: .05, echo: .05 }, volume: .5, parameters: { attackMs: 18, decayMs: 560, sustainLevel: .72, releaseMs: 450, filterHz: 2600, detuneCents: 0, vibratoHz: 3, vibratoCents: 5 } },
    { controls: { tone: .9, bite: .55, motion: .2, echo: .25 }, volume: .42, parameters: { attackMs: 4, decayMs: 300, sustainLevel: .72, releaseMs: 450, filterHz: 8200, detuneCents: 12, vibratoHz: 5, vibratoCents: 16, echoMs: 260 } },
    { controls: { tone: .65, bite: .25, motion: .45, echo: .4 }, volume: .38, parameters: { attackMs: 8, decayMs: 700, sustainLevel: .72, releaseMs: 450, filterHz: 9000, detuneCents: 3, vibratoHz: 6, vibratoCents: 28, echoMs: 360, echoFeedback: .38 } },
    { controls: { tone: .72, bite: .85, motion: .15, echo: .12 }, volume: .35, parameters: { attackMs: 2, decayMs: 260, sustainLevel: .72, releaseMs: 450, filterHz: 6800, detuneCents: 18, vibratoHz: 4.5, vibratoCents: 10, echoFeedback: .12 } },
    { controls: { tone: .48, bite: .2, motion: .7, echo: .62 }, volume: .4, parameters: { attackMs: 35, decayMs: 900, sustainLevel: .72, releaseMs: 1200, filterHz: 6000, detuneCents: 9, vibratoHz: 7, vibratoCents: 34, echoMs: 520, echoFeedback: .48 } },
    { controls: { tone: .42, bite: .22, motion: .28, echo: .25 }, volume: .42, parameters: { attackMs: 350, decayMs: 650, sustainLevel: .72, releaseMs: 750, filterHz: 4200, detuneCents: 12, vibratoHz: 5.5, vibratoCents: 24, chorusDelayMs: 18, chorusDepthMs: 2.3, chorusRateHz: .55, chorusMix: 1, echoMs: 300, echoFeedback: .18 } },
  ],
  metronome: [
    { controls: { tone: .55, attack: .15, decay: .3, level: .5 }, volume: .5, parameters: { clickHz: 1700, accentHz: 2500, attackMs: 2, decayMs: 65, clickLevel: .42, filterHz: 5200 } },
    { controls: { tone: .8, attack: .08, decay: .15, level: .42 }, volume: .44, parameters: { clickHz: 2400, accentHz: 3600, attackMs: 1, decayMs: 35, clickLevel: .34, filterHz: 7800 } },
    { controls: { tone: .25, attack: .4, decay: .7, level: .5 }, volume: .45, parameters: { clickHz: 900, accentHz: 1350, attackMs: 8, decayMs: 150, clickLevel: .3, filterHz: 2400 } },
    { controls: { tone: .65, attack: .1, decay: .2, level: .48 }, volume: .48, parameters: { clickHz: 1250, accentHz: 1900, attackMs: 2, decayMs: 48, clickLevel: .38, filterHz: 4200 } },
    { controls: { tone: .9, attack: .03, decay: .1, level: .35 }, volume: .4, parameters: { clickHz: 3200, accentHz: 4800, attackMs: 1, decayMs: 24, clickLevel: .28, filterHz: 10000 } },
    { controls: { tone: .15, attack: .25, decay: .85, level: .38 }, volume: .38, parameters: { clickHz: 650, accentHz: 980, attackMs: 5, decayMs: 220, clickLevel: .25, filterHz: 1800 } },
  ],
};

/**
 * @deprecated Kept as the pre-independent-voice engine for comparison and
 * rollback. New code should import SynthEngine from this module.
 */
export class LegacySynthEngine implements AudioEngine {
  private disposed = false;
  context: AudioContext | null = null;
  master: GainNode | null = null;
  compressor: DynamicsCompressorNode | null = null;
  analyser: AnalyserNode | null = null;
  destination: AudioNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputTimeBuffer = new Float32Array(2048);
  private pendingBassReleases: PendingBassRelease[] = [];
  private bassReleaseDiagnostics: BassReleaseDiagnostic[] = [];
  instruments = new Map<Instrument, GainNode>();
  controls: Record<Instrument, Controls> = {
    drums: { punch: .65, tightness: .55, dirt: .15, room: .2 },
    bass: { tone: .5, shape: .35, glide: 0, drive: .2 },
    chords: { tone: .55, attack: .35, width: .5, space: .25 },
    lead: { tone: .65, bite: .35, motion: .2, echo: .15 },
    metronome: { tone: .55, attack: .15, decay: .3, level: .5 },
  };
  volumes: Record<Instrument, number> = { drums: .72, bass: .62, chords: .42, lead: .5, metronome: .5 };
  outputControls: OutputControls = { masterVolume: .55, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0, echoTimeMs: 280, echoFeedback: .25, echoMix: 0 };
  private outputEqLow: BiquadFilterNode | null = null;
  private outputEqMid: BiquadFilterNode | null = null;
  private outputEqHigh: BiquadFilterNode | null = null;
  private outputEcho: DelayNode | null = null;
  private outputEchoFeedback: GainNode | null = null;
  private outputEchoWet: GainNode | null = null;
  private presetIndexes: Record<Instrument, number> = { drums: 0, bass: 0, chords: 0, lead: 0, metronome: 0 };
  parameters: Record<Instrument, Record<string, Parameter>> = {
    drums: {
      kickStartHz: { label: 'Kick start frequency', min: 40, max: 400, step: 1, value: 190, unit: 'Hz' },
      kickEndHz: { label: 'Kick end frequency', min: 20, max: 120, step: 1, value: 48, unit: 'Hz' },
      kickPitchFallMs: { label: 'Kick pitch fall', min: 10, max: 220, step: 1, value: 90, unit: 'ms' },
      kickDecayMs: { label: 'Kick amplitude fall', min: 80, max: 900, step: 1, value: 350, unit: 'ms' },
      kickClickHz: { label: 'Kick click frequency', min: 1000, max: 8000, step: 1, value: 3500, unit: 'Hz' },
      kickClickMs: { label: 'Kick click fall', min: 2, max: 80, step: 1, value: 18, unit: 'ms' },
      kickClickLevel: { label: 'Kick click level', min: 0, max: 1, step: .01, value: .2, unit: '' },
      snareBodyHz: { label: 'Snare body frequency', min: 80, max: 500, step: 1, value: 190, unit: 'Hz' },
      snareBodyMs: { label: 'Snare body fall', min: 30, max: 400, step: 1, value: 125, unit: 'ms' },
      snareNoiseHz: { label: 'Snare noise frequency', min: 800, max: 7000, step: 1, value: 2800, unit: 'Hz' },
      snareNoiseMs: { label: 'Snare noise fall', min: 30, max: 500, step: 1, value: 180, unit: 'ms' },
      snareNoiseLevel: { label: 'Snare noise level', min: 0, max: 1, step: .01, value: .62, unit: '' },
      closedHatMs: { label: 'Closed hat fall', min: 10, max: 180, step: 1, value: 45, unit: 'ms' },
      closedHatFilterHz: { label: 'Closed hat filter', min: 4000, max: 12000, step: 1, value: 7800, unit: 'Hz' },
      closedHatLevel: { label: 'Closed hat level', min: 0, max: 1, step: .01, value: .35, unit: '' },
      openHatMs: { label: 'Open hat fall', min: 80, max: 900, step: 1, value: 420, unit: 'ms' },
      openHatFilterHz: { label: 'Open hat filter', min: 2500, max: 10000, step: 1, value: 5200, unit: 'Hz' },
      openHatNoiseLevel: { label: 'Open hat noise level', min: 0, max: 1, step: .01, value: .48, unit: '' },
      openHatMetalLevel: { label: 'Open hat metal level', min: 0, max: 1, step: .01, value: .2, unit: '' },
      clapGapMs: { label: 'Clap burst gap', min: 5, max: 60, step: 1, value: 20, unit: 'ms' },
      clapBurstMs: { label: 'Clap burst fall', min: 10, max: 120, step: 1, value: 55, unit: 'ms' },
      clapTailMs: { label: 'Clap tail fall', min: 50, max: 500, step: 1, value: 240, unit: 'ms' },
      clapFilterHz: { label: 'Clap filter', min: 500, max: 5000, step: 1, value: 1800, unit: 'Hz' },
      clapCrackLevel: { label: 'Clap crack level', min: 0, max: 1, step: .01, value: .42, unit: '' },
      clapTailLevel: { label: 'Clap tail level', min: 0, max: 1, step: .01, value: .28, unit: '' },
      tomFallMs: { label: 'Tom pitch fall', min: 20, max: 350, step: 1, value: 120, unit: 'ms' },
      tomLowStartHz: { label: 'Low tom start frequency', min: 80, max: 300, step: 1, value: 180, unit: 'Hz' },
      tomLowEndHz: { label: 'Low tom end frequency', min: 40, max: 160, step: 1, value: 82, unit: 'Hz' },
      tomHighStartHz: { label: 'High tom start frequency', min: 150, max: 500, step: 1, value: 280, unit: 'Hz' },
      tomHighEndHz: { label: 'High tom end frequency', min: 80, max: 260, step: 1, value: 150, unit: 'Hz' },
      tomNoiseLevel: { label: 'Tom attack level', min: 0, max: 1, step: .01, value: .24, unit: '' },
      percAHz: { label: 'Percussion frequency A', min: 200, max: 2000, step: 1, value: 840, unit: 'Hz' },
      percBHz: { label: 'Percussion frequency B', min: 300, max: 3000, step: 1, value: 1290, unit: 'Hz' },
      rimHz: { label: 'Rim frequency', min: 500, max: 4000, step: 1, value: 1850, unit: 'Hz' },
      rimDecayMs: { label: 'Rim fall', min: 10, max: 180, step: 1, value: 45, unit: 'ms' },
      rimFilterHz: { label: 'Rim filter', min: 1000, max: 8000, step: 1, value: 2800, unit: 'Hz' },
      rimNoiseLevel: { label: 'Rim attack level', min: 0, max: 1, step: .01, value: .28, unit: '' },
      shakerMs: { label: 'Shaker fall', min: 30, max: 650, step: 1, value: 550, unit: 'ms' },
      shakerLevel: { label: 'Shaker level', min: 0, max: 1, step: .01, value: .26, unit: '' },
      shakerFilterHz: { label: 'Shaker high-pass', min: 2000, max: 12000, step: 1, value: 2602, unit: 'Hz' },
      shakerAttackMs: { label: 'Shaker attack', min: .2, max: 16, step: .1, value: 12, unit: 'ms' },
      shakerFilterQ: { label: 'Shaker filter Q', min: .05, max: 2, step: .01, value: .28, unit: '' },
      cowbellHzA: { label: 'Cowbell frequency A', min: 300, max: 1600, step: 1, value: 540, unit: 'Hz' },
      cowbellHzB: { label: 'Cowbell frequency B', min: 400, max: 2200, step: 1, value: 800, unit: 'Hz' },
      cowbellDecayMs: { label: 'Cowbell fall', min: 40, max: 500, step: 1, value: 220, unit: 'ms' },
      cowbellFilterHz: { label: 'Cowbell filter', min: 500, max: 3000, step: 1, value: 1200, unit: 'Hz' },
      cowbellNoiseLevel: { label: 'Cowbell attack level', min: 0, max: 1, step: .01, value: .24, unit: '' },
      rideMs: { label: 'Ride fall', min: 100, max: 1500, step: 1, value: 650, unit: 'ms' },
      rideLevel: { label: 'Ride level', min: 0, max: 1, step: .01, value: .25, unit: '' },
      rideFilterHz: { label: 'Ride filter', min: 3000, max: 12000, step: 1, value: 6200, unit: 'Hz' },
    },
    bass: {
      subLevel: { label: 'Sub oscillator level', min: 0, max: 1, step: .01, value: .28, unit: '' },
      filterHz: { label: 'Low-pass cutoff', min: 100, max: 8000, step: 1, value: 2000, unit: 'Hz' },
      attackMs: { label: 'Amp attack', min: 1, max: 120, step: 1, value: 8, unit: 'ms' },
      dwellMs: { label: 'Amp sustain time', min: 10, max: 1200, step: 1, value: 180, unit: 'ms' },
      decayMs: { label: 'Amp decay', min: 20, max: 900, step: 1, value: 350, unit: 'ms' },
      sustainLevel: { label: 'Amp sustain level', min: .01, max: 1, step: .01, value: .65, unit: '' },
      releaseMs: { label: 'Amp release', min: 20, max: 1200, step: 1, value: 500, unit: 'ms' },
      subOctave: { label: 'Sub oscillator octave', min: -2, max: -.5, step: .5, value: -1, unit: 'oct' },
      clickHz: { label: 'Transient click frequency', min: 500, max: 5000, step: 1, value: 1800, unit: 'Hz' },
      clickLevel: { label: 'Transient click level', min: 0, max: .5, step: .01, value: .08, unit: '' },
      glideMs: { label: 'Maximum glide time', min: 0, max: 500, step: 1, value: 120, unit: 'ms' },
    },
    chords: {
      attackMs: { label: 'Amp attack', min: 1, max: 1000, step: 1, value: 180, unit: 'ms' },
      decayMs: { label: 'Amp decay', min: 10, max: 1200, step: 1, value: 240, unit: 'ms' },
      sustainLevel: { label: 'Amp sustain level', min: .01, max: 1, step: .01, value: .68, unit: '' },
      releaseMs: { label: 'Release tail', min: 50, max: 2000, step: 1, value: 700, unit: 'ms' },
      detuneCents: { label: 'Oscillator detune', min: 0, max: 40, step: .1, value: 8, unit: 'cents' },
      filterHz: { label: 'Filter cutoff', min: 200, max: 10000, step: 1, value: 3200, unit: 'Hz' },
      oscillatorMix: { label: 'Second oscillator level', min: 0, max: 1, step: .01, value: .8, unit: '' },
      harmonicLevel: { label: 'Organ harmonic level', min: 0, max: 1, step: .01, value: .3, unit: '' },
      chorusMs: { label: 'Chorus delay', min: 0, max: 30, step: .1, value: 8, unit: 'ms' },
      delayMs: { label: 'Delay time', min: 40, max: 800, step: 1, value: 320, unit: 'ms' },
    },
    lead: {
      attackMs: { label: 'Amp attack', min: 1, max: 500, step: 1, value: 8, unit: 'ms' },
      decayMs: { label: 'Amp decay', min: 20, max: 1200, step: 1, value: 420, unit: 'ms' },
      sustainLevel: { label: 'Amp sustain level', min: .01, max: 1, step: .01, value: .72, unit: '' },
      releaseMs: { label: 'Amp release', min: 20, max: 1200, step: 1, value: 450, unit: 'ms' },
      filterHz: { label: 'Filter cutoff', min: 300, max: 12000, step: 1, value: 5200, unit: 'Hz' },
      detuneCents: { label: 'Second oscillator detune', min: 0, max: 30, step: .1, value: 5, unit: 'cents' },
      vibratoHz: { label: 'Vibrato rate', min: 0, max: 12, step: .1, value: 4, unit: 'Hz' },
      vibratoCents: { label: 'Vibrato depth', min: 0, max: 80, step: .1, value: 12, unit: 'cents' },
      chorusDelayMs: { label: 'Chorus delay', min: 2, max: 30, step: .1, value: 10, unit: 'ms' },
      chorusDepthMs: { label: 'Chorus depth', min: 0, max: 10, step: .1, value: 0, unit: 'ms' },
      chorusRateHz: { label: 'Chorus rate', min: .1, max: 8, step: .1, value: 1, unit: 'Hz' },
      chorusMix: { label: 'Chorus mix', min: 0, max: 1, step: .01, value: 0, unit: '' },
      echoMs: { label: 'Echo time', min: 40, max: 900, step: 1, value: 280, unit: 'ms' },
      echoFeedback: { label: 'Echo feedback', min: 0, max: .75, step: .01, value: .25, unit: '' },
    },
    metronome: {
      clickHz: { label: 'Click frequency', min: 200, max: 6000, step: 1, value: 1700, unit: 'Hz' },
      accentHz: { label: 'Accent frequency', min: 300, max: 8000, step: 1, value: 2500, unit: 'Hz' },
      attackMs: { label: 'Click attack', min: 1, max: 40, step: 1, value: 2, unit: 'ms' },
      decayMs: { label: 'Click fall', min: 10, max: 500, step: 1, value: 65, unit: 'ms' },
      clickLevel: { label: 'Click level', min: 0, max: 1, step: .01, value: .42, unit: '' },
      filterHz: { label: 'Click filter', min: 500, max: 12000, step: 1, value: 5200, unit: 'Hz' },
    },
  };
  tempo = 120;
  drumModel: DrumModel = 'layered';
  active: OscillatorNode[] = [];
  voiceGains = new Map<OscillatorNode, GainNode>();
  heldNotes = new Map<string, OscillatorNode[]>();
  heldNoteKinds = new Map<string, Exclude<Instrument, 'drums'>>();
  noiseBuffer: AudioBuffer | null = null;
  /** Test/harness override; normal playback keeps the legacy random offset. */
  noiseOffsetOverride: number | null = null;
  private drumRoomGain: GainNode | null = null;
  private activeSources = new Set<AudioScheduledSourceNode>();
  private deckSources = new Set<AudioScheduledSourceNode>();
  private persistentBassSources = new Set<AudioScheduledSourceNode>();
  private sourceLanes = new Map<AudioScheduledSourceNode, VoiceLane>();
  private sourceProfileDestinations = new Map<AudioScheduledSourceNode, CachedProfileDestination>();
  private openHatHits: OpenHatHit[] = [];
  private profileDestinations = new Map<string, CachedProfileDestination>();
  private laneBuses = new Map<Exclude<VoiceLane, 'deck'>, GainNode>();
  private laneInstrumentGains = new Map<string, GainNode>();
  private instrumentEnabled: Record<Instrument, boolean> = { drums: true, bass: true, chords: true, lead: true, metronome: true };
  private debugSources = new Set<AudioScheduledSourceNode>();
  /** Debug-held notes use the legacy live implementation on rollback, but
   * remain explicitly owned so a scoped debug stop can release them. */
  private debugHeldIds = new Set<string>();
  private ownedGraphNodes = new Set<AudioNode>();
  private eventDestination: AudioNode | null = null;
  private eventProfileDestination: CachedProfileDestination | null = null;
  private eventLane: VoiceLane = 'live';
  private eventIsDebug = false;
  private eventIsDeck = false;
  private noiseDirt = 0;
  private bassLanes = new Map<VoiceLane, PersistentBassLane>();
  private bassHeld = new Map<string, { midi: number; order: number }>();
  private bassHeldOrder = 0;
  private bassNoteToken = 0;
  private leadVoices: VoiceGroup[] = [];
  private chordVoices: VoiceGroup[] = [];
  private readonly baseParameters: Record<Instrument, Record<string, Parameter>>;

  constructor() {
    this.baseParameters = JSON.parse(JSON.stringify(this.parameters)) as Record<Instrument, Record<string, Parameter>>;
  }

  private ownGraphNode<T extends AudioNode>(node: T) {
    this.ownedGraphNodes.add(node);
    return node;
  }

  private trackPersistentSource(source: AudioScheduledSourceNode, lane: VoiceLane) {
    this.activeSources.add(source);
    this.persistentBassSources.add(source);
    this.sourceLanes.set(source, lane);
    source.addEventListener('ended', () => {
      this.activeSources.delete(source);
      this.persistentBassSources.delete(source);
      this.sourceLanes.delete(source);
      this.active = this.active.filter((item) => item !== source);
    });
    return source;
  }

  async start() {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.ownGraphNode(this.context.createGain());
      const eqLow = this.ownGraphNode(this.context.createBiquadFilter());
      const eqMid = this.ownGraphNode(this.context.createBiquadFilter());
      const eqHigh = this.ownGraphNode(this.context.createBiquadFilter());
      const outputEcho = this.ownGraphNode(this.context.createDelay(1.2));
      const echoFeedback = this.ownGraphNode(this.context.createGain());
      const echoWet = this.ownGraphNode(this.context.createGain());
      const compressor = this.ownGraphNode(this.context.createDynamicsCompressor());
      const outputAnalyser = this.ownGraphNode(this.context.createAnalyser());
      compressor.threshold.value = -16;
      compressor.knee.value = 18;
      compressor.ratio.value = 6;
      compressor.attack.value = .005;
      compressor.release.value = .2;
      this.master.gain.value = this.outputControls.masterVolume * .7;
      eqLow.type = 'lowshelf'; eqLow.frequency.value = 180; eqLow.gain.value = this.outputControls.eqLowDb;
      eqMid.type = 'peaking'; eqMid.frequency.value = 1200; eqMid.Q.value = .8; eqMid.gain.value = this.outputControls.eqMidDb;
      eqHigh.type = 'highshelf'; eqHigh.frequency.value = 6500; eqHigh.gain.value = this.outputControls.eqHighDb;
      outputEcho.delayTime.value = this.outputControls.echoTimeMs / 1000;
      echoFeedback.gain.value = this.outputControls.echoFeedback;
      echoWet.gain.value = this.outputControls.echoMix * .45;
      outputAnalyser.fftSize = 2048;
      outputAnalyser.smoothingTimeConstant = 0;
      this.outputAnalyser = outputAnalyser;
      this.outputEqLow = eqLow; this.outputEqMid = eqMid; this.outputEqHigh = eqHigh;
      this.outputEcho = outputEcho; this.outputEchoFeedback = echoFeedback; this.outputEchoWet = echoWet;
      this.compressor = compressor;
      this.analyser = outputAnalyser;
      this.destination = this.context.destination;
      this.noiseBuffer = this.createNoiseBuffer(2);
      this.master.connect(eqLow).connect(eqMid).connect(eqHigh).connect(compressor).connect(outputAnalyser).connect(this.context.destination);
      eqHigh.connect(outputEcho).connect(echoWet).connect(compressor);
      outputEcho.connect(echoFeedback).connect(outputEcho);
      (['live', 'deckA', 'deckB', 'solo'] as const).forEach((lane) => {
        const bus = this.ownGraphNode(this.context!.createGain());
        bus.gain.value = lane === 'deckB' ? 0 : 1;
        bus.connect(this.master!);
        this.laneBuses.set(lane, bus);
      });
      (['drums', 'bass', 'chords', 'lead', 'metronome'] as Instrument[]).forEach((name) => {
        const gain = this.ownGraphNode(this.context!.createGain());
        gain.gain.value = this.instrumentEnabled[name] ? this.volumes[name] : 0;
        gain.connect(this.laneBuses.get('live')!);
        this.instruments.set(name, gain);
        (['deckA', 'deckB', 'solo'] as const).forEach((lane) => {
          const laneGain = this.ownGraphNode(this.context!.createGain());
          laneGain.gain.value = this.instrumentEnabled[name] ? 1 : 0;
          laneGain.connect(this.laneBuses.get(lane)!);
          this.laneInstrumentGains.set(`${lane}:${name}`, laneGain);
        });
      });
      const roomDelay = this.ownGraphNode(this.context.createDelay(.3));
      this.drumRoomGain = this.ownGraphNode(this.context.createGain());
      roomDelay.delayTime.value = .075;
      this.drumRoomGain.gain.value = this.controls.drums.room * .18;
      this.instruments.get('drums')!.connect(roomDelay).connect(this.drumRoomGain).connect(this.master);
      PERSISTENT_BASS_LANES.forEach((lane) => this.ensureBassLane(lane));
    }
    await this.context.resume();
  }

  setControl(instrument: Instrument, name: string, value: number) {
    this.controls[instrument][name] = clamp(value);
    if (instrument === 'drums' && name === 'room' && this.drumRoomGain && this.context) {
      this.drumRoomGain.gain.setTargetAtTime(clamp(value) * .18, this.context.currentTime, .01);
    }
    if (instrument === 'bass' && this.context) this.updateBassLaneProfile('live', undefined);
  }
  setDrumModel(model: DrumModel) { this.drumModel = model; }
  setVolume(instrument: Instrument, value: number) {
    this.volumes[instrument] = clamp(value);
    const gain = this.instruments.get(instrument);
    if (gain && this.context) gain.gain.setTargetAtTime(this.instrumentEnabled[instrument] ? clamp(value) : 0, this.context.currentTime, .01);
  }
  setOutputControl(name: keyof OutputControls, value: number) {
    const limits: Record<keyof OutputControls, [number, number]> = {
      masterVolume: [0, 1], eqLowDb: [-12, 12], eqMidDb: [-12, 12], eqHighDb: [-12, 12],
      echoTimeMs: [40, 900], echoFeedback: [0, .75], echoMix: [0, 1],
    };
    const [minimum, maximum] = limits[name];
    const next = Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : this.outputControls[name];
    this.outputControls[name] = next;
    if (!this.context) return;
    const at = this.context.currentTime;
    const target = (parameter: AudioParam | undefined, amount: number) => parameter?.setTargetAtTime(amount, at, .01);
    if (name === 'masterVolume') target(this.master?.gain, next * .7);
    else if (name === 'eqLowDb') target(this.outputEqLow?.gain, next);
    else if (name === 'eqMidDb') target(this.outputEqMid?.gain, next);
    else if (name === 'eqHighDb') target(this.outputEqHigh?.gain, next);
    else if (name === 'echoTimeMs') target(this.outputEcho?.delayTime, next / 1000);
    else if (name === 'echoFeedback') target(this.outputEchoFeedback?.gain, next);
    else target(this.outputEchoWet?.gain, next * .45);
  }
  setInstrumentEnabled(instrument: Instrument, enabled: boolean, at = this.context?.currentTime ?? 0, updateState = true) {
    if (updateState) this.instrumentEnabled[instrument] = Boolean(enabled);
    if (!this.context) return;
    const start = Math.max(at, this.context.currentTime);
    const schedule = (parameter: AudioParam, target: number) => {
      const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
      if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(start);
      else controlled.cancelScheduledValues(start);
      controlled.setTargetAtTime(target, start, .01);
    };
    const target = enabled ? this.volumes[instrument] : 0;
    const gain = this.instruments.get(instrument);
    if (gain) schedule(gain.gain, target);
    (['deckA', 'deckB', 'solo'] as const).forEach((lane) => { const laneGain = this.laneInstrumentGains.get(`${lane}:${instrument}`); if (laneGain) schedule(laneGain.gain, enabled ? 1 : 0); });
  }
  /** Apply only the logical state at a cue boundary. Audio automation was
   * already installed by setInstrumentEnabled(..., updateState=false). */
  commitInstrumentEnabled(instrument: Instrument, enabled: boolean, _at = this.context?.currentTime ?? 0) {
    this.instrumentEnabled[instrument] = Boolean(enabled);
  }
  isInstrumentEnabled(instrument: Instrument) { return this.instrumentEnabled[instrument]; }
  setLaneGain(lane: Exclude<VoiceLane, 'deck'>, value: number, at = this.context?.currentTime ?? 0, duration = .01) {
    const bus = this.laneBuses.get(lane);
    if (!bus || !this.context) return;
    const parameter = bus.gain;
    parameter.setTargetAtTime(clamp(value), at, Math.max(.001, duration));
  }
  setLaneGainRamp(lane: Exclude<VoiceLane, 'deck'>, value: number, at = this.context?.currentTime ?? 0, duration = .01) {
    const bus = this.laneBuses.get(lane);
    if (!bus || !this.context) return;
    const parameter = bus.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Math.max(at, this.context.currentTime);
    const end = start + Math.max(.001, duration);
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
    parameter.linearRampToValueAtTime(clamp(value), end);
  }
  cancelLaneGainAutomation(lane: Exclude<VoiceLane, 'deck'>, at = this.context?.currentTime ?? 0) {
    const bus = this.laneBuses.get(lane);
    if (!bus || !this.context) return;
    const parameter = bus.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    const start = Math.max(at, this.context.currentTime);
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(start);
    else parameter.cancelScheduledValues(start);
  }
  cancelInstrumentAutomation(instrument: Instrument, at = this.context?.currentTime ?? 0) {
    if (!this.context) return;
    const start = Math.max(at, this.context.currentTime);
    const cancel = (parameter: AudioParam) => {
      const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
      if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(start);
      else controlled.cancelScheduledValues(start);
    };
    const gain = this.instruments.get(instrument);
    if (gain) cancel(gain.gain);
    (['deckA', 'deckB', 'solo'] as const).forEach((lane) => { const laneGain = this.laneInstrumentGains.get(`${lane}:${instrument}`); if (laneGain) cancel(laneGain.gain); });
  }
  laneGain(lane: Exclude<VoiceLane, 'deck'>) { return this.laneBuses.get(lane)?.gain.value ?? (lane === 'live' || lane === 'solo' ? 1 : 0); }
  getSoundProfile(instrument: DeckInstrument, presetId: string): DeckSoundProfile {
    const parameters = Object.entries(this.parameters[instrument]).reduce<Record<string, number>>((values, [name, parameter]) => {
      values[name] = parameter.value;
      return values;
    }, {});
    return {
      presetId,
      controls: { ...this.controls[instrument] },
      parameters,
      volume: this.volumes[instrument],
      ...(instrument === 'drums' ? { drumModel: this.drumModel } : {}),
    };
  }
  setParameter(instrument: Instrument, name: string, value: number) {
    const parameter = this.parameters[instrument][name];
    if (!parameter) return;
    parameter.value = Number.isFinite(value) ? Math.min(parameter.max, Math.max(parameter.min, value)) : parameter.value;
    if (instrument === 'bass' && this.context) this.updateBassLaneProfile('live', undefined);
  }
  resetParameter(instrument: Instrument, presetIndex: number, name: string) {
    const baseParameters = this.baseParameters[instrument];
    const presetValue = presetProfiles[instrument][presetIndex]?.parameters[name] ?? baseParameters[name]?.value;
    if (presetValue !== undefined) this.setParameter(instrument, name, presetValue);
  }
  loadPreset(instrument: Instrument, index: number) {
    const profile = presetProfiles[instrument][index];
    if (!profile) return;
    this.presetIndexes[instrument] = index;
    this.controls[instrument] = { ...profile.controls };
    this.volumes[instrument] = profile.volume;
    const baseParameters = this.baseParameters[instrument];
    Object.keys(this.parameters[instrument]).forEach((name) => {
      this.setParameter(instrument, name, profile.parameters[name] ?? baseParameters[name].value);
    });
    const gain = this.instruments.get(instrument);
    if (gain && this.context) gain.gain.setTargetAtTime(profile.volume, this.context.currentTime, .01);
    if (instrument === 'bass' && this.context) this.updateBassLaneProfile('live', undefined);
  }
  private laneOutput(instrument: Instrument, lane: VoiceLane) {
    if (lane === 'live' || lane === 'deck') return this.instruments.get(instrument)!;
    return this.laneInstrumentGains.get(`${lane}:${instrument}`) ?? this.instruments.get(instrument)!;
  }
  private bassShape(control: number): OscillatorType {
    return control < .25 ? 'sine' : control < .55 ? 'triangle' : control < .8 ? 'sawtooth' : 'square';
  }
  private bassDriveCurve(drive: number) {
    const curve = new Float32Array(257);
    if (drive <= 0) {
      for (let index = 0; index < curve.length; index++) curve[index] = index * 2 / (curve.length - 1) - 1;
      return curve;
    }
    const amount = 1 + drive * 45;
    for (let index = 0; index < curve.length; index++) {
      const x = index * 2 / (curve.length - 1) - 1;
      curve[index] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
    }
    return curve;
  }
  private ensureBassLane(lane: VoiceLane) {
    const existing = this.bassLanes.get(lane);
    if (existing) return existing;
    if (!this.context) return null;
    const ctx = this.context;
    const main = this.ownGraphNode(ctx.createOscillator());
    const sub = this.ownGraphNode(ctx.createOscillator());
    const click = this.ownGraphNode(ctx.createOscillator());
    const mainGain = this.ownGraphNode(ctx.createGain());
    const subGain = this.ownGraphNode(ctx.createGain());
    const envelope = this.ownGraphNode(ctx.createGain());
    const clickGain = this.ownGraphNode(ctx.createGain());
    const filter = this.ownGraphNode(ctx.createBiquadFilter());
    const clickFilter = this.ownGraphNode(ctx.createBiquadFilter());
    const shaper = this.ownGraphNode(ctx.createWaveShaper());
    const gate = this.ownGraphNode(ctx.createGain());
    const profileGain = this.ownGraphNode(ctx.createGain());
    mainGain.gain.value = .7;
    subGain.gain.value = 0;
    envelope.gain.value = 0;
    clickGain.gain.value = 0;
    gate.gain.value = 0;
    profileGain.gain.value = 1;
    filter.type = 'lowpass';
    clickFilter.type = 'highpass';
    main.connect(mainGain).connect(envelope).connect(filter).connect(shaper).connect(gate).connect(profileGain).connect(this.laneOutput('bass', lane));
    sub.connect(subGain).connect(envelope);
    click.connect(clickGain).connect(clickFilter).connect(gate);
    main.start();
    sub.start();
    click.start();
    this.trackPersistentSource(main, lane);
    this.trackPersistentSource(sub, lane);
    this.trackPersistentSource(click, lane);
    const created: PersistentBassLane = {
      lane, main, sub, click, mainGain, subGain, envelope, clickGain, filter, clickFilter, shaper, gate, profileGain,
      envelopeState: new BassVcaController(0), clickState: new BassVcaController(0), vca: new BassVcaController(0), current: null,
      profileState: null,
    };
    this.bassLanes.set(lane, created);
    this.installBassLaneProfile(created, this.buildBassLaneProfile(created), ctx.currentTime);
    return created;
  }
  private buildBassLaneProfile(lane: PersistentBassLane, profile?: DeckSoundProfile): BassLaneProfile {
    const context = this.context!;
    const c = profile?.controls ?? this.controls.bass;
    const bass = this.parametersFor('bass', profile);
    const graph: BassGraphProfile = {
      mainType: this.bassShape(c.shape),
      subType: 'sine',
      clickType: 'triangle',
      mainGain: .7,
      subLevel: bass.subLevel.value,
      filterHz: Math.min(context.sampleRate / 2 - 100, bass.filterHz.value * (.5 + c.tone * 1.25)),
      clickHz: bass.clickHz.value,
      clickFilterHz: Math.min(context.sampleRate / 2 - 100, bass.clickHz.value * .7),
      drive: c.drive,
      oversample: '2x',
      profileGain: 1,
    };
    const liveVolume = lane.lane === 'live' ? this.volumes.bass : 1;
    graph.profileGain = profile ? profile.volume / Math.max(.001, liveVolume) : 1;
    const liveFingerprint = JSON.stringify(['live', sortedRecordEntries(this.controls.bass), sortedRecordEntries(Object.fromEntries(Object.entries(this.parameters.bass).map(([name, parameter]) => [name, parameter.value]))), this.volumes.bass]);
    return { profile, fingerprint: profile ? bassDeckProfileFingerprint(profile) : liveFingerprint, graph, graphFingerprint: bassGraphProfileFingerprint(graph) };
  }
  private installBassLaneProfile(lane: PersistentBassLane, state: BassLaneProfile, at: number) {
    if (!this.context) return;
    const previous = lane.profileState?.graph;
    const start = Number.isFinite(at) ? at : this.context.currentTime;
    if (!previous || previous.mainType !== state.graph.mainType) lane.main.type = state.graph.mainType;
    if (!previous || previous.subType !== state.graph.subType) lane.sub.type = state.graph.subType;
    if (!previous || previous.clickType !== state.graph.clickType) lane.click.type = state.graph.clickType;
    if (!previous || previous.mainGain !== state.graph.mainGain) lane.mainGain.gain.setValueAtTime(state.graph.mainGain, start);
    if (!previous || previous.subLevel !== state.graph.subLevel) lane.subGain.gain.setValueAtTime(state.graph.subLevel, start);
    if (!previous || previous.filterHz !== state.graph.filterHz) lane.filter.frequency.setValueAtTime(state.graph.filterHz, start);
    if (!previous || previous.clickHz !== state.graph.clickHz) lane.click.frequency.setValueAtTime(state.graph.clickHz, start);
    if (!previous || previous.clickFilterHz !== state.graph.clickFilterHz) lane.clickFilter.frequency.setValueAtTime(state.graph.clickFilterHz, start);
    if (!previous || previous.drive !== state.graph.drive) lane.shaper.curve = this.bassDriveCurve(state.graph.drive);
    if (!previous || previous.oversample !== state.graph.oversample) lane.shaper.oversample = state.graph.oversample;
    if (!previous || previous.profileGain !== state.graph.profileGain) lane.profileGain.gain.setValueAtTime(state.graph.profileGain, start);
    lane.profile = state.profile;
    lane.profileState = state;
    lane.pendingProfile = undefined;
  }
  private bassLaneIsSilent(lane: PersistentBassLane, at = this.context?.currentTime ?? 0) {
    return lane.vca.valueAt(at) <= .0001;
  }
  private clearPendingBassProfileTimer(lane: PersistentBassLane) {
    if (lane.pendingProfileTimer === undefined) return;
    if (typeof window !== 'undefined') window.clearTimeout(lane.pendingProfileTimer);
    else clearTimeout(lane.pendingProfileTimer as unknown as ReturnType<typeof setTimeout>);
    lane.pendingProfileTimer = undefined;
  }
  private schedulePendingBassProfile(lane: PersistentBassLane) {
    this.clearPendingBassProfileTimer(lane);
    if (!lane.pendingProfile || !this.context) return;
    const now = this.context.currentTime;
    if (lane.current?.releaseEnd === undefined) return;
    const silentAt = Math.max(now, lane.current.releaseEnd);
    const delay = Math.max(0, (silentAt - now) * 1000);
    const apply = () => {
      lane.pendingProfileTimer = undefined;
      if (this.context && this.bassLaneIsSilent(lane)) this.applyPendingBassProfileIfSilent(lane);
    };
    lane.pendingProfileTimer = typeof window !== 'undefined'
      ? window.setTimeout(apply, delay)
      : setTimeout(apply, delay) as unknown as number;
  }
  private applyPendingBassProfileIfSilent(lane: PersistentBassLane) {
    if (!lane.pendingProfile || !this.context || !this.bassLaneIsSilent(lane)) return false;
    this.clearPendingBassProfileTimer(lane);
    this.installBassLaneProfile(lane, lane.pendingProfile, this.context.currentTime);
    return true;
  }
  private retireBassLaneNote(lane: PersistentBassLane, token: number, heldId?: string) {
    if (lane.current?.token !== token) return false;
    lane.current = null;
    if (lane.currentHeldId === heldId) lane.currentHeldId = undefined;
    return true;
  }
  private scheduleBassEnvelopeReset(lane: PersistentBassLane, at: number, token: number) {
    if (lane.envelopeResetToken !== undefined && lane.envelopeResetToken !== token) return undefined;
    lane.envelopeResetToken = token;
    return this.scheduleBassVca(lane.envelope, lane.envelopeState, 0, at, 0, false);
  }
  /** Installs a bass profile explicitly; ordinary note-on never calls this. */
  updateBassLaneProfile(laneName: VoiceLane, profile?: DeckSoundProfile, at = this.context?.currentTime ?? 0) {
    const lane = this.ensureBassLane(laneName);
    if (!lane || !this.context) return { applied: false, deferred: false };
    const desired = this.buildBassLaneProfile(lane, profile);
    if (lane.profileState?.fingerprint === desired.fingerprint) {
      lane.pendingProfile = undefined;
      return { applied: true, deferred: false, changed: false };
    }
    if (lane.profileState?.graphFingerprint === desired.graphFingerprint) {
      lane.profile = desired.profile;
      lane.profileState = desired;
      lane.pendingProfile = undefined;
      return { applied: true, deferred: false, changed: true };
    }
    if (this.bassLaneIsSilent(lane)) {
      this.installBassLaneProfile(lane, desired, this.context.currentTime);
      return { applied: true, deferred: false, changed: true };
    }
    lane.pendingProfile = desired;
    this.schedulePendingBassProfile(lane);
    return { applied: false, deferred: true, changed: true, at };
  }
  private output(instrument: Instrument) { return this.eventDestination ?? this.laneOutput(instrument, this.eventLane); }
  private eventOutput(instrument: Instrument, profile: DeckSoundProfile | undefined, lane: VoiceLane, velocity: number, room = 0) {
    const destination = this.profileDestination(instrument, profile, room, lane);
    this.eventProfileDestination = destination;
    const base = destination?.output ?? this.laneOutput(instrument, lane);
    const amount = clamp(velocity);
    if (amount >= .999) return base;
    const gain = this.ownGraphNode(this.context!.createGain());
    gain.gain.setValueAtTime(amount, this.context!.currentTime);
    gain.connect(base);
    return gain;
  }
  private now() { return this.context!.currentTime; }
  private recordBassReleaseMarker(requestedAt: number, timing: BassVcaTiming, cause: PendingBassRelease['cause'], lane: VoiceLane, voiceId?: string) {
    this.pendingBassReleases.push({ requestedAt, scheduledAt: timing.scheduledAt, safetyOffsetSeconds: timing.safetyOffsetSeconds, cause, lane, voiceId });
    if (this.pendingBassReleases.length > 24) this.pendingBassReleases.shift();
  }
  private captureBassReleaseDiagnostic() {
    if (!this.outputAnalyser || !this.context) return;
    const now = this.context.currentTime;
    this.pendingBassReleases = this.pendingBassReleases.filter((marker) => now - marker.requestedAt < .15);
    const marker = this.pendingBassReleases.shift();
    if (marker === undefined) return;
    this.outputAnalyser.getFloatTimeDomainData(this.outputTimeBuffer);
    let peak = 0;
    let sumSquares = 0;
    let maxAdjacentSampleDelta = 0;
    for (let index = 0; index < this.outputTimeBuffer.length; index++) {
      const sample = this.outputTimeBuffer[index];
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
      if (index > 0) maxAdjacentSampleDelta = Math.max(maxAdjacentSampleDelta, Math.abs(sample - this.outputTimeBuffer[index - 1]));
    }
    const releaseWindow = analyseBassReleaseWindow(
      this.outputTimeBuffer,
      this.context.sampleRate,
      now,
      marker.scheduledAt,
    );
    this.bassReleaseDiagnostics.push({
      releaseAt: marker.requestedAt,
      ...marker,
      capturedAt: now,
      sampleRate: this.context.sampleRate,
      sampleCount: this.outputTimeBuffer.length,
      windowSeconds: this.outputTimeBuffer.length / this.context.sampleRate,
      peak,
      rms: Math.sqrt(sumSquares / this.outputTimeBuffer.length),
      maxAdjacentSampleDelta,
      ...releaseWindow,
    });
    if (this.bassReleaseDiagnostics.length > 24) this.bassReleaseDiagnostics.shift();
  }
  readOutputSpectrum(buffer: Float32Array<ArrayBuffer>) {
    if (!this.outputAnalyser) {
      buffer.fill(-100);
      return false;
    }
    this.outputAnalyser.getFloatFrequencyData(buffer);
    this.captureBassReleaseDiagnostic();
    return true;
  }
  getBassReleaseDiagnostics() { return this.bassReleaseDiagnostics.map((diagnostic) => ({ ...diagnostic })); }
  getPresetIndexes() { return { ...this.presetIndexes }; }
  getVoiceStats() {
    const groups = (values: VoiceGroup[]) => ({ groups: values.length, active: values.filter((group) => group.state === 'active').length, releasing: values.filter((group) => group.state === 'releasing').length, voices: values.reduce((count, group) => count + group.voices.length, 0), musicalVoices: values.reduce((count, group) => count + group.voiceCount, 0) });
    const now = this.context?.currentTime ?? 0;
    const bass = {
      groups: this.bassLanes.size,
      active: [...this.bassLanes.values()].filter((lane) => lane.current !== null && !(lane.current.releaseEnd !== undefined && now >= (lane.current.gateEnd ?? 0)) && lane.vca.valueAt(now) > .0001).length,
      releasing: [...this.bassLanes.values()].filter((lane) => lane.current !== null && lane.current.releaseEnd !== undefined && now < lane.current.releaseEnd && now >= (lane.current.gateEnd ?? 0)).length,
      voices: this.bassLanes.size * 3,
      musicalVoices: [...this.bassLanes.values()].filter((lane) => lane.current !== null).length,
    };
    return { bass, lead: groups(this.leadVoices), chords: groups(this.chordVoices), activeSources: this.activeSources.size };
  }
  /** Stats for the instruments that remain on the legacy path when a hybrid
   * engine wraps this instance. The full legacy stats stay available through
   * getVoiceStats() for direct rollback/A-B tests. */
  getLegacyOnlyVoiceStats() {
    const stats = this.getVoiceStats();
    const migratedSources = this.persistentBassSources.size
      + this.leadVoices.reduce((count, group) => count + group.voices.length, 0)
      + this.chordVoices.reduce((count, group) => count + group.voices.length, 0);
    return {
      bass: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
      lead: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
      chords: { groups: 0, active: 0, releasing: 0, voices: 0, musicalVoices: 0 },
      activeSources: Math.max(0, stats.activeSources - migratedSources),
    };
  }
  getSynthSnapshot() {
    return {
      context: { state: this.context?.state ?? null, currentTime: this.context?.currentTime ?? null, sampleRate: this.context?.sampleRate ?? null },
      tempo: this.tempo,
      drumModel: this.drumModel,
      presetIndexes: this.getPresetIndexes(),
      instrumentEnabled: { ...this.instrumentEnabled },
      controls: JSON.parse(JSON.stringify(this.controls)) as Record<Instrument, Controls>,
      volumes: { ...this.volumes },
      outputControls: { ...this.outputControls },
      parameters: JSON.parse(JSON.stringify(this.parameters)) as Record<Instrument, Record<string, Parameter>>,
      heldNotes: Array.from(this.heldNotes.entries()).map(([id, voices]) => ({ id, kind: this.heldNoteKinds.get(id) ?? null, voiceCount: this.heldNoteKinds.get(id) === 'bass' ? 1 : voices.length })),
      voiceStats: this.getVoiceStats(),
      bassLanes: [...this.bassLanes.values()].map((lane) => ({
        lane: lane.lane,
        persistent: true,
        currentMidi: lane.current?.midi ?? null,
        currentHeldId: lane.currentHeldId ?? null,
        profilePresetId: lane.profile?.presetId ?? null,
        graphProfile: lane.profileState?.graph ?? null,
        pendingProfilePresetId: lane.pendingProfile?.profile?.presetId ?? null,
        pendingGraphProfile: lane.pendingProfile?.graph ?? null,
        envelopeSegments: lane.envelopeState.segments(),
        vcaSegments: lane.vca.segments(),
      })),
      bassReleaseDiagnostics: this.getBassReleaseDiagnostics(),
    };
  }
  private profileDestination(instrument: Instrument, profile?: DeckSoundProfile, room = 0, lane: VoiceLane = this.eventLane) {
    if (!profile || !this.master || !this.context) return null;
    const liveVolume = lane === 'live' ? this.volumes[instrument] : 1;
    const key = JSON.stringify([instrument, room, lane, liveVolume, profile.presetId, Object.entries(profile.controls).sort(), Object.entries(profile.parameters).sort(), profile.volume, profile.drumModel ?? null]);
    const cached = this.profileDestinations.get(key);
    if (cached) return cached;
    const gain = this.ownGraphNode(this.context.createGain());
    const nodes: AudioNode[] = [gain];
    // The live instrument bus already contains the instrument volume. Profile
    // destinations compensate for that bus so a profiled live event is not
    // attenuated twice. Deck and solo lane instrument gains are unity here.
    gain.gain.setValueAtTime(profile.volume / Math.max(.001, liveVolume), this.context.currentTime);
    gain.connect(this.laneOutput(instrument, lane));
    if (room > .001) {
      const delay = this.ownGraphNode(this.context.createDelay(.3));
      const roomGain = this.ownGraphNode(this.context.createGain());
      nodes.push(delay, roomGain);
      delay.delayTime.value = .075;
      roomGain.gain.value = room * .18;
      gain.connect(delay).connect(roomGain).connect(this.laneOutput(instrument, lane));
    }
    if (this.profileDestinations.size >= 32) {
      const oldest = [...this.profileDestinations.entries()].find(([, value]) => value.users === 0) ?? this.profileDestinations.entries().next().value as [string, CachedProfileDestination] | undefined;
      if (oldest) {
        this.profileDestinations.delete(oldest[0]);
        if (oldest[1].users === 0) oldest[1].nodes.forEach((node) => { try { node.disconnect(); } catch { /* already disconnected */ } this.ownedGraphNodes.delete(node); });
      }
    }
    const destination = { output: gain, nodes, users: 0 };
    this.profileDestinations.set(key, destination);
    return destination;
  }
  profileDestinationCacheSize() { return this.profileDestinations.size; }
  private trackSource(source: AudioScheduledSourceNode, collection?: Set<AudioScheduledSourceNode>, lane = this.eventLane) {
    this.activeSources.add(source);
    this.sourceLanes.set(source, lane);
    if (this.eventProfileDestination) {
      this.eventProfileDestination.users += 1;
      this.sourceProfileDestinations.set(source, this.eventProfileDestination);
    }
    if (this.eventIsDeck || this.eventLane === 'deckA' || this.eventLane === 'deckB') this.deckSources.add(source);
    if (this.eventIsDebug) this.debugSources.add(source);
    collection?.add(source);
    source.addEventListener('ended', () => {
      this.activeSources.delete(source);
      this.deckSources.delete(source);
      this.sourceLanes.delete(source);
      const profileDestination = this.sourceProfileDestinations.get(source);
      if (profileDestination) profileDestination.users = Math.max(0, profileDestination.users - 1);
      this.sourceProfileDestinations.delete(source);
      collection?.delete(source);
      this.openHatHits = this.openHatHits.filter((hit) => hit.sources.size > 0);
      this.debugSources.delete(source);
    });
    return source;
  }
  private silenceGain(gain: GainNode, at: number, duration = .012) {
    if (!this.context) return;
    const fade = Number.isFinite(duration) ? Math.max(.012, duration) : .012;
    const parameter = gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(at);
    else {
      parameter.cancelScheduledValues(at);
      parameter.setValueAtTime(Math.max(.0001, parameter.value), at);
    }
    parameter.exponentialRampToValueAtTime(.0001, at + fade);
  }

  private linearFadeGain(gain: GainNode, at: number, duration = .012) {
    if (!this.context) return;
    const fade = safeReleaseDuration(duration);
    const parameter = gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(at);
    else {
      parameter.cancelScheduledValues(at);
      parameter.setValueAtTime(Math.max(0, parameter.value), at);
    }
    parameter.linearRampToValueAtTime(0, at + fade);
  }

  private scheduleBassVca(gain: GainNode, controller: BassVcaController, to: number, requestedAt: number, duration: number, protectLateAutomation = false): BassVcaScheduleResult {
    const timing = bassVcaAutomationTiming(requestedAt, this.context?.currentTime ?? requestedAt, this.context?.sampleRate ?? 48000, protectLateAutomation);
    const curve = controller.schedule(to, timing.scheduledAt, duration);
    if (!this.context) return { ...timing, end: curve.end };
    const parameter = gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof parameter.cancelAndHoldAtTime === 'function') {
      // The browser owns the held value. The JS controller remains an
      // advisory timeline and must never replace that native value at an
      // interrupted transition.
      parameter.cancelAndHoldAtTime(curve.start);
      if (curve.duration <= .000001) parameter.setValueAtTime(curve.to, curve.start);
      else parameter.linearRampToValueAtTime(curve.to, curve.end);
    } else {
      // Older engines have no way to read the held automation value. Use the
      // model only as a compatibility anchor, then use the same linear ramp.
      parameter.cancelScheduledValues(curve.start);
      parameter.setValueAtTime(curve.from, curve.start);
      if (curve.duration <= .000001) parameter.setValueAtTime(curve.to, curve.start);
      else parameter.linearRampToValueAtTime(curve.to, curve.end);
    }
    return { ...timing, end: curve.end };
  }

  debugTone(frequency: number, duration: number, waveform: OscillatorType = 'sine', gainAmount = .08, attack = .005, release = .03, delay = 0) {
    if (!this.context || !this.master) return null;
    const ctx = this.context;
    const start = ctx.currentTime + Math.max(0, delay) / 1000 + .0059;
    const length = Math.max(.01, duration / 1000);
    const attackTime = Math.min(length * .5, Math.max(.001, attack / 1000));
    const releaseTime = Math.max(.005, release / 1000);
    const osc = this.ownGraphNode(ctx.createOscillator());
    const gain = this.ownGraphNode(ctx.createGain());
    osc.type = waveform;
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(Math.max(0, gainAmount), start + attackTime);
    gain.gain.setValueAtTime(Math.max(0, gainAmount), start + length);
    gain.gain.linearRampToValueAtTime(0, start + length + releaseTime);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + length + releaseTime + .01);
    this.eventIsDebug = true;
    this.trackSource(osc);
    this.eventIsDebug = false;
    return { requestedAt: start - .0059 - Math.max(0, delay) / 1000, scheduledAt: start, end: start + length + releaseTime };
  }
  debugDrum(index: number, at: number, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    const previous = this.eventIsDebug;
    this.eventIsDebug = true;
    try { this.drum(index, at, profile, lane === 'deckA' || lane === 'deckB', lane, velocity); } finally { this.eventIsDebug = previous; }
  }
  debugNote(instrument: 'bass' | 'lead', midi: number, duration: number, at: number, profile?: DeckSoundProfile, lane: VoiceLane = 'live', velocity = 1) {
    const previous = this.eventIsDebug;
    this.eventIsDebug = true;
    try {
      if (instrument === 'bass') this.updateBassLaneProfile(lane, profile, at);
      return this.note(instrument, midi, duration, at, profile, lane === 'deckA' || lane === 'deckB', lane, velocity);
    } finally { this.eventIsDebug = previous; }
  }
  holdDebugNote(id: string, instrument: 'bass' | 'lead', midi: number) {
    const voices = this.holdNote(id, instrument, midi);
    if (voices.length) this.debugHeldIds.add(id);
    return voices;
  }
  stopDebugVoices() {
    [...this.debugHeldIds].forEach((id) => this.releaseNote(id));
    this.debugHeldIds.clear();
    this.stopSources(this.debugSources);
  }

  private releaseEnvelope(gain: GainNode, at: number, duration: number) {
    if (!this.context) return;
    const release = safeReleaseDuration(duration);
    const parameter = gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(at);
    else {
      parameter.cancelScheduledValues(at);
      parameter.setValueAtTime(Math.max(.0001, parameter.value), at);
    }
    parameter.exponentialRampToValueAtTime(.0001, at + release);
  }

  private closeOpenHats(at: number, lane: VoiceLane) {
    const hits = this.openHatHits.filter((hit) => hit.lane === lane);
    this.openHatHits = this.openHatHits.filter((hit) => hit.lane !== lane);
    hits.forEach((hit) => {
      this.silenceGain(hit.gain, at, .008);
      hit.sources.forEach((source) => {
        try { source.stop(at + .012); } catch { /* already stopped */ }
      });
    });
  }

  private registerVoiceGroup(group: VoiceGroup) {
    let remaining = group.voices.length;
    group.voices.forEach((osc) => osc.addEventListener('ended', () => {
      remaining -= 1;
      if (remaining <= 0) this.removeVoiceGroup(group);
    }));
  }

  private removeVoiceGroup(group: VoiceGroup) {
    group.state = voiceGroupStopState(group.state);
    this.leadVoices = this.leadVoices.filter((entry) => entry !== group);
    this.chordVoices = this.chordVoices.filter((entry) => entry !== group);
  }

  private terminateGroup(group: VoiceGroup, at: number, duration = FADE_SECONDS, atIsSafe = false) {
    if (group.state === 'stopped') return;
    group.state = voiceGroupStopState(group.state);
    const fade = Number.isFinite(duration) ? Math.max(.012, duration) : FADE_SECONDS;
    const result = group.choke?.(at, fade, atIsSafe);
    const stopAt = result && 'end' in result ? result.end + .01 : at + fade + .01;
    group.voices.forEach((osc) => {
      try { osc.stop(stopAt); } catch { /* already stopped or naturally scheduled */ }
    });
  }

  private releaseGroup(group: VoiceGroup, at: number, duration: number): BassVcaScheduleResult | undefined {
    if (group.state !== 'active') return undefined;
    group.state = voiceGroupReleaseState(group.state);
    const release = safeReleaseDuration(duration);
    const result = group.release?.(at, release);
    const stopAt = result && 'end' in result ? result.end + .01 : releaseEndTime(at, release) + .01;
    group.voices.forEach((osc) => {
      try { osc.stop(stopAt); } catch { /* already stopped or naturally scheduled */ }
    });
    return result && 'end' in result ? result : undefined;
  }

  private trimVoiceGroups(groups: VoiceGroup[], maxVoices: number, incomingVoices: number, at: number, lane: VoiceLane) {
    while (countMusicalVoicesInLane(groups, lane) + incomingVoices > maxVoices) {
      const index = groups.reduce((oldestIndex, group, groupIndex) => {
        if (group.state !== 'active' || group.lane !== lane || group.at > at + .001) return oldestIndex;
        return oldestIndex < 0 || group.at < groups[oldestIndex].at ? groupIndex : oldestIndex;
      }, -1);
      if (index < 0) break;
      this.terminateGroup(groups[index], at);
    }
  }
  private chokeGroups(groups: VoiceGroup[], at: number, lane: VoiceLane) {
    groups.forEach((entry) => {
      if (canChokeVoiceGroup(entry, lane, at)) this.terminateGroup(entry, at);
    });
    return groups;
  }
  private chokeBass(at: number, lane: VoiceLane, atIsSafe = false, duration = FADE_SECONDS) {
    this.stopBassLane(lane, at);
    return [] as VoiceGroup[];
  }
  private releaseVoiceGroups(voices: OscillatorNode[], at: number, duration: number): BassVcaScheduleResult | undefined {
    const voiceSet = new Set(voices);
    const release = (groups: VoiceGroup[], captureResult = false) => {
      let result: BassVcaScheduleResult | undefined;
      groups.forEach((group) => {
        if (group.voices.some((voice) => voiceSet.has(voice))) {
          const next = this.releaseGroup(group, at, duration);
          if (captureResult && next) result = next;
        }
      });
      return result;
    };
    release(this.leadVoices);
    release(this.chordVoices);
    return undefined;
  }
  private stopDeckGroups(at: number, lane?: VoiceLane) {
    const stopDeck = (groups: VoiceGroup[]) => {
      groups.forEach((group) => {
        if ((group.lane === 'deck' || group.lane === 'deckA' || group.lane === 'deckB') && (!lane || group.lane === lane)) this.terminateGroup(group, at);
      });
    };
    stopDeck(this.leadVoices);
    stopDeck(this.chordVoices);
  }
  private parametersFor(instrument: DeckInstrument, profile?: DeckSoundProfile) {
    if (!profile) return this.parameters[instrument];
    return Object.entries(this.parameters[instrument]).reduce<Record<string, Parameter>>((values, [name, parameter]) => {
      values[name] = { ...parameter, value: profile.parameters[name] ?? parameter.value };
      return values;
    }, {});
  }

  private leadVoiceLimit(profile?: DeckSoundProfile) {
    // Bright Mono, Pulse Lead, and Distorted retrigger as one voice. The softer
    // and string-like presets keep four-note polyphony.
    if (profile) {
      const presetId = profile.presetId.trim().toLowerCase();
      return new Set(['bright mono', 'pulse lead', 'distorted', 'lead-0', 'lead-2', 'lead-4']).has(presetId) ? 1 : 4;
    }
    return [0, 2, 4].includes(this.presetIndexes.lead) ? 1 : 4;
  }

  private createNoiseBuffer(seconds: number) {
    const ctx = this.context!;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private leadChorus(parameters: Record<string, Parameter>, start: number, stop: number | null): { input: AudioNode; stop?: (at: number, duration?: number) => void; release?: (at: number, duration: number) => void } {
    const ctx = this.context!;
    const output = this.output('lead');
    const mix = clamp(parameters.chorusMix.value);
    if (mix <= 0) return { input: output };

    const input = ctx.createGain();
    const dry = ctx.createGain();
    const delaySeconds = parameters.chorusDelayMs.value / 1000;
    const depthSeconds = Math.min(parameters.chorusDepthMs.value / 1000, delaySeconds * .9);
    input.connect(dry).connect(output);
    dry.gain.value = 1 - mix * .35;
    const taps = [
      { delay: delaySeconds, depth: depthSeconds, rate: parameters.chorusRateHz.value },
      { delay: Math.min(.09, delaySeconds * 1.55), depth: depthSeconds * .82, rate: parameters.chorusRateHz.value * 1.17 },
      { delay: Math.min(.09, delaySeconds * .72), depth: depthSeconds * .62, rate: parameters.chorusRateHz.value * .83 },
    ];
    const tapGains: GainNode[] = [];
    const lfos: OscillatorNode[] = [];
    taps.forEach((tap) => {
      const delay = ctx.createDelay(.1);
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      const tapWet = ctx.createGain();
      input.connect(delay).connect(tapWet).connect(output);
      tapWet.gain.value = mix / taps.length;
      tapGains.push(tapWet);
      delay.delayTime.setValueAtTime(tap.delay, start);
      lfo.frequency.setValueAtTime(tap.rate, start);
      depth.gain.setValueAtTime(Math.min(tap.depth, tap.delay * .9), start);
      lfo.connect(depth).connect(delay.delayTime);
      lfo.start(start);
      if (stop !== null) lfo.stop(stop + .05);
      lfos.push(lfo);
      this.trackSource(lfo);
    });
    return {
      input,
      stop: (at: number, duration = .012) => {
        this.silenceGain(dry, at, duration);
        tapGains.forEach((tapGain) => this.silenceGain(tapGain, at, duration));
        lfos.forEach((lfo) => {
          try { lfo.stop(at + Math.max(.012, duration) + .02); } catch { /* already stopped */ }
        });
      },
      release: (at: number, duration: number) => {
        lfos.forEach((lfo) => {
          try { lfo.stop(at + Math.max(.012, duration) + .05); } catch { /* already stopped */ }
        });
      },
    };
  }

  private adsrOscillator(instrument: Instrument, frequency: number, type: OscillatorType, attack: number, decay: number, sustain: number, gateDuration: number | null, release: number, gainAmount: number, start = this.now(), destination: AudioNode = this.output(instrument), scheduleRelease = true) {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const peak = Math.max(.0002, gainAmount);
    const sustainAmount = Math.max(.0002, peak * Math.min(1, Math.max(.01, sustain)));
    const gate = safeGateDuration(gateDuration);
    const attackTime = gate === null ? attack : Math.min(attack, gate * .35);
    const decayTime = gate === null ? decay : Math.min(decay, Math.max(0, gate - attackTime));
    const attackAt = start + attackTime;
    const decayAt = attackAt + decayTime;
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(.0001, start);
    if (attackTime > 0) gain.gain.exponentialRampToValueAtTime(peak, attackAt);
    else gain.gain.setValueAtTime(peak, start);
    if (decayTime > 0) gain.gain.exponentialRampToValueAtTime(sustainAmount, decayAt);
    else gain.gain.setValueAtTime(sustainAmount, decayAt);
    osc.connect(gain).connect(destination);
    osc.start(start);
    if (gate !== null && scheduleRelease) {
      const releaseAt = start + gate;
      const end = releaseAt + Math.max(.012, release);
      const parameter = gain.gain as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
      if (typeof parameter.cancelAndHoldAtTime === 'function') parameter.cancelAndHoldAtTime(releaseAt);
      else {
        parameter.cancelScheduledValues(releaseAt);
        parameter.setValueAtTime(adsrLevelAt(gate, attackTime, decayTime, peak, sustainAmount), releaseAt);
      }
      gain.gain.exponentialRampToValueAtTime(.0001, end);
      osc.stop(end + .03);
    }
    this.active.push(osc);
    this.voiceGains.set(osc, gain);
    this.trackSource(osc);
    osc.addEventListener('ended', () => { this.active = this.active.filter((item) => item !== osc); this.voiceGains.delete(osc); });
    return { osc, gain };
  }

  private resonator(instrument: Instrument, frequency: number, type: OscillatorType, duration: number, gainAmount: number, filterType: BiquadFilterType, filterFrequency: number, q: number, start = this.now(), collection?: Set<AudioScheduledSourceNode>, destination: AudioNode = this.output(instrument)) {
    const ctx = this.context!;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, start);
    filter.type = filterType;
    filter.frequency.value = Math.min(ctx.sampleRate / 2 - 100, filterFrequency);
    filter.Q.value = q;
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, gainAmount), start + .002);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(filter).connect(gain).connect(destination);
    osc.start(start); osc.stop(start + duration + .03);
    this.active.push(osc); this.voiceGains.set(osc, gain); this.trackSource(osc, collection);
    osc.addEventListener('ended', () => { this.active = this.active.filter((item) => item !== osc); this.voiceGains.delete(osc); });
    return { osc, gain };
  }

  private noise(instrument: Instrument, duration: number, amount: number, start = this.now(), filterType: BiquadFilterType = 'bandpass', filterFrequency = 2400, q = .8, collection?: Set<AudioScheduledSourceNode>, destination: AudioNode = this.output(instrument)) {
    const ctx = this.context!;
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    filter.type = filterType;
    filter.frequency.value = Math.min(ctx.sampleRate / 2 - 100, filterFrequency + this.noiseDirt * 1500);
    filter.Q.value = q;
    source.buffer = this.noiseBuffer ?? this.createNoiseBuffer(2);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, amount), start + .004);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    source.connect(filter).connect(gain).connect(destination);
    source.start(start);
    source.stop(start + duration + .03);
    this.trackSource(source, collection);
  }

  private shaker(at = this.now(), p = this.parameters.drums, c = this.controls.drums, model = this.drumModel) {
    const ctx = this.context!;
    const duration = p.shakerMs.value / 1000;
    const source = ctx.createBufferSource();
    const highpass = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const filterHz = Math.min(ctx.sampleRate / 2 - 100, p.shakerFilterHz.value + c.dirt * 700);
    const attack = Math.min(duration * .35, p.shakerAttackMs.value / 1000);
    const level = p.shakerLevel.value * (model === 'noisy' ? 1.08 : .94);
    const buffer = this.noiseBuffer ?? this.createNoiseBuffer(2);

    source.buffer = buffer;
    highpass.type = 'highpass';
    highpass.frequency.value = filterHz;
    highpass.Q.value = p.shakerFilterQ.value;
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, level), at + attack);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    source.connect(highpass).connect(gain).connect(this.output('drums'));
    const offset = this.noiseOffsetOverride === null
      ? Math.random() * Math.max(0, buffer.duration - duration - .03)
      : Math.max(0, this.noiseOffsetOverride);
    source.start(at, offset);
    source.stop(at + duration + .03);
    this.trackSource(source);
  }

  drum(index: number, at = this.now(), profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1) {
    if (!this.context) return;
    const p = this.parametersFor('drums', profile);
    const c = profile?.controls ?? this.controls.drums;
    const previousDestination = this.eventDestination;
    const previousProfileDestination = this.eventProfileDestination;
    const previousDeckEvent = this.eventIsDeck;
    const previousLane = this.eventLane;
    const previousNoiseDirt = this.noiseDirt;
    this.eventIsDeck = deckEvent;
    this.eventLane = lane ?? (deckEvent ? 'deck' : 'live');
    this.eventDestination = this.eventOutput('drums', profile, this.eventLane, velocity, c.room);
    this.noiseDirt = c.dirt;
    if (!profile && this.drumRoomGain) this.drumRoomGain.gain.setTargetAtTime(c.room * .18, at, .01);
    const durationFor = (milliseconds: number) => milliseconds / 1000 * (1.15 - c.tightness * .5);
    const noiseScale = (profile?.drumModel ?? this.drumModel) === 'noisy' ? 1.15 : .9;
    const model = profile?.drumModel ?? this.drumModel;
    const electronic = model === 'electronic';

    if (index === 0) {
      const body = this.resonator('drums', p.kickStartHz.value, 'sine', durationFor(p.kickDecayMs.value), .86, 'lowpass', 1050, .7, at);
      body.osc.frequency.exponentialRampToValueAtTime(p.kickEndHz.value, at + p.kickPitchFallMs.value / 1000);
      const sub = this.resonator('drums', p.kickEndHz.value, 'sine', durationFor(p.kickDecayMs.value), .24, 'lowpass', 260, .8, at);
      sub.osc.frequency.exponentialRampToValueAtTime(p.kickEndHz.value * .78, at + p.kickPitchFallMs.value / 1000);
      this.noise('drums', durationFor(p.kickClickMs.value), p.kickClickLevel.value * (.7 + c.punch * .55), at, 'highpass', p.kickClickHz.value, .7);
    } else if (index === 1) {
      const body = this.resonator('drums', p.snareBodyHz.value, electronic ? 'square' : 'triangle', durationFor(p.snareBodyMs.value), .4 + c.punch * .2, electronic ? 'lowpass' : 'bandpass', electronic ? 1300 : p.snareBodyHz.value, electronic ? .55 : 1.4, at);
      body.osc.frequency.exponentialRampToValueAtTime(p.snareBodyHz.value * .8, at + durationFor(35));
      this.resonator('drums', p.snareBodyHz.value * 1.72, electronic ? 'square' : 'sine', durationFor(p.snareBodyMs.value), electronic ? .1 : .14, electronic ? 'lowpass' : 'bandpass', electronic ? 2600 : p.snareBodyHz.value * 1.72, electronic ? .7 : 1.2, at);
      this.noise('drums', durationFor(p.snareNoiseMs.value), p.snareNoiseLevel.value * noiseScale * (electronic ? .65 : 1), at, 'bandpass', p.snareNoiseHz.value, 1.1);
      this.noise('drums', durationFor(p.snareNoiseMs.value * .42), p.snareNoiseLevel.value * .3, at, 'highpass', 6500, .6);
    } else if (index === 2 || index === 3) {
      const open = index === 3;
      if (!open) this.closeOpenHats(at, this.eventLane);
      const decay = durationFor(open ? p.openHatMs.value : p.closedHatMs.value);
      const filterHz = open ? p.openHatFilterHz.value : p.closedHatFilterHz.value;
      const level = open ? p.openHatMetalLevel.value : p.closedHatLevel.value;
      const openHit = open ? { gain: this.ownGraphNode(this.context.createGain()), sources: new Set<AudioScheduledSourceNode>(), lane: this.eventLane } : null;
      if (openHit) {
        openHit.gain.gain.setValueAtTime(1, at);
        openHit.gain.connect(this.output('drums'));
        this.openHatHits.push(openHit);
      }
      this.noise('drums', decay, open ? p.openHatNoiseLevel.value : level, at, 'highpass', filterHz, .55, openHit?.sources, openHit?.gain);
      const baseHz = open ? 2300 : 3000;
      metalRatios.forEach((ratio, i) => this.resonator('drums', baseHz * ratio, 'square', decay, level / (electronic ? (open ? 5 : 7) : (open ? 8 : 10)), 'highpass', filterHz, electronic ? .7 : .45, at + i * (open ? .0007 : .0004), openHit?.sources, openHit?.gain));
    } else if (index === 4) {
      const burst = durationFor(p.clapBurstMs.value);
      const gap = durationFor(p.clapGapMs.value);
      const clapScale = model === 'noisy' ? 1.12 : .9;
      this.noise('drums', .012, p.clapCrackLevel.value * clapScale, at, 'highpass', 4200, .8);
      [0, 1, 2].forEach((i) => this.noise('drums', burst * (1 - i * .12), p.clapCrackLevel.value * (1.1 - i * .2) * clapScale, at + .006 + i * gap, 'bandpass', p.clapFilterHz.value + i * 380, .95));
      this.noise('drums', durationFor(p.clapTailMs.value), p.clapTailLevel.value * clapScale, at + .006 + gap * 2 + .012, 'highpass', Math.max(1200, p.clapFilterHz.value * .8), .45);
    } else if (index === 5 || index === 6) {
      const low = index === 5;
      const startHz = low ? p.tomLowStartHz.value : p.tomHighStartHz.value;
      const endHz = low ? p.tomLowEndHz.value : p.tomHighEndHz.value;
      const body = this.resonator('drums', startHz, electronic ? 'square' : 'sine', durationFor(380), low ? .68 : .56, 'lowpass', low ? 850 : 1400, electronic ? .55 : .8, at);
      body.osc.frequency.exponentialRampToValueAtTime(endHz, at + durationFor(p.tomFallMs.value));
      const sub = this.resonator('drums', startHz * .5, 'triangle', durationFor(320), low ? .25 : .18, 'lowpass', low ? 420 : 700, .7, at);
      sub.osc.frequency.exponentialRampToValueAtTime(endHz * .5, at + durationFor(p.tomFallMs.value));
      this.noise('drums', durationFor(50), p.tomNoiseLevel.value * (electronic ? .45 : 1), at, 'bandpass', low ? 650 : 1100, 1.4);
    } else if (index === 7) {
      this.resonator('drums', p.percAHz.value, 'square', durationFor(120), electronic ? .27 : .2, 'bandpass', p.percAHz.value, electronic ? 3.5 : 5, at);
      this.resonator('drums', p.percBHz.value, electronic ? 'square' : 'sine', durationFor(160), electronic ? .2 : .16, 'bandpass', p.percBHz.value, electronic ? 4.5 : 7, at);
      this.noise('drums', durationFor(14), .12, at, 'highpass', 4200, .5);
    } else if (index === 8) {
      const duration = durationFor(p.rimDecayMs.value);
      this.resonator('drums', p.rimHz.value, 'square', duration, .2, 'bandpass', p.rimFilterHz.value, 9, at);
      this.resonator('drums', p.rimHz.value * 1.7, 'triangle', duration * .8, .12, 'bandpass', p.rimFilterHz.value * 1.35, 11, at);
      this.noise('drums', .014, p.rimNoiseLevel.value, at, 'highpass', p.rimFilterHz.value * 1.2, .7);
    } else if (index === 9) {
      this.shaker(at, p, c, model);
    } else if (index === 10) {
      const duration = durationFor(p.cowbellDecayMs.value);
      [1, 1.48, 1.62, 2.13].forEach((ratio, i) => this.resonator('drums', p.cowbellHzA.value * ratio, 'square', duration * (1 - i * .08), .18 / (i + 1), 'bandpass', p.cowbellFilterHz.value * (1 + i * .08), 7, at));
      this.resonator('drums', p.cowbellHzB.value, 'square', duration * .8, .16, 'bandpass', p.cowbellFilterHz.value * 1.3, 8, at);
      this.noise('drums', .022, p.cowbellNoiseLevel.value, at, 'bandpass', p.cowbellFilterHz.value * 2.2, 1.6);
    } else {
      const duration = durationFor(p.rideMs.value);
      metalRatios.forEach((ratio, i) => this.resonator('drums', 1450 * ratio, 'square', duration * (1 - i * .03), p.rideLevel.value / 9, 'highpass', p.rideFilterHz.value, .5, at + i * .0004));
      this.noise('drums', duration, p.rideLevel.value * .72, at, 'highpass', p.rideFilterHz.value, .45);
    }
    this.eventDestination = previousDestination;
    this.eventProfileDestination = previousProfileDestination;
    this.eventIsDeck = previousDeckEvent;
    this.eventLane = previousLane;
    this.noiseDirt = previousNoiseDirt;
  }

  metronome(accent = false, at = this.now()) {
    if (!this.context) return;
    const p = this.parameters.metronome;
    const c = this.controls.metronome;
    const frequency = (accent ? p.accentHz.value : p.clickHz.value) * (.7 + c.tone * .6);
    const osc = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const attack = p.attackMs.value / 1000 * (.5 + c.attack * 1.5);
    const duration = p.decayMs.value / 1000 * (.5 + c.decay * 1.5);
    filter.type = 'highpass';
    filter.frequency.value = Math.min(p.filterHz.value * (.65 + c.tone * .7), this.context.sampleRate / 2 - 1);
    osc.type = 'square';
    osc.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, p.clickLevel.value * c.level * (accent ? 1 : .78)), at + attack);
    gain.gain.exponentialRampToValueAtTime(.0001, at + duration);
    osc.connect(filter).connect(gain).connect(this.output('metronome'));
    osc.start(at); osc.stop(at + duration + .02);
    this.active.push(osc); this.voiceGains.set(osc, gain); this.trackSource(osc);
    osc.addEventListener('ended', () => { this.active = this.active.filter((item) => item !== osc); this.voiceGains.delete(osc); });
  }

  private triggerBassLane(lane: VoiceLane, midi: number, duration: number | null, requestedAt: number, profile: DeckSoundProfile | undefined, velocity: number, heldId?: string) {
    if (!this.context) return [] as OscillatorNode[];
    const timing = bassVcaRetriggerTiming(requestedAt, this.context.currentTime, this.context.sampleRate, lane === 'live');
    const start = timing.onsetAt;
    const bassLane = this.ensureBassLane(lane);
    if (!bassLane) return [] as OscillatorNode[];
    this.clearPendingBassProfileTimer(bassLane);
    this.applyPendingBassProfileIfSilent(bassLane);
    const activeProfile = bassLane.profile;
    const bass = this.parametersFor('bass', activeProfile);
    const controls = activeProfile?.controls ?? this.controls.bass;
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const previous = bassLane.current;
    const noteToken = ++this.bassNoteToken;
    // A new onset invalidates any reset that belonged to the prior note. The
    // AudioParam and controller schedules below also cancel that old future
    // segment at the new onset.
    bassLane.envelopeResetToken = noteToken;
    const attack = Math.max(0, bass.attackMs.value / 1000);
    const decay = Math.max(0, bass.decayMs.value / 1000);
    const release = safeReleaseDuration(bass.releaseMs.value / 1000);
    const noteVelocity = clamp(velocity);
    const peak = noteVelocity;
    const sustain = Math.max(.0001, Math.min(1, bass.sustainLevel.value) * noteVelocity);

    // The main and sub oscillators never stop. Only the shared envelope changes,
    // so retriggers keep the filter state and oscillator phase intact.
    this.scheduleBassVca(bassLane.envelope, bassLane.envelopeState, peak, start, attack, false);
    this.scheduleBassVca(bassLane.envelope, bassLane.envelopeState, sustain, start + attack, decay, false);

    // Use note ownership and its scheduled lifetime to choose the crossfade.
    // BassVcaController remains diagnostic only; it must not decide whether a
    // native AudioParam transition is allowed to restart from a live value.
    const previousIsAudible = previous !== null && bassLaneNoteIsAudibleAt(previous, start);
    if (previous && !previousIsAudible) {
      // Persistent lanes have no source-ended callback for individual notes.
      // Retire an expired note before replacing it, but guard by token so a
      // delayed cleanup can never clear a newer note.
      this.retireBassLaneNote(bassLane, previous.token, previous.heldId);
    }
    const onsetDuration = previousIsAudible ? FADE_SECONDS : .005;
    if (previousIsAudible) {
      this.recordBassReleaseMarker(requestedAt, timing, 'retrigger', lane, String(previous.token));
    }
    // One final VCA owns every audible part of the lane. Retriggering starts
    // from its analytic current value and never creates a second bass graph.
    this.scheduleBassVca(bassLane.gate, bassLane.vca, 1, start, onsetDuration, false);

    const gateDuration = safeGateDuration(duration);
    const gateEnd = gateDuration === null ? null : start + gateDuration;
    if (gateEnd !== null) {
      this.scheduleBassVca(bassLane.gate, bassLane.vca, 0, gateEnd, release, false);
      this.scheduleBassEnvelopeReset(bassLane, gateEnd + release, noteToken);
      this.recordBassReleaseMarker(gateEnd, { requestedAt: gateEnd, scheduledAt: gateEnd, safetyOffsetSeconds: 0 }, 'deck-gate-off', lane, String(noteToken));
    }

    const glideTime = Math.min(.5, Math.max(0, bass.glideMs.value / 1000 * controls.glide));
    const cancelFrequency = (parameter: AudioParam) => {
      const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
      if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(start);
      else controlled.cancelScheduledValues(start);
    };
    cancelFrequency(bassLane.main.frequency);
    cancelFrequency(bassLane.sub.frequency);
    if (glideTime > .001 && previous) {
      bassLane.main.frequency.setValueAtTime(previous.frequency, start);
      bassLane.main.frequency.exponentialRampToValueAtTime(frequency, start + glideTime);
      bassLane.sub.frequency.setValueAtTime(previous.frequency * Math.pow(2, bass.subOctave.value), start);
      bassLane.sub.frequency.exponentialRampToValueAtTime(frequency * Math.pow(2, bass.subOctave.value), start + glideTime);
    } else {
      bassLane.main.frequency.setValueAtTime(frequency, start);
      bassLane.sub.frequency.setValueAtTime(frequency * Math.pow(2, bass.subOctave.value), start);
    }

    const clickLevel = Math.max(0, bass.clickLevel.value * (.3 + controls.tone * .5) * noteVelocity);
    this.scheduleBassVca(bassLane.clickGain, bassLane.clickState, clickLevel, start, .001, false);
    this.scheduleBassVca(bassLane.clickGain, bassLane.clickState, 0, start + .025, .025, false);
    bassLane.current = { token: noteToken, midi, frequency, gateEnd, releaseEnd: gateEnd === null ? undefined : gateEnd + release, heldId };
    bassLane.currentHeldId = heldId;
    if (bassLane.pendingProfile) this.schedulePendingBassProfile(bassLane);
    return [bassLane.main, bassLane.sub, bassLane.click];
  }

  private releaseBassLane(lane: VoiceLane, requestedAt: number, duration: number, voiceId?: string) {
    const bassLane = this.bassLanes.get(lane);
    if (!bassLane || !this.context) return undefined;
    const timing = bassVcaAutomationTiming(requestedAt, this.context.currentTime, this.context.sampleRate, lane === 'live');
    const result = this.scheduleBassVca(bassLane.gate, bassLane.vca, 0, timing.scheduledAt, duration, false);
    if (bassLane.current) {
      const token = bassLane.current.token;
      bassLane.current.releaseEnd = result.end;
      this.scheduleBassEnvelopeReset(bassLane, result.end, token);
    }
    if (bassLane.pendingProfile) this.schedulePendingBassProfile(bassLane);
    this.recordBassReleaseMarker(requestedAt, timing, 'natural-release', lane, voiceId);
    return result;
  }

  note(instrument: Exclude<Instrument, 'drums'>, midi: number, duration: number | null = null, at = this.now(), profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1): OscillatorNode[] {
    if (!this.context) return [];
    if (instrument === 'chords') return this.chord([midi], duration, at, profile, deckEvent, lane, velocity);
    const gateDuration = safeGateDuration(duration);
    const c = profile?.controls ?? this.controls[instrument];
    const params = instrument === 'metronome' ? this.parameters.metronome : this.parametersFor(instrument, profile);
    const frequency = 440 * Math.pow(2, (midi - 69) / 12);
    const previousDestination = this.eventDestination;
    const previousProfileDestination = this.eventProfileDestination;
    const previousDeckEvent = this.eventIsDeck;
    const previousLane = this.eventLane;
    this.eventIsDeck = deckEvent;
    this.eventLane = lane ?? (deckEvent ? 'deck' : 'live');
    this.eventDestination = instrument === 'bass' ? null : this.eventOutput(instrument, profile, this.eventLane, velocity);
    const voiceLane: VoiceLane = this.eventLane;
    const voices: OscillatorNode[] = [];
    if (instrument === 'bass') {
      voices.push(...this.triggerBassLane(voiceLane, midi, gateDuration, at, profile, velocity));
    } else {
      const lead = params;
      const voiceLimit = this.leadVoiceLimit(profile);
      if (voiceLimit === 1) this.leadVoices = this.chokeGroups(this.leadVoices, at, voiceLane);
      const tone = Math.min(1, c.tone + c.bite * .15);
      const type: OscillatorType = tone < .25 ? 'sine' : tone < .52 ? 'triangle' : tone < .82 ? 'sawtooth' : 'square';
      const attack = lead.attackMs.value / 1000;
      const decay = lead.decayMs.value / 1000;
      const release = lead.releaseMs.value / 1000;
      const voiceLength = gateDuration === null ? null : gateDuration + release;
      const chorus = this.leadChorus(lead, at, voiceLength === null ? null : at + voiceLength);
      const input = this.context.createGain();
      input.gain.value = 1;
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(this.context.sampleRate / 2 - 100, lead.filterHz.value * (.55 + c.bite * .85));
      input.connect(filter).connect(chorus.input);
      const echo = this.context.createDelay(1.2);
      const echoGain = this.context.createGain();
      echo.delayTime.value = lead.echoMs.value / 1000;
      echoGain.gain.value = c.echo * .35;
      input.connect(echo).connect(echoGain).connect(this.output('lead'));
      const feedback = this.context.createGain();
      feedback.gain.value = Math.min(.85, lead.echoFeedback.value * c.echo);
      echo.connect(feedback).connect(echo);
      const main = this.adsrOscillator('lead', frequency, type, attack, decay, lead.sustainLevel.value, gateDuration, release, .46, at, input);
      const second = this.adsrOscillator('lead', frequency * Math.pow(2, lead.detuneCents.value / 1200), type, attack, decay, lead.sustainLevel.value, gateDuration, release, .2, at, input);
      voices.push(main.osc, second.osc);
      const lfos: OscillatorNode[] = [];
      if (c.motion > .01) {
        const lfo = this.context.createOscillator();
        const lfoGain = this.context.createGain();
        lfo.frequency.value = lead.vibratoHz.value * (.65 + c.motion * .7);
        lfoGain.gain.value = lead.vibratoCents.value * c.motion;
        lfo.connect(lfoGain).connect(main.osc.detune);
        lfo.start(at);
        if (gateDuration !== null) lfo.stop(at + gateDuration + release + .05);
        this.trackSource(lfo);
        lfos.push(lfo);
      }
      if (voiceLimit > 1) this.trimVoiceGroups(this.leadVoices, voiceLimit, 1, at, voiceLane);
      const envelopes = [main.gain, second.gain];
      const group: VoiceGroup = {
        at,
        voices: [...voices],
        voiceCount: 1,
        lane: voiceLane,
        state: 'active',
        choke: (when, duration) => {
          this.silenceGain(input, when, duration);
          this.silenceGain(echoGain, when, duration);
          this.silenceGain(feedback, when, duration);
          chorus.stop?.(when, duration);
          lfos.forEach((lfo) => {
            try { lfo.stop(when + Math.max(.012, duration ?? .012) + .02); } catch { /* already stopped */ }
          });
        },
        release: (when, duration) => {
          envelopes.forEach((envelope) => this.releaseEnvelope(envelope, when, duration));
          chorus.release?.(when, duration);
          this.silenceGain(feedback, when + duration, .012);
          lfos.forEach((lfo) => {
            try { lfo.stop(when + duration + .05); } catch { /* already stopped */ }
          });
        },
      };
      this.leadVoices.push(group);
      this.registerVoiceGroup(group);
    }
    this.eventDestination = previousDestination;
    this.eventProfileDestination = previousProfileDestination;
    this.eventIsDeck = previousDeckEvent;
    this.eventLane = previousLane;
    return voices;
  }
  chord(pitches: number[], duration: number | null = null, at = this.now(), profile?: DeckSoundProfile, deckEvent = false, lane?: VoiceLane, velocity = 1): OscillatorNode[] {
    if (!this.context) return [];
    if (pitches.length === 0) return [];
    const previousDestination = this.eventDestination;
    const previousProfileDestination = this.eventProfileDestination;
    const previousDeckEvent = this.eventIsDeck;
    const previousLane = this.eventLane;
    this.eventIsDeck = deckEvent;
    this.eventLane = lane ?? (deckEvent ? 'deck' : 'live');
    this.eventDestination = this.eventOutput('chords', profile, this.eventLane, velocity);
    const voiceLane: VoiceLane = this.eventLane;
    this.chordVoices = this.chokeGroups(this.chordVoices, at, voiceLane);

    const chords = profile ? this.parametersFor('chords', profile) : this.parameters.chords;
    const c = profile?.controls ?? this.controls.chords;
    const type: OscillatorType = c.tone < .3 ? 'triangle' : 'sawtooth';
    const detune = (chords.detuneCents.value + c.width * 18) / 1200;
    const attack = chords.attackMs.value / 1000 * (.5 + c.attack * 1.5);
    const gateDuration = safeGateDuration(duration);
    const input = this.context.createGain();
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = Math.min(this.context.sampleRate / 2 - 100, chords.filterHz.value * (.65 + c.tone * .7));
    input.gain.value = 1;
    input.connect(filter).connect(this.output('chords'));
    const delay = this.context.createDelay(1);
    const delayGain = this.context.createGain();
    delay.delayTime.value = chords.delayMs.value / 1000;
    delayGain.gain.value = c.space * .22;
    input.connect(delay).connect(delayGain).connect(this.output('chords'));
    const chorus = this.context.createDelay(.05);
    const chorusGain = this.context.createGain();
    chorus.delayTime.value = chords.chorusMs.value / 1000;
    chorusGain.gain.value = Math.min(.3, chords.chorusMs.value / 100);
    input.connect(chorus).connect(chorusGain).connect(this.output('chords'));

    const voices: OscillatorNode[] = [];
    const envelopes: GainNode[] = [];
    pitches.forEach((pitch) => {
      const frequency = 440 * Math.pow(2, (pitch - 69) / 12);
      const left = this.adsrOscillator('chords', frequency * (1 - detune), type, attack, chords.decayMs.value / 1000, chords.sustainLevel.value, gateDuration, chords.releaseMs.value / 1000, .22, at, input);
      const right = this.adsrOscillator('chords', frequency * (1 + detune), type, attack, chords.decayMs.value / 1000, chords.sustainLevel.value, gateDuration, chords.releaseMs.value / 1000, .2 * chords.oscillatorMix.value, at, input);
      const harmonic = this.adsrOscillator('chords', frequency * 2, 'sine', attack, chords.decayMs.value / 1000, chords.sustainLevel.value, gateDuration, chords.releaseMs.value / 1000, .12 * chords.harmonicLevel.value, at, input);
      voices.push(left.osc, right.osc, harmonic.osc);
      envelopes.push(left.gain, right.gain, harmonic.gain);
    });
    const group: VoiceGroup = {
      at,
      voices,
      voiceCount: pitches.length,
      lane: voiceLane,
      state: 'active',
      choke: (when, fadeDuration) => {
        this.silenceGain(input, when, fadeDuration);
        this.silenceGain(delayGain, when, fadeDuration);
        this.silenceGain(chorusGain, when, fadeDuration);
      },
      release: (when, releaseDuration) => envelopes.forEach((envelope) => this.releaseEnvelope(envelope, when, releaseDuration)),
    };
    this.chordVoices.push(group);
    this.registerVoiceGroup(group);
    this.eventDestination = previousDestination;
    this.eventProfileDestination = previousProfileDestination;
    this.eventIsDeck = previousDeckEvent;
    this.eventLane = previousLane;
    return voices;
  }
  hasHeldNote(id: string) { return this.heldNotes.has(id); }
  holdNote(id: string, instrument: Exclude<Instrument, 'drums'>, midi: number) {
    this.releaseNote(id);
    const voices = this.note(instrument, midi, null);
    this.heldNotes.set(id, voices);
    this.heldNoteKinds.set(id, instrument);
    if (instrument === 'bass') {
      this.bassHeld.set(id, { midi, order: ++this.bassHeldOrder });
      const bassLane = this.bassLanes.get('live');
      if (bassLane) bassLane.currentHeldId = id;
    }
    return voices;
  }
  holdChord(id: string, pitches: number[], profile?: DeckSoundProfile) {
    this.releaseNote(id);
    const voices = this.chord(pitches, null, this.now(), profile, false, 'live', 1);
    this.heldNotes.set(id, voices);
    this.heldNoteKinds.set(id, 'chords');
    return voices;
  }
  releaseNote(id: string) {
    const voices = this.heldNotes.get(id);
    if (!voices || !this.context) return null;
    const kind = this.heldNoteKinds.get(id);
    const configuredRelease = kind ? this.parameters[kind].releaseMs.value / 1000 : .08;
    const release = Number.isFinite(configuredRelease) ? Math.max(.012, configuredRelease) : .012;
    const now = this.context.currentTime;
    let bassTiming: BassVcaScheduleResult | undefined;
    if (kind === 'bass') {
      this.bassHeld.delete(id);
      const bassLane = this.bassLanes.get('live');
      if (bassLane?.currentHeldId === id) {
        const fallback = [...this.bassHeld.entries()].sort((left, right) => right[1].order - left[1].order)[0];
        if (fallback) {
          this.triggerBassLane('live', fallback[1].midi, null, now, undefined, 1, fallback[0]);
          bassLane.currentHeldId = fallback[0];
        } else {
          bassTiming = this.releaseBassLane('live', now, release, id);
          bassLane.currentHeldId = undefined;
        }
      }
    } else {
      this.releaseVoiceGroups(voices, now, release);
    }
    this.heldNotes.delete(id);
    this.heldNoteKinds.delete(id);
    this.debugHeldIds.delete(id);
    return { id, instrument: kind ?? null, requestedAt: now, voiceCount: kind === 'bass' ? 1 : voices.length, ...(bassTiming ? { scheduledAt: bassTiming.scheduledAt, safetyOffsetSeconds: bassTiming.safetyOffsetSeconds } : {}) };
  }

  private stopSources(sources: Set<AudioScheduledSourceNode>, at?: number) {
    [...sources].forEach((source) => {
      try {
        if (at === undefined) source.stop();
        else source.stop(at);
      } catch { /* already stopped */ }
    });
    sources.clear();
  }

  private stopSourcesForLane(lane: VoiceLane, at: number) {
    const sources = new Set([...this.activeSources].filter((source) => this.sourceLanes.get(source) === lane && !this.persistentBassSources.has(source)));
    this.stopSources(sources, at);
  }

  private cancelBassParameterAutomation(parameter: AudioParam, at: number) {
    const controlled = parameter as AudioParam & { cancelAndHoldAtTime?: (time: number) => void };
    if (typeof controlled.cancelAndHoldAtTime === 'function') controlled.cancelAndHoldAtTime(at);
    else {
      controlled.cancelScheduledValues(at);
      controlled.setValueAtTime(Math.max(0, controlled.value), at);
    }
  }

  private stopBassLane(lane: VoiceLane, at: number) {
    const bassLane = this.bassLanes.get(lane);
    if (!bassLane) return;
    this.clearPendingBassProfileTimer(bassLane);

    // Stop must cancel every future persistent-lane event first. The lane's
    // oscillators stay alive, but no old pitch or envelope event may reopen it
    // after the requested stop.
    this.cancelBassParameterAutomation(bassLane.envelope.gain, at);
    this.cancelBassParameterAutomation(bassLane.clickGain.gain, at);
    this.cancelBassParameterAutomation(bassLane.main.frequency, at);
    this.cancelBassParameterAutomation(bassLane.sub.frequency, at);

    const resetToken = ++this.bassNoteToken;
    bassLane.envelopeResetToken = resetToken;
    const current = bassLane.vca.valueAt(at);
    let resetAt = at;
    if (current > .0001) {
      const timing = bassVcaAutomationTiming(at, this.context?.currentTime ?? at, this.context?.sampleRate ?? 48000, false);
      const fade = this.scheduleBassVca(bassLane.gate, bassLane.vca, 0, timing.scheduledAt, FADE_SECONDS, false);
      resetAt = fade.end;
      this.recordBassReleaseMarker(at, timing, 'choke', lane, bassLane.current ? String(bassLane.current.token) : undefined);
    } else {
      this.scheduleBassVca(bassLane.gate, bassLane.vca, 0, at, 0, false);
    }
    // The final gate keeps the persistent graph inaudible during the reset.
    // Reset both internal gain timelines only after that fade completes.
    this.scheduleBassVca(bassLane.envelope, bassLane.envelopeState, 0, resetAt, 0, false);
    this.scheduleBassVca(bassLane.clickGain, bassLane.clickState, 0, resetAt, 0, false);
    bassLane.current = null;
    bassLane.currentHeldId = undefined;
  }

  stopDeckVoices(lane?: VoiceLane) {
    if (this.context) {
      const at = this.context.currentTime;
      this.stopDeckGroups(at, lane);
      if (lane === 'deckA' || lane === 'deckB' || lane === 'deck') this.stopBassLane(lane, at);
      else { this.stopBassLane('deckA', at); this.stopBassLane('deckB', at); this.stopBassLane('deck', at); }
      if (lane === 'deckA' || lane === 'deckB') this.stopSourcesForLane(lane, at + .02);
      else { this.stopSourcesForLane('deckA', at + .02); this.stopSourcesForLane('deckB', at + .02); this.stopSourcesForLane('deck', at + .02); }
    }
  }

  stopLaneVoices(lane: VoiceLane) {
    if (!this.context) return;
    this.stopBassLane(lane, this.context.currentTime);
    [...this.leadVoices, ...this.chordVoices].forEach((group) => {
      if (group.lane === lane) this.terminateGroup(group, this.context!.currentTime);
    });
    this.stopSourcesForLane(lane, this.context.currentTime + .02);
  }

  panic() {
    this.stopSources(this.activeSources);
    this.debugSources.clear();
    this.openHatHits = [];
    this.pendingBassReleases = [];
    this.active = [];
    this.voiceGains.clear();
    this.bassLanes.forEach((lane) => this.clearPendingBassProfileTimer(lane));
    this.bassLanes.clear();
    this.bassHeld.clear();
    this.persistentBassSources.clear();
    this.leadVoices = [];
    this.chordVoices = [];
    this.heldNotes.clear();
    this.heldNoteKinds.clear();
    this.debugHeldIds.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.panic();
    const context = this.context;

    this.ownedGraphNodes.forEach((node) => {
      try { node.disconnect(); } catch { /* already disconnected */ }
    });
    this.ownedGraphNodes.clear();
    this.profileDestinations.clear();
    this.laneBuses.clear();
    this.laneInstrumentGains.clear();
    this.instruments.clear();
    this.context = null;
    this.master = null;
    this.compressor = null;
    this.analyser = null;
    this.destination = null;
    this.outputAnalyser = null;
    this.pendingBassReleases = [];
    this.bassReleaseDiagnostics = [];
    this.drumRoomGain = null;
    this.noiseBuffer = null;
    this.eventDestination = null;
    this.eventProfileDestination = null;
    this.eventIsDeck = false;
    this.eventLane = 'live';
    this.eventIsDebug = false;
    this.noiseDirt = 0;
    this.active = [];
    this.voiceGains.clear();
    this.activeSources.clear();
    this.deckSources.clear();
    this.sourceLanes.clear();
    this.persistentBassSources.clear();
    this.sourceProfileDestinations.clear();
    this.openHatHits = [];
    this.bassLanes.clear();
    this.bassHeld.clear();
    this.leadVoices = [];
    this.chordVoices = [];

    if (context) {
      try { void context.close().catch(() => {}); } catch { /* already closed */ }
    }
  }
}

export { drumNames };
