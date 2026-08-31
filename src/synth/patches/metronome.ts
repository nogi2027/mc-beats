import type { DeckSoundProfile } from '../../deck.ts';
import type { VoiceLane } from '../contract.ts';
import { cloneAndFreezeProfile, ProfileBus } from '../profile-bus.ts';
import { SynthVoice } from '../voice.ts';

const BASE_CONTROLS = { tone: .55, attack: .15, decay: .3, level: .5 };
const BASE_PARAMETERS = {
  clickHz: 1700,
  accentHz: 2500,
  attackMs: 2,
  decayMs: 65,
  clickLevel: .42,
  filterHz: 5200,
};

const presetOverrides: Array<{ presetId: string; controls: Record<string, number>; parameters: Record<string, number>; volume: number }> = [
  { presetId: 'Classic Click', controls: { tone: .55, attack: .15, decay: .3, level: .5 }, volume: .5, parameters: { clickHz: 1700, accentHz: 2500, attackMs: 2, decayMs: 65, clickLevel: .42, filterHz: 5200 } },
  { presetId: 'Bright Click', controls: { tone: .8, attack: .08, decay: .15, level: .42 }, volume: .44, parameters: { clickHz: 2400, accentHz: 3600, attackMs: 1, decayMs: 35, clickLevel: .34, filterHz: 7800 } },
  { presetId: 'Soft Tick', controls: { tone: .25, attack: .4, decay: .7, level: .5 }, volume: .45, parameters: { clickHz: 900, accentHz: 1350, attackMs: 8, decayMs: 150, clickLevel: .3, filterHz: 2400 } },
  { presetId: 'Wood Block', controls: { tone: .65, attack: .1, decay: .2, level: .48 }, volume: .48, parameters: { clickHz: 1250, accentHz: 1900, attackMs: 2, decayMs: 48, clickLevel: .38, filterHz: 4200 } },
  { presetId: 'Digital', controls: { tone: .9, attack: .03, decay: .1, level: .35 }, volume: .4, parameters: { clickHz: 3200, accentHz: 4800, attackMs: 1, decayMs: 24, clickLevel: .28, filterHz: 10000 } },
  { presetId: 'Low Tick', controls: { tone: .15, attack: .25, decay: .85, level: .38 }, volume: .38, parameters: { clickHz: 650, accentHz: 980, attackMs: 5, decayMs: 220, clickLevel: .25, filterHz: 1800 } },
];

const completeProfile = (override: typeof presetOverrides[number]): DeckSoundProfile => ({
  presetId: override.presetId,
  controls: { ...BASE_CONTROLS, ...override.controls },
  parameters: { ...BASE_PARAMETERS, ...override.parameters },
  volume: override.volume,
});

export const METRONOME_PRESETS = presetOverrides.map(completeProfile);
export const DEFAULT_METRONOME_PROFILE: DeckSoundProfile = {
  ...METRONOME_PRESETS[0],
  controls: { ...METRONOME_PRESETS[0].controls },
  parameters: { ...METRONOME_PRESETS[0].parameters },
};

const finite = (values: Record<string, number>, name: string, fallback: number) => Number.isFinite(values[name]) ? values[name] : fallback;
const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const sortedEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const metronomeProfileFingerprint = (profile: DeckSoundProfile) => JSON.stringify([
  profile.presetId,
  sortedEntries(profile.controls),
  sortedEntries(profile.parameters),
  profile.volume,
]);

export type MetronomePatchProfile = Readonly<{
  profile: Readonly<DeckSoundProfile>;
  clickHz: number;
  accentHz: number;
  filterHz: number;
  attackSeconds: number;
  durationSeconds: number;
  level: number;
}>;

