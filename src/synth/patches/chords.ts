import type { ChordEvent, DeckSoundProfile } from '../../deck.ts';
import type { VoiceLane } from '../contract.ts';
import { scheduleSmoothFade, smoothstepValueAt } from '../envelope.ts';
import { cloneAndFreezeProfile, ProfileBus } from '../profile-bus.ts';
import { SynthVoice } from '../voice.ts';

const BASE_CONTROLS = { tone: .55, attack: .35, width: .5, space: .25 };
const BASE_PARAMETERS = {
  attackMs: 180, decayMs: 240, sustainLevel: .68, releaseMs: 700,
  detuneCents: 8, filterHz: 3200, oscillatorMix: .8, harmonicLevel: .3,
  chorusMs: 8, delayMs: 320,
};

const chordPresetOverrides: Array<{
  presetId: string;
  controls: Record<string, number>;
  parameters: Record<string, number>;
  volume: number;
}> = [
  { presetId: 'Warm Pad', controls: { tone: .42, attack: .65, width: .38, space: .55 }, volume: .38, parameters: { attackMs: 360, releaseMs: 1200, detuneCents: 5, filterHz: 2600, delayMs: 420 } },
  { presetId: 'Soft Keys', controls: { tone: .35, attack: .3, width: .22, space: .3 }, volume: .42, parameters: { attackMs: 90, releaseMs: 520, detuneCents: 3, filterHz: 4200, delayMs: 220 } },
  { presetId: 'Glass FM', controls: { tone: .85, attack: .2, width: .65, space: .4 }, volume: .34, parameters: { attackMs: 40, releaseMs: 800, detuneCents: 18, filterHz: 7600, harmonicLevel: .55, delayMs: 300 } },
  { presetId: 'Organ', controls: { tone: .5, attack: .45, width: .3, space: .25 }, volume: .4, parameters: { attackMs: 120, releaseMs: 900, detuneCents: 2, filterHz: 5000, harmonicLevel: .7 } },
  { presetId: 'Pluck', controls: { tone: .72, attack: .08, width: .45, space: .2 }, volume: .4, parameters: { attackMs: 8, releaseMs: 300, detuneCents: 10, filterHz: 6200, delayMs: 160 } },
  { presetId: 'Wide Saw', controls: { tone: .78, attack: .18, width: .9, space: .65 }, volume: .32, parameters: { attackMs: 35, releaseMs: 1100, detuneCents: 24, filterHz: 7200, chorusMs: 13, delayMs: 480 } },
];

const completeProfile = (override: typeof chordPresetOverrides[number]): DeckSoundProfile => ({
  presetId: override.presetId,
  controls: { ...BASE_CONTROLS, ...override.controls },
  parameters: { ...BASE_PARAMETERS, ...override.parameters },
  volume: override.volume,
});

export const CHORD_PRESETS: DeckSoundProfile[] = chordPresetOverrides.map(completeProfile);
export const DEFAULT_CHORD_PROFILE: DeckSoundProfile = { ...CHORD_PRESETS[0], controls: { ...CHORD_PRESETS[0].controls }, parameters: { ...CHORD_PRESETS[0].parameters } };

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const numberValue = (values: Record<string, number>, name: string, fallback: number) => Number.isFinite(values[name]) ? values[name] : fallback;
const sortedEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const chordProfileFingerprint = (profile: DeckSoundProfile) => JSON.stringify([
  profile.presetId,
  sortedEntries(profile.controls),
  sortedEntries(profile.parameters),
  profile.volume,
]);

export type ChordPatchProfile = Readonly<{
  profile: Readonly<DeckSoundProfile>;
  type: OscillatorType;
  filterHz: number;
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
  detuneCents: number;
  oscillatorMix: number;
  harmonicLevel: number;
  delaySeconds: number;
  chorusSeconds: number;
}>;

/** The delay drain is part of the child voice lifetime. It is capped because
 * the common runtime must always have a finite cleanup horizon. */
export const chordEffectTailSeconds = (patch: Pick<ChordPatchProfile, 'delaySeconds' | 'chorusSeconds'>) =>
  Math.min(3, Math.max(0, patch.delaySeconds > 0 ? patch.delaySeconds + .05 : 0, patch.chorusSeconds > 0 ? patch.chorusSeconds + .05 : 0));

export const normalizeChordProfile = (input?: DeckSoundProfile, sampleRate = 48000): ChordPatchProfile => {
  const source = input ?? DEFAULT_CHORD_PROFILE;
  const controls = { ...BASE_CONTROLS, ...source.controls };
  const parameters = { ...BASE_PARAMETERS, ...source.parameters };
  const tone = clamp(numberValue(controls, 'tone', BASE_CONTROLS.tone));
  const safeNyquist = Math.max(20, sampleRate / 2 - 1);
  const frozen = cloneAndFreezeProfile({ ...source, controls: { ...controls }, parameters: { ...parameters } })!;
  return {
    profile: frozen,
    type: tone < .3 ? 'triangle' : 'sawtooth',
    filterHz: Math.min(safeNyquist, Math.max(20, numberValue(parameters, 'filterHz', 3200) * (.65 + tone * .7))),
    attackSeconds: Math.max(0, numberValue(parameters, 'attackMs', 180) / 1000 * (.5 + clamp(numberValue(controls, 'attack', .35)) * 1.5)),
    decaySeconds: Math.max(0, numberValue(parameters, 'decayMs', 240) / 1000),
    sustain: clamp(numberValue(parameters, 'sustainLevel', .68)),
    releaseSeconds: Math.max(.012, numberValue(parameters, 'releaseMs', 700) / 1000),
    detuneCents: numberValue(parameters, 'detuneCents', 8) + clamp(numberValue(controls, 'width', .5)) * 18,
    oscillatorMix: clamp(numberValue(parameters, 'oscillatorMix', .8)),
    harmonicLevel: clamp(numberValue(parameters, 'harmonicLevel', .3)),
    delaySeconds: Math.min(1, Math.max(0, numberValue(parameters, 'delayMs', 320) / 1000)),
    chorusSeconds: Math.min(.05, Math.max(0, numberValue(parameters, 'chorusMs', 8) / 1000)),
  };
};

