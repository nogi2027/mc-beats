import type { DeckSoundProfile } from '../../deck.ts';
import type { DrumModel, VoiceLane } from '../contract.ts';
import { scheduleSmoothFade } from '../envelope.ts';
import { cloneAndFreezeProfile, ProfileBus } from '../profile-bus.ts';
import { SynthVoice } from '../voice.ts';

export const DRUM_NAMES = ['Kick', 'Snare', 'Closed Hat', 'Open Hat', 'Clap', 'Low Tom', 'High Tom', 'Perc', 'Rim', 'Shaker', 'Cowbell', 'Ride'] as const;
const METAL_RATIOS = [1, 1.483, 1.932, 2.546, 2.63, 3.897];
const BASE_CONTROLS = { punch: .65, tightness: .55, dirt: .15, room: .2 };
const BASE_PARAMETERS: Record<string, number> = {
  kickStartHz: 190, kickEndHz: 48, kickPitchFallMs: 90, kickDecayMs: 350, kickClickHz: 3500, kickClickMs: 18, kickClickLevel: .2,
  snareBodyHz: 190, snareBodyMs: 125, snareNoiseHz: 2800, snareNoiseMs: 180, snareNoiseLevel: .62,
  closedHatMs: 45, closedHatFilterHz: 7800, closedHatLevel: .35, openHatMs: 420, openHatFilterHz: 5200, openHatNoiseLevel: .48, openHatMetalLevel: .2,
  clapGapMs: 20, clapBurstMs: 55, clapTailMs: 240, clapFilterHz: 1800, clapCrackLevel: .42, clapTailLevel: .28,
  tomFallMs: 120, tomLowStartHz: 180, tomLowEndHz: 82, tomHighStartHz: 280, tomHighEndHz: 150, tomNoiseLevel: .24,
  percAHz: 840, percBHz: 1290, rimHz: 1850, rimDecayMs: 45, rimFilterHz: 2800, rimNoiseLevel: .28,
  shakerMs: 550, shakerLevel: .26, shakerFilterHz: 2602, shakerAttackMs: 12, shakerFilterQ: .28,
  cowbellHzA: 540, cowbellHzB: 800, cowbellDecayMs: 220, cowbellFilterHz: 1200, cowbellNoiseLevel: .24,
  rideMs: 650, rideLevel: .25, rideFilterHz: 6200,
};

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const numberValue = (values: Record<string, number>, name: string, fallback: number) => Number.isFinite(values[name]) ? values[name] : fallback;
const sortedEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const drumProfileFingerprint = (profile: DeckSoundProfile) => JSON.stringify([
  profile.presetId,
  sortedEntries(profile.controls),
  sortedEntries(profile.parameters),
  profile.volume,
  profile.drumModel ?? null,
]);

export type DrumPatchProfile = Readonly<{
  profile: Readonly<DeckSoundProfile>;
  model: DrumModel;
  durationScale: number;
  room: number;
  effectTailSeconds: number;
  params: Readonly<Record<string, number>>;
}>;

const kit = (presetId: string) => ['808', 'Circuit', 'Glitch'].includes(presetId) ? presetId : null;

