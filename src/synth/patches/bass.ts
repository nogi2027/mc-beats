import type { DeckSoundProfile } from '../../deck.ts';
import { cloneAndFreezeProfile, ProfileBus } from '../profile-bus.ts';
import { SynthVoice } from '../voice.ts';
import type { VoiceLane } from '../contract.ts';

export type BassPatchProfile = Readonly<{
  profile: Readonly<DeckSoundProfile>;
  mainType: OscillatorType;
  subType: OscillatorType;
  clickType: OscillatorType;
  mainGain: number;
  subLevel: number;
  subOctave: number;
  filterHz: number;
  filterQ: number;
  drive: number;
  oversample: OverSampleType;
  clickHz: number;
  clickLevel: number;
  clickFilterHz: number;
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
  glideSeconds: number;
}>;

const defaultProfile: DeckSoundProfile = {
  presetId: 'Sub',
  controls: { tone: .5, shape: .35, glide: 0, drive: .2 },
  parameters: {
    subLevel: .28,
    filterHz: 2000,
    attackMs: 8,
    dwellMs: 180,
    decayMs: 350,
    sustainLevel: .65,
    releaseMs: 500,
    subOctave: -1,
    clickHz: 1800,
    clickLevel: .08,
    glideMs: 120,
  },
  volume: .62,
};

const bassPresetOverrides: Array<Partial<DeckSoundProfile> & { presetId: string; controls: Record<string, number>; parameters: Record<string, number>; volume: number }> = [
  { presetId: 'Sub', controls: { tone: .25, shape: .1, glide: 0, drive: .05 }, volume: .62, parameters: { subLevel: .42, filterHz: 900, dwellMs: 180, decayMs: 480, releaseMs: 500, clickLevel: 0 } },
  { presetId: 'Rubber', controls: { tone: .52, shape: .3, glide: .12, drive: .18 }, volume: .6, parameters: { subLevel: .35, filterHz: 1800, attackMs: 12, dwellMs: 150, decayMs: 400, releaseMs: 500 } },
  { presetId: 'Acid', controls: { tone: .7, shape: .68, glide: .28, drive: .42 }, volume: .52, parameters: { subLevel: .24, filterHz: 3400, attackMs: 4, dwellMs: 90, decayMs: 240, releaseMs: 500, glideMs: 220 } },
  { presetId: 'Pluck', controls: { tone: .8, shape: .6, glide: .05, drive: .12 }, volume: .56, parameters: { subLevel: .2, filterHz: 4200, attackMs: 2, dwellMs: 45, decayMs: 120, releaseMs: 500, clickLevel: .18 } },
  { presetId: 'Pulse', controls: { tone: .58, shape: .9, glide: .1, drive: .25 }, volume: .55, parameters: { subLevel: .3, filterHz: 2600, dwellMs: 110, releaseMs: 500, clickHz: 2400, clickLevel: .1 } },
  { presetId: 'Distorted', controls: { tone: .72, shape: .72, glide: .18, drive: .85 }, volume: .45, parameters: { subLevel: .18, filterHz: 5200, attackMs: 5, dwellMs: 220, decayMs: 600, releaseMs: 500, clickLevel: .2, glideMs: 180 } },
];

export const BASS_PRESETS: DeckSoundProfile[] = bassPresetOverrides.map((override) => ({
  ...defaultProfile,
  ...override,
  controls: { ...defaultProfile.controls, ...override.controls },
  parameters: { ...defaultProfile.parameters, ...override.parameters },
}));

export const DEFAULT_BASS_PROFILE: DeckSoundProfile = { ...BASS_PRESETS[0], controls: { ...BASS_PRESETS[0].controls }, parameters: { ...BASS_PRESETS[0].parameters } };

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const numberValue = (values: Record<string, number>, name: string, fallback: number) => Number.isFinite(values[name]) ? values[name] : fallback;
const sortedEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const bassProfileFingerprint = (profile: DeckSoundProfile) => JSON.stringify([
  profile.presetId,
  sortedEntries(profile.controls),
  sortedEntries(profile.parameters),
  profile.volume,
]);

const oscillatorType = (shape: number): OscillatorType => shape < .25 ? 'sine' : shape < .55 ? 'triangle' : shape < .8 ? 'sawtooth' : 'square';