export type ChordVoiceBuild = {
  voice: SynthVoice;
  sources: OscillatorNode[];
  frequency: number;
  profile: ChordPatchProfile;
  profileBus: ProfileBus;
};

/** Build one pitch of a chord. The parent manager puts the pitch voices in a
 * VoiceGroup so one chord releases and cleans up at one shared time. */
export const createChordVoice = (options: {
  context: BaseAudioContext;
  id: string;
  lane: VoiceLane;
  midi: number;
  startAt: number;
  velocity: number;
  profile: DeckSoundProfile;
  profileBus: ProfileBus;
}): ChordVoiceBuild => {
  const { context, id, lane, midi, startAt, velocity, profileBus } = options;
  const patch = normalizeChordProfile(options.profile, context.sampleRate);
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const finalGain = context.createGain();
  const voice = new SynthVoice({ id, instrument: 'chords', lane, profile: { fingerprint: chordProfileFingerprint(patch.profile), profile: patch.profile }, finalGain, context });
  voice.setEffectTailSeconds(chordEffectTailSeconds(patch));
  const input = context.createGain();
  const filter = context.createBiquadFilter();
  const left = context.createOscillator();
  const right = context.createOscillator();
  const harmonic = context.createOscillator();
  const leftGain = context.createGain();
  const rightGain = context.createGain();
  const harmonicGain = context.createGain();
  const noteVelocity = clamp(velocity);
  const detuneDelta = patch.detuneCents / 1200;

  input.gain.value = 1;
  filter.type = 'lowpass';
  filter.frequency.value = patch.filterHz;
  left.type = patch.type;
  right.type = patch.type;
  harmonic.type = 'sine';
  leftGain.gain.value = .22 * noteVelocity;
  rightGain.gain.value = .2 * patch.oscillatorMix * noteVelocity;
  harmonicGain.gain.value = .12 * patch.harmonicLevel * noteVelocity;
  left.connect(leftGain).connect(input);
  right.connect(rightGain).connect(input);
  harmonic.connect(harmonicGain).connect(input);
  input.connect(filter).connect(finalGain).connect(profileBus.output);
  voice.addNode(input); voice.addNode(filter); voice.addNode(leftGain); voice.addNode(rightGain); voice.addNode(harmonicGain);
  voice.addSource(left, startAt); voice.addSource(right, startAt); voice.addSource(harmonic, startAt);
  left.frequency.setValueAtTime(frequency * (1 - detuneDelta), startAt);
  right.frequency.setValueAtTime(frequency * (1 + detuneDelta), startAt);
  harmonic.frequency.setValueAtTime(frequency * 2, startAt);

  const controls = patch.profile.controls;
  const space = clamp(controls.space ?? .25);
  const effectGains: Array<{
    node: GainNode;
    level: number;
    fade: { start: number; end: number; from: number } | null;
  }> = [];
  if (patch.delaySeconds > 0 && space > 0) {
    const delay = context.createDelay(1);
    const delayGain = context.createGain();
    delay.delayTime.setValueAtTime(patch.delaySeconds, startAt);
    const delayLevel = space * .22;
    delayGain.gain.setValueAtTime(delayLevel, startAt);
    finalGain.connect(delay).connect(delayGain).connect(profileBus.output);
    voice.addNode(delay); voice.addNode(delayGain);
    effectGains.push({ node: delayGain, level: delayLevel, fade: null });
  }
  if (patch.chorusSeconds > 0 && space > 0) {
    const chorus = context.createDelay(.1);
    const chorusGain = context.createGain();
    chorus.delayTime.setValueAtTime(patch.chorusSeconds, startAt);
    const chorusLevel = Math.min(.3, patch.chorusSeconds * 100);
    chorusGain.gain.setValueAtTime(chorusLevel, startAt);
    finalGain.connect(chorus).connect(chorusGain).connect(profileBus.output);
    voice.addNode(chorus); voice.addNode(chorusGain);
    effectGains.push({ node: chorusGain, level: chorusLevel, fade: null });
  }

  voice.onRelease((_when, end, kind) => {
    const tailEnd = end + (kind === 'choke' ? .02 : chordEffectTailSeconds(patch));
    effectGains.forEach((effectGain) => {
      const from = effectGain.fade
        ? smoothstepValueAt(effectGain.fade.from, 0, effectGain.fade.start, effectGain.fade.end, end)
        : effectGain.level;
      scheduleSmoothFade(effectGain.node.gain, end, Math.max(0, tailEnd - end), from, 0);
      effectGain.fade = { start: end, end: tailEnd, from };
    });
  });

  voice.start(startAt, {
    attackSeconds: patch.attackSeconds,
    decaySeconds: patch.decaySeconds,
    sustain: patch.sustain,
    releaseSeconds: patch.releaseSeconds,
  }, 1);
  return { voice, sources: [left, right, harmonic], frequency, profile: patch, profileBus };
};

export const chordPitchesFromEvent = (event: Pick<ChordEvent, 'pitches'>) => event.pitches.map((pitch) => Number(pitch));