export const normalizeDrumProfile = (input?: DeckSoundProfile, sampleRate = 48000, modelOverride?: DrumModel): DrumPatchProfile => {
  const source = input ?? {
    presetId: 'Clean',
    controls: BASE_CONTROLS,
    parameters: BASE_PARAMETERS,
    volume: .7,
    drumModel: modelOverride ?? 'layered',
  };
  const controls = { ...BASE_CONTROLS, ...source.controls };
  const params = { ...BASE_PARAMETERS, ...source.parameters };
  const model = modelOverride ?? source.drumModel ?? 'layered';
  const preset = kit(source.presetId);
  // The kits use the same parameter vocabulary as the legacy engine, but a
  // kit identity adds a distinct synthesis recipe without changing old IDs.
  const effectiveModel: DrumModel = preset ? 'electronic' : model;
  const room = clamp(numberValue(controls, 'room', BASE_CONTROLS.room));
  const durationScale = 1.15 - clamp(numberValue(controls, 'tightness', BASE_CONTROLS.tightness)) * .5;
  const safeNyquist = Math.max(20, sampleRate / 2 - 1);
  const normalizedParams: Record<string, number> = { ...params };
  normalizedParams.closedHatFilterHz = Math.min(safeNyquist, normalizedParams.closedHatFilterHz);
  normalizedParams.openHatFilterHz = Math.min(safeNyquist, normalizedParams.openHatFilterHz);
  const profile = cloneAndFreezeProfile({ ...source, controls, parameters: normalizedParams })!;
  return {
    profile,
    model: effectiveModel,
    durationScale,
    room,
    // Room delay is 75 ms in the legacy path. Keep a bounded declared drain.
    effectTailSeconds: room > .001 ? .125 : 0,
    params: normalizedParams,
  };
};

export type DrumVoiceBuild = {
  voice: SynthVoice;
  sources: AudioScheduledSourceNode[];
  profile: DrumPatchProfile;
  profileBus: ProfileBus;
  openHat: boolean;
  durationSeconds: number;
};

type ContextWithBuffer = BaseAudioContext & {
  createBufferSource?: () => AudioBufferSourceNode;
};

export const createDrumNoiseBuffer = (context: BaseAudioContext, seconds = 2) => {
  const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return buffer;
};

/** Create a procedural noise source. The oscillator fallback keeps unit fakes
 * useful; browsers use a runtime-generated noise buffer, never samples. */
const noiseSource = (context: BaseAudioContext, startAt: number, duration: number, fallbackHz: number, buffer?: AudioBuffer, offset = 0) => {
  const bufferContext = context as ContextWithBuffer;
  if (typeof bufferContext.createBufferSource === 'function') {
    const source = bufferContext.createBufferSource();
    source.buffer = buffer ?? createDrumNoiseBuffer(context);
    return { source: source as AudioScheduledSourceNode, start: () => source.start(startAt, Math.max(0, offset)), stop: (at: number) => source.stop(at) };
  }
  const oscillator = context.createOscillator();
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(fallbackHz, startAt);
  return { source: oscillator as AudioScheduledSourceNode, start: () => oscillator.start(startAt), stop: (at: number) => oscillator.stop(at) };
};