export const bassDriveCurve = (drive: number) => {
  const curve = new Float32Array(257);
  if (drive <= 0) {
    for (let index = 0; index < curve.length; index += 1) curve[index] = index * 2 / (curve.length - 1) - 1;
    return curve;
  }
  const amount = 1 + drive * 45;
  for (let index = 0; index < curve.length; index += 1) {
    const x = index * 2 / (curve.length - 1) - 1;
    curve[index] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
};

export const normalizeBassProfile = (input?: DeckSoundProfile, sampleRate = 48000): BassPatchProfile => {
  const source = input ?? DEFAULT_BASS_PROFILE;
  const controls = { ...DEFAULT_BASS_PROFILE.controls, ...source.controls };
  const parameters = { ...DEFAULT_BASS_PROFILE.parameters, ...source.parameters };
  const tone = clamp(numberValue(controls, 'tone', .5));
  const safeNyquist = Math.max(20, sampleRate / 2 - 1);
  const rawFilter = numberValue(parameters, 'filterHz', 2000) * (.5 + tone * 1.25);
  const attack = Math.max(0, numberValue(parameters, 'attackMs', 8)) / 1000;
  const decay = Math.max(0, numberValue(parameters, 'decayMs', 350)) / 1000;
  const sustain = clamp(numberValue(parameters, 'sustainLevel', .65));
  const release = Math.max(.012, numberValue(parameters, 'releaseMs', 500) / 1000);
  const glide = Math.min(.5, Math.max(0, numberValue(parameters, 'glideMs', 120) / 1000 * clamp(numberValue(controls, 'glide', 0))));
  const frozenProfile = cloneAndFreezeProfile({
    ...source,
    controls: { ...controls },
    parameters: { ...parameters },
  })!;
  return {
    profile: frozenProfile,
    mainType: oscillatorType(clamp(numberValue(controls, 'shape', .35))),
    subType: 'sine',
    clickType: 'triangle',
    mainGain: .7,
    subLevel: clamp(numberValue(parameters, 'subLevel', .28)),
    subOctave: Math.max(-2, Math.min(-.5, numberValue(parameters, 'subOctave', -1))),
    filterHz: Math.min(safeNyquist, Math.max(20, rawFilter)),
    filterQ: .7,
    drive: clamp(numberValue(controls, 'drive', .2)),
    oversample: '2x',
    clickHz: Math.min(safeNyquist, Math.max(20, numberValue(parameters, 'clickHz', 1800))),
    clickLevel: clamp(numberValue(parameters, 'clickLevel', 0), 0, .5) * (.3 + tone * .5),
    clickFilterHz: Math.min(safeNyquist, Math.max(20, numberValue(parameters, 'clickHz', 1800) * .7)),
    attackSeconds: attack,
    decaySeconds: decay,
    sustain,
    releaseSeconds: release,
    glideSeconds: glide,
  };
};

export type BassVoiceBuild = {
  voice: SynthVoice;
  sources: OscillatorNode[];
  frequency: number;
  profile: BassPatchProfile;
  profileBus: ProfileBus;
};

export const createBassVoice = (options: {
  context: BaseAudioContext;
  id: string;
  lane: VoiceLane;
  midi: number;
  startAt: number;
  velocity: number;
  profile: DeckSoundProfile;
  profileBus: ProfileBus;
  glideFromHz?: number;
}) : BassVoiceBuild => {
  const { context, id, lane, midi, startAt, velocity, profileBus, glideFromHz } = options;
  const patch = normalizeBassProfile(options.profile, context.sampleRate);
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const finalGain = context.createGain();
  const voice = new SynthVoice({
    id,
    instrument: 'bass',
    lane,
    profile: { fingerprint: bassProfileFingerprint(patch.profile), profile: patch.profile },
    finalGain,
    context,
  });
  const main = context.createOscillator();
  const sub = context.createOscillator();
  const mainGain = context.createGain();
  const subGain = context.createGain();
  const toneFilter = context.createBiquadFilter();
  const shaper = context.createWaveShaper();
  const mix = context.createGain();
  // Keep the patch-level mix at unity. Overall headroom belongs to the
  // production master/output layer, not to each independent voice.
  mix.gain.value = 1;
  main.type = patch.mainType;
  sub.type = patch.subType;
  mainGain.gain.value = patch.mainGain;
  subGain.gain.value = patch.subLevel;
  toneFilter.type = 'lowpass';
  toneFilter.frequency.value = patch.filterHz;
  toneFilter.Q.value = patch.filterQ;
  shaper.curve = bassDriveCurve(patch.drive);
  shaper.oversample = patch.oversample;
  main.connect(mainGain).connect(toneFilter).connect(shaper).connect(mix).connect(finalGain).connect(profileBus.output);
  sub.connect(subGain).connect(toneFilter);
  voice.addNode(mainGain); voice.addNode(subGain); voice.addNode(toneFilter); voice.addNode(shaper); voice.addNode(mix);
  voice.addSource(main, startAt); voice.addSource(sub, startAt);

  const clickSources: OscillatorNode[] = [];
  if (patch.clickLevel > 0) {
    const click = context.createOscillator();
    const clickGain = context.createGain();
    const clickFilter = context.createBiquadFilter();
    click.type = patch.clickType;
    click.frequency.value = patch.clickHz;
    clickGain.gain.value = patch.clickLevel * clamp(velocity);
    clickFilter.type = 'highpass';
    clickFilter.frequency.value = patch.clickFilterHz;
    click.connect(clickFilter).connect(clickGain).connect(mix);
    clickGain.gain.setValueAtTime(patch.clickLevel * clamp(velocity), startAt);
    clickGain.gain.linearRampToValueAtTime(0, startAt + .025);
    voice.addNode(clickGain); voice.addNode(clickFilter); voice.addSource(click, startAt);
    clickSources.push(click);
  }

  const glideFrom = Number.isFinite(glideFromHz) ? glideFromHz! : frequency;
  main.frequency.setValueAtTime(patch.glideSeconds > 0 ? glideFrom : frequency, startAt);
  sub.frequency.setValueAtTime(patch.glideSeconds > 0 ? glideFrom * Math.pow(2, patch.subOctave) : frequency * Math.pow(2, patch.subOctave), startAt);
  if (patch.glideSeconds > 0) {
    main.frequency.exponentialRampToValueAtTime(frequency, startAt + patch.glideSeconds);
    sub.frequency.exponentialRampToValueAtTime(frequency * Math.pow(2, patch.subOctave), startAt + patch.glideSeconds);
  }
  voice.start(startAt, {
    attackSeconds: patch.attackSeconds,
    decaySeconds: patch.decaySeconds,
    sustain: patch.sustain,
    releaseSeconds: patch.releaseSeconds,
  }, clamp(velocity));
  return { voice, sources: [main, sub, ...clickSources], frequency, profile: patch, profileBus };
};