export const normalizeMetronomeProfile = (input?: DeckSoundProfile, sampleRate = 48000): MetronomePatchProfile => {
  const source = input ?? DEFAULT_METRONOME_PROFILE;
  const controls = { ...BASE_CONTROLS, ...source.controls };
  const parameters = { ...BASE_PARAMETERS, ...source.parameters };
  const safeNyquist = Math.max(20, sampleRate / 2 - 1);
  const tone = clamp(finite(controls, 'tone', BASE_CONTROLS.tone));
  const attack = clamp(finite(controls, 'attack', BASE_CONTROLS.attack));
  const decay = clamp(finite(controls, 'decay', BASE_CONTROLS.decay));
  const level = clamp(finite(controls, 'level', BASE_CONTROLS.level));
  const attackSeconds = Math.max(.001, finite(parameters, 'attackMs', BASE_PARAMETERS.attackMs) / 1000 * (.5 + attack * 1.5));
  const durationSeconds = Math.max(.004, finite(parameters, 'decayMs', BASE_PARAMETERS.decayMs) / 1000 * (.5 + decay * 1.5));
  return {
    profile: cloneAndFreezeProfile({ ...source, controls, parameters })!,
    clickHz: Math.max(20, finite(parameters, 'clickHz', BASE_PARAMETERS.clickHz) * (.7 + tone * .6)),
    accentHz: Math.max(20, finite(parameters, 'accentHz', BASE_PARAMETERS.accentHz) * (.7 + tone * .6)),
    filterHz: Math.min(safeNyquist, Math.max(20, finite(parameters, 'filterHz', BASE_PARAMETERS.filterHz) * (.65 + tone * .7))),
    attackSeconds: Math.min(attackSeconds, durationSeconds * .5),
    durationSeconds,
    level,
  };
};

export type MetronomeVoiceBuild = {
  voice: SynthVoice;
  sources: OscillatorNode[];
  profile: MetronomePatchProfile;
  profileBus: ProfileBus;
  durationSeconds: number | null;
};

/** One click is one ordinary independent voice. The oscillator and filter
 * reach the profile bus only through this voice's final gain. */
export const createMetronomeVoice = (options: {
  context: BaseAudioContext;
  id: string;
  lane: VoiceLane;
  startAt: number;
  accent: boolean;
  durationSeconds: number | null;
  frequencyOverride?: number;
  velocity: number;
  profile: DeckSoundProfile;
  profileBus: ProfileBus;
}): MetronomeVoiceBuild => {
  const { context, id, lane, startAt, accent, durationSeconds, frequencyOverride, profileBus } = options;
  const patch = normalizeMetronomeProfile(options.profile, context.sampleRate);
  const finalGain = context.createGain();
  const filter = context.createBiquadFilter();
  const oscillator = context.createOscillator();
  const toneGain = context.createGain();
  const voice = new SynthVoice({
    id,
    instrument: 'metronome',
    lane,
    profile: { fingerprint: metronomeProfileFingerprint(patch.profile), profile: patch.profile },
    finalGain,
    context,
  });
  const frequency = frequencyOverride ?? (accent ? patch.accentHz : patch.clickHz);
  const peakLevel = Math.max(.0001, finite(patch.profile.parameters, 'clickLevel', BASE_PARAMETERS.clickLevel) * patch.level * (accent ? 1 : .78));
  filter.type = 'highpass';
  filter.frequency.value = patch.filterHz;
  oscillator.type = 'square';
  oscillator.frequency.setValueAtTime(frequency, startAt);
  toneGain.gain.value = peakLevel;
  oscillator.connect(filter).connect(toneGain).connect(finalGain).connect(profileBus.output);
  voice.addNode(filter); voice.addNode(toneGain);
  voice.addSource(oscillator, startAt);
  voice.start(startAt, {
    attackSeconds: patch.attackSeconds,
    decaySeconds: durationSeconds === null ? .02 : Math.max(.001, durationSeconds - patch.attackSeconds),
    sustain: durationSeconds === null ? 1 : .000125,
    releaseSeconds: .012,
    attackCurve: 'exponential',
    decayCurve: durationSeconds === null ? 'linear' : 'exponential',
  }, clamp(options.velocity));
  if (durationSeconds !== null) voice.release(startAt + durationSeconds, .012);
  return { voice, sources: [oscillator], profile: patch, profileBus, durationSeconds };
};