export const createDrumVoice = (options: {
  context: BaseAudioContext;
  id: string;
  lane: VoiceLane;
  pad: number;
  startAt: number;
  velocity: number;
  profile: DeckSoundProfile;
  profileBus: ProfileBus;
  modelOverride?: DrumModel;
  noiseBuffer?: AudioBuffer;
  noiseOffset?: number;
}): DrumVoiceBuild => {
  const { context, id, lane, pad, startAt, profileBus } = options;
  const patch = normalizeDrumProfile(options.profile, context.sampleRate, options.modelOverride);
  const p = patch.params;
  const c = patch.profile.controls;
  const velocity = clamp(options.velocity);
  const finalGain = context.createGain();
  const mix = context.createGain();
  const voice = new SynthVoice({
    id,
    instrument: 'drums',
    lane,
    profile: { fingerprint: drumProfileFingerprint(patch.profile), profile: patch.profile },
    finalGain,
    context,
  });
  voice.setEffectTailSeconds(patch.effectTailSeconds);
  const sources: AudioScheduledSourceNode[] = [];
  const effectGains: Array<{ node: GainNode; level: number }> = [];
  const durationFor = (milliseconds: number) => Math.max(.004, milliseconds / 1000 * patch.durationScale);
  const electronic = patch.model === 'electronic';
  const kitId = kit(patch.profile.presetId);
  const filterFrequency = (value: number, dirtScale = 0) => Math.min(context.sampleRate / 2 - 100, Math.max(20, value + clamp(numberValue(c, 'dirt', .15)) * dirtScale));
  mix.gain.value = 1;

  const addSourcePath = (source: AudioScheduledSourceNode, duration: number, amount: number, filterType: BiquadFilterType, filterHz: number, q: number, frequency?: number, type: OscillatorType = 'sine', pitchEnd?: number, pitchEndAt?: number, sourceStartAt = startAt, dirtScale = 0, attackSeconds?: number) => {
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = filterType;
    filter.frequency.value = filterFrequency(filterHz, dirtScale);
    filter.Q.value = Math.max(.05, q);
    gain.gain.setValueAtTime(.0001, sourceStartAt);
    // Legacy resonators use a 2 ms attack and noise uses 4 ms. Keep that
    // distinction so parity does not depend on the arbitrary patch helper.
    const attack = Math.min(attackSeconds ?? (frequency === undefined ? .004 : .002), duration * .18);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0002, amount), sourceStartAt + attack);
    gain.gain.exponentialRampToValueAtTime(.0001, sourceStartAt + duration);
    if ('type' in source && frequency !== undefined) {
      const oscillator = source as unknown as OscillatorNode;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, sourceStartAt);
      if (pitchEnd !== undefined && pitchEndAt !== undefined) oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, pitchEnd), pitchEndAt);
    }
    source.connect(filter).connect(gain).connect(mix);
    voice.addNode(filter); voice.addNode(gain); voice.addSource(source, sourceStartAt);
    sources.push(source);
    return { duration, gain };
  };

  const addOsc = (frequency: number, duration: number, amount: number, filterType: BiquadFilterType, filterHz: number, q: number, type: OscillatorType, endFrequency?: number, endAt?: number, sourceStartAt = startAt) => {
    const oscillator = context.createOscillator();
    return addSourcePath(oscillator, duration, amount, filterType, filterHz, q, frequency, type, endFrequency, endAt, sourceStartAt, 0);
  };

  const addNoise = (duration: number, amount: number, filterType: BiquadFilterType, filterHz: number, q: number, sourceStartAt = startAt, dirtScale = 1500) => {
    const offset = pad === 9 && options.noiseBuffer
      ? Number.isFinite(options.noiseOffset) ? Math.max(0, options.noiseOffset as number) : Math.random() * Math.max(0, options.noiseBuffer.duration - duration - .03)
      : 0;
    const noise = noiseSource(context, sourceStartAt, duration, filterHz, options.noiseBuffer, offset);
    const shakerAttack = pad === 9 ? Math.min(duration * .35, numberValue(p, 'shakerAttackMs', 12) / 1000) : undefined;
    const result = addSourcePath(noise.source, duration, amount, filterType, filterHz, q, undefined, 'sine', undefined, undefined, sourceStartAt, dirtScale, shakerAttack);
    return { ...result, stop: noise.stop };
  };

  let maxDuration = .02;
  const track = (duration: number) => { maxDuration = Math.max(maxDuration, duration); };
  if (pad === 0) {
    const kickDecay = durationFor(p.kickDecayMs);
    const kickEnd = numberValue(p, 'kickEndHz', 48);
    const kickStart = numberValue(p, 'kickStartHz', 190) * (kitId === '808' ? .92 : 1);
    const pitchFall = Math.min(kickDecay, numberValue(p, 'kickPitchFallMs', 90) / 1000);
    addOsc(kickStart, kickDecay, kitId === '808' ? .92 : .86, 'lowpass', 1050, .7, 'sine', kickEnd, startAt + pitchFall);
    addOsc(kickEnd, kickDecay, .24, 'lowpass', 260, .8, 'sine', kickEnd * .78, startAt + pitchFall);
    const click = addNoise(durationFor(p.kickClickMs), numberValue(p, 'kickClickLevel', .2) * (.7 + clamp(numberValue(c, 'punch', .65)) * .55), 'highpass', p.kickClickHz, .7);
    track(kickDecay); track(click.duration);
  } else if (pad === 1) {
    const bodyDuration = durationFor(p.snareBodyMs);
    const bodyHz = numberValue(p, 'snareBodyHz', 190);
    addOsc(bodyHz, bodyDuration, .4 + clamp(numberValue(c, 'punch', .65)) * .2, electronic ? 'lowpass' : 'bandpass', electronic ? 1300 : bodyHz, electronic ? .55 : 1.4, electronic ? 'square' : 'triangle', bodyHz * .8, startAt + durationFor(35));
    addOsc(bodyHz * (kitId === 'Glitch' ? 2.15 : 1.72), bodyDuration, electronic ? .1 : .14, electronic ? 'lowpass' : 'bandpass', electronic ? 2600 : bodyHz * 1.72, electronic ? .7 : 1.2, electronic ? 'square' : 'sine');
    const noise = addNoise(durationFor(p.snareNoiseMs), p.snareNoiseLevel * (patch.model === 'noisy' ? 1.15 : .9) * (electronic ? .65 : 1), 'bandpass', p.snareNoiseHz, 1.1);
    addNoise(durationFor(p.snareNoiseMs * .42), p.snareNoiseLevel * .3, 'highpass', 6500, .6);
    track(Math.max(bodyDuration, noise.duration));
  } else if (pad === 2 || pad === 3) {
    const open = pad === 3;
    const decay = durationFor(open ? p.openHatMs : p.closedHatMs);
    const filterHz = open ? p.openHatFilterHz : p.closedHatFilterHz;
    const level = open ? p.openHatMetalLevel : p.closedHatLevel;
    const noise = addNoise(decay, open ? p.openHatNoiseLevel : level, 'highpass', filterHz, .55);
    const baseHz = open ? 2300 : 3000;
    METAL_RATIOS.forEach((ratio, index) => addOsc(baseHz * ratio, decay, level / (electronic ? (open ? 5 : 7) : (open ? 8 : 10)), 'highpass', filterHz, electronic ? .7 : .45, 'square', undefined, undefined, startAt + index * (open ? .0007 : .0004)));
    track(noise.duration);
  } else if (pad === 4) {
    const burst = durationFor(p.clapBurstMs);
    const gap = durationFor(p.clapGapMs);
    const scale = patch.model === 'noisy' ? 1.12 : .9;
    addNoise(.012, p.clapCrackLevel * scale, 'highpass', 4200, .8);
    [0, 1, 2].forEach((index) => addNoise(burst * (1 - index * .12), p.clapCrackLevel * (1.1 - index * .2) * scale, 'bandpass', p.clapFilterHz + index * 380, .95, startAt + .006 + index * gap));
    const tail = addNoise(durationFor(p.clapTailMs), p.clapTailLevel * scale, 'highpass', Math.max(1200, p.clapFilterHz * .8), .45, startAt + .006 + gap * 2 + .012);
    track(tail.duration + .018 + gap * 2);
  } else if (pad === 5 || pad === 6) {
    const low = pad === 5;
    const startHz = low ? p.tomLowStartHz : p.tomHighStartHz;
    const endHz = low ? p.tomLowEndHz : p.tomHighEndHz;
    const body = addOsc(startHz, durationFor(380), low ? .68 : .56, 'lowpass', low ? 850 : 1400, electronic ? .55 : .8, electronic ? 'square' : 'sine', endHz, startAt + durationFor(p.tomFallMs));
    addOsc(startHz * .5, durationFor(320), low ? .25 : .18, 'lowpass', low ? 420 : 700, .7, 'triangle', endHz * .5, startAt + durationFor(p.tomFallMs));
    addNoise(durationFor(50), p.tomNoiseLevel * (electronic ? .45 : 1), 'bandpass', low ? 650 : 1100, 1.4);
    track(body.duration);
  } else if (pad === 7) {
    addOsc(p.percAHz, durationFor(120), electronic ? .27 : .2, 'bandpass', p.percAHz, electronic ? 3.5 : 5, 'square');
    addOsc(p.percBHz, durationFor(160), electronic ? .2 : .16, 'bandpass', p.percBHz, electronic ? 4.5 : 7, electronic ? 'square' : 'sine');
    addNoise(durationFor(14), .12, 'highpass', 4200, .5);
    track(durationFor(160));
  } else if (pad === 8) {
    const duration = durationFor(p.rimDecayMs);
    addOsc(p.rimHz, duration, .2, 'bandpass', p.rimFilterHz, 9, 'square');
    addOsc(p.rimHz * 1.7, duration * .8, .12, 'bandpass', p.rimFilterHz * 1.35, 11, 'triangle');
    addNoise(.014, p.rimNoiseLevel, 'highpass', p.rimFilterHz * 1.2, .7);
    track(duration);
  } else if (pad === 9) {
    const duration = numberValue(p, 'shakerMs', 550) / 1000;
    const attack = Math.min(duration * .35, p.shakerAttackMs / 1000);
    const noise = addNoise(duration, p.shakerLevel * (patch.model === 'noisy' ? 1.08 : .94), 'highpass', p.shakerFilterHz, p.shakerFilterQ, startAt, 700);
    track(Math.max(duration, attack));
    void noise;
  } else if (pad === 10) {
    const duration = durationFor(p.cowbellDecayMs);
    [1, 1.48, 1.62, 2.13].forEach((ratio, index) => addOsc(p.cowbellHzA * ratio, duration * (1 - index * .08), .18 / (index + 1), 'bandpass', p.cowbellFilterHz * (1 + index * .08), 7, 'square'));
    addOsc(p.cowbellHzB, duration * .8, .16, 'bandpass', p.cowbellFilterHz * 1.3, 8, 'square');
    addNoise(.022, p.cowbellNoiseLevel, 'bandpass', p.cowbellFilterHz * 2.2, 1.6);
    track(duration);
  } else {
    const duration = durationFor(p.rideMs);
    METAL_RATIOS.forEach((ratio, index) => addOsc(1450 * ratio, duration * (1 - index * .03), p.rideLevel / 9, 'highpass', p.rideFilterHz, .5, 'square', undefined, undefined, startAt + index * .0004));
    addNoise(duration, p.rideLevel * .72, 'highpass', p.rideFilterHz, .45);
    track(duration);
  }

  // The final voice gain is the only path into the profile bus. Room is a
  // per-hit tail downstream of that gain, so a choke never leaves a branch.
  mix.connect(finalGain).connect(profileBus.output);
  voice.addNode(mix);
  if (patch.room > .001) {
    const delay = context.createDelay(.3);
    const roomGain = context.createGain();
    const roomLevel = patch.room * .18;
    delay.delayTime.value = .075;
    roomGain.gain.value = roomLevel;
    finalGain.connect(delay).connect(roomGain).connect(profileBus.output);
    voice.addNode(delay); voice.addNode(roomGain);
    effectGains.push({ node: roomGain, level: roomLevel });
  }
  voice.onRelease((_when, end, kind) => {
    const tailEnd = end + (kind === 'choke' ? .02 : patch.effectTailSeconds);
    effectGains.forEach(({ node, level }) => scheduleSmoothFade(node.gain, end, Math.max(0, tailEnd - end), level, 0));
  });
  // Drum hits use a short complete-voice envelope. The component gains above
  // preserve the legacy per-pad decay, while this gain owns all endings.
  voice.start(startAt, { attackSeconds: .001, decaySeconds: .001, sustain: 1, releaseSeconds: .012 }, velocity);
  return { voice, sources, profile: patch, profileBus, openHat: pad === 3, durationSeconds: maxDuration };
};
