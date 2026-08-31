import type { DeckSoundProfile } from '../../deck.ts';
import type { VoiceLane } from '../contract.ts';
import { scheduleSmoothFade, smoothstepValueAt } from '../envelope.ts';
import { cloneAndFreezeProfile, ProfileBus } from '../profile-bus.ts';
import { SynthVoice } from '../voice.ts';

const BASE_CONTROLS = { tone: .65, bite: .35, motion: .2, echo: .15 };
const BASE_PARAMETERS = {
  attackMs: 8, decayMs: 420, sustainLevel: .72, releaseMs: 450,
  filterHz: 5200, detuneCents: 5, vibratoHz: 4, vibratoCents: 12,
  chorusDelayMs: 10, chorusDepthMs: 0, chorusRateHz: 1, chorusMix: 0,
  echoMs: 280, echoFeedback: .25,
};

const leadPresetOverrides: Array<{
  presetId: string;
  controls: Record<string, number>;
  parameters: Record<string, number>;
  volume: number;
}> = [
  { presetId: 'Bright Mono', controls: { tone: .8, bite: .45, motion: .12, echo: .18 }, volume: .46, parameters: { attackMs: 5, decayMs: 360, sustainLevel: .72, releaseMs: 450, filterHz: 7200, detuneCents: 4, vibratoHz: 4, vibratoCents: 8, echoMs: 220 } },
  { presetId: 'Soft Sine', controls: { tone: .08, bite: .12, motion: .05, echo: .05 }, volume: .5, parameters: { attackMs: 18, decayMs: 560, sustainLevel: .72, releaseMs: 450, filterHz: 2600, detuneCents: 0, vibratoHz: 3, vibratoCents: 5 } },
  { presetId: 'Pulse Lead', controls: { tone: .9, bite: .55, motion: .2, echo: .25 }, volume: .42, parameters: { attackMs: 4, decayMs: 300, sustainLevel: .72, releaseMs: 450, filterHz: 8200, detuneCents: 12, vibratoHz: 5, vibratoCents: 16, echoMs: 260 } },
  { presetId: 'FM Bell', controls: { tone: .65, bite: .25, motion: .45, echo: .4 }, volume: .38, parameters: { attackMs: 8, decayMs: 700, sustainLevel: .72, releaseMs: 450, filterHz: 9000, detuneCents: 3, vibratoHz: 6, vibratoCents: 28, echoMs: 360, echoFeedback: .38 } },
  { presetId: 'Distorted', controls: { tone: .72, bite: .85, motion: .15, echo: .12 }, volume: .35, parameters: { attackMs: 2, decayMs: 260, sustainLevel: .72, releaseMs: 450, filterHz: 6800, detuneCents: 18, vibratoHz: 4.5, vibratoCents: 10, echoFeedback: .12 } },
  { presetId: 'Airy', controls: { tone: .48, bite: .2, motion: .7, echo: .62 }, volume: .4, parameters: { attackMs: 35, decayMs: 900, sustainLevel: .72, releaseMs: 1200, filterHz: 6000, detuneCents: 9, vibratoHz: 7, vibratoCents: 34, echoMs: 520, echoFeedback: .48 } },
  { presetId: 'Strings', controls: { tone: .42, bite: .22, motion: .28, echo: .25 }, volume: .42, parameters: { attackMs: 350, decayMs: 650, sustainLevel: .72, releaseMs: 750, filterHz: 4200, detuneCents: 12, vibratoHz: 5.5, vibratoCents: 24, chorusDelayMs: 18, chorusDepthMs: 2.3, chorusRateHz: .55, chorusMix: 1, echoMs: 300, echoFeedback: .18 } },
];

const completeProfile = (override: typeof leadPresetOverrides[number]): DeckSoundProfile => ({
  presetId: override.presetId,
  controls: { ...BASE_CONTROLS, ...override.controls },
  parameters: { ...BASE_PARAMETERS, ...override.parameters },
  volume: override.volume,
});

export const LEAD_PRESETS: DeckSoundProfile[] = leadPresetOverrides.map(completeProfile);
export const DEFAULT_LEAD_PROFILE: DeckSoundProfile = { ...LEAD_PRESETS[0], controls: { ...LEAD_PRESETS[0].controls }, parameters: { ...LEAD_PRESETS[0].parameters } };

const clamp = (value: number, min = 0, max = 1) => Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
const numberValue = (values: Record<string, number>, name: string, fallback: number) => Number.isFinite(values[name]) ? values[name] : fallback;
const sortedEntries = (record: Record<string, number>) => Object.entries(record).sort(([left], [right]) => left.localeCompare(right));

export const leadProfileFingerprint = (profile: DeckSoundProfile) => JSON.stringify([
  profile.presetId,
  sortedEntries(profile.controls),
  sortedEntries(profile.parameters),
  profile.volume,
]);

export type LeadPatchProfile = Readonly<{
  profile: Readonly<DeckSoundProfile>;
  type: OscillatorType;
  filterHz: number;
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
  detuneCents: number;
  vibratoHz: number;
  vibratoCents: number;
  echoSeconds: number;
  echoFeedback: number;
  chorusDelaySeconds: number;
  chorusDepthSeconds: number;
  chorusRateHz: number;
  chorusMix: number;
}>;

/** Upper bound for a note-owned effect drain. The threshold is -60 dB and
 * the cap prevents a bad feedback value from keeping a voice alive forever. */
export const leadEffectTailSeconds = (patch: Pick<LeadPatchProfile, 'echoSeconds' | 'echoFeedback' | 'chorusDelaySeconds' | 'chorusDepthSeconds' | 'chorusMix'>) => {
  const echoTail = patch.echoSeconds <= 0 || patch.echoFeedback <= 0
    ? patch.echoSeconds
    : patch.echoSeconds * (1 + Math.ceil(Math.log(.001) / Math.log(Math.max(.001, Math.min(.85, patch.echoFeedback)))));
  const chorusTail = patch.chorusMix > 0 && patch.chorusDelaySeconds > 0
    ? patch.chorusDelaySeconds + Math.min(patch.chorusDepthSeconds, patch.chorusDelaySeconds * .9) + .05
    : 0;
  return Math.min(3, Math.max(0, echoTail, chorusTail));
};

export const normalizeLeadProfile = (input?: DeckSoundProfile, sampleRate = 48000): LeadPatchProfile => {
  const source = input ?? DEFAULT_LEAD_PROFILE;
  const controls = { ...BASE_CONTROLS, ...source.controls };
  const parameters = { ...BASE_PARAMETERS, ...source.parameters };
  const tone = clamp(numberValue(controls, 'tone', BASE_CONTROLS.tone));
  const bite = clamp(numberValue(controls, 'bite', BASE_CONTROLS.bite));
  const safeNyquist = Math.max(20, sampleRate / 2 - 1);
  const oscillatorTone = clamp(tone + bite * .15);
  const frozen = cloneAndFreezeProfile({
    ...source,
    controls: { ...controls },
    parameters: { ...parameters },
  })!;
  return {
    profile: frozen,
    type: oscillatorTone < .25 ? 'sine' : oscillatorTone < .52 ? 'triangle' : oscillatorTone < .82 ? 'sawtooth' : 'square',
    filterHz: Math.min(safeNyquist, Math.max(20, numberValue(parameters, 'filterHz', 5200) * (.55 + bite * .85))),
    attackSeconds: Math.max(0, numberValue(parameters, 'attackMs', 8) / 1000),
    decaySeconds: Math.max(0, numberValue(parameters, 'decayMs', 420) / 1000),
    sustain: clamp(numberValue(parameters, 'sustainLevel', .72)),
    releaseSeconds: Math.max(.012, numberValue(parameters, 'releaseMs', 450) / 1000),
    detuneCents: numberValue(parameters, 'detuneCents', 5),
    vibratoHz: Math.max(0, numberValue(parameters, 'vibratoHz', 4) * (.65 + clamp(numberValue(controls, 'motion', .2)) * .7)),
    vibratoCents: Math.max(0, numberValue(parameters, 'vibratoCents', 12) * clamp(numberValue(controls, 'motion', .2))),
    echoSeconds: Math.min(1.2, Math.max(0, numberValue(parameters, 'echoMs', 280) / 1000)),
    echoFeedback: Math.min(.85, Math.max(0, numberValue(parameters, 'echoFeedback', .25) * clamp(numberValue(controls, 'echo', .15)))),
    chorusDelaySeconds: Math.min(.09, Math.max(0, numberValue(parameters, 'chorusDelayMs', 10) / 1000)),
    chorusDepthSeconds: Math.max(0, numberValue(parameters, 'chorusDepthMs', 0) / 1000),
    chorusRateHz: Math.max(0, numberValue(parameters, 'chorusRateHz', 1)),
    chorusMix: clamp(numberValue(parameters, 'chorusMix', 0)),
  };
};

export type LeadVoiceBuild = {
  voice: SynthVoice;
  sources: OscillatorNode[];
  frequency: number;
  profile: LeadPatchProfile;
  profileBus: ProfileBus;
};

/** Build one complete lead note. All dry and effect returns cross the one
 * voice finalGain before reaching the immutable profile bus. */
export const createLeadVoice = (options: {
  context: BaseAudioContext;
  id: string;
  lane: VoiceLane;
  midi: number;
  startAt: number;
  velocity: number;
  profile: DeckSoundProfile;
  profileBus: ProfileBus;
}): LeadVoiceBuild => {
  const { context, id, lane, midi, startAt, velocity, profileBus } = options;
  const patch = normalizeLeadProfile(options.profile, context.sampleRate);
  const frequency = 440 * Math.pow(2, (midi - 69) / 12);
  const finalGain = context.createGain();
  const voice = new SynthVoice({ id, instrument: 'lead', lane, profile: { fingerprint: leadProfileFingerprint(patch.profile), profile: patch.profile }, finalGain, context });
  voice.setEffectTailSeconds(leadEffectTailSeconds(patch));
  const input = context.createGain();
  const filter = context.createBiquadFilter();
  const main = context.createOscillator();
  const second = context.createOscillator();
  const mainGain = context.createGain();
  const secondGain = context.createGain();
  const noteVelocity = clamp(velocity);

  input.gain.value = 1;
  filter.type = 'lowpass';
  filter.frequency.value = patch.filterHz;
  main.type = patch.type;
  second.type = patch.type;
  mainGain.gain.value = .46 * noteVelocity;
  secondGain.gain.value = .2 * noteVelocity;
  main.connect(mainGain).connect(input);
  second.connect(secondGain).connect(input);
  input.connect(filter).connect(finalGain).connect(profileBus.output);
  voice.addNode(input); voice.addNode(filter); voice.addNode(mainGain); voice.addNode(secondGain);
  voice.addSource(main, startAt); voice.addSource(second, startAt);

  main.frequency.setValueAtTime(frequency, startAt);
  second.frequency.setValueAtTime(frequency * Math.pow(2, patch.detuneCents / 1200), startAt);

  const lfos: OscillatorNode[] = [];
  const motion = clamp(patch.profile.controls.motion ?? .2);
  if (motion > .01 && patch.vibratoHz > 0 && patch.vibratoCents > 0) {
    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.setValueAtTime(patch.vibratoHz, startAt);
    lfoGain.gain.setValueAtTime(patch.vibratoCents, startAt);
    lfo.connect(lfoGain).connect(main.detune);
    voice.addNode(lfoGain);
    voice.addSource(lfo, startAt);
    lfos.push(lfo);
  }

  const echo = context.createDelay(1.2);
  const echoGain = context.createGain();
  const feedback = context.createGain();
  const effectGains: Array<{
    node: GainNode;
    level: number;
    fade: { start: number; end: number; from: number } | null;
  }> = [];
  if (patch.echoSeconds > 0 && (patch.profile.controls.echo ?? .15) > 0) {
    echo.delayTime.setValueAtTime(patch.echoSeconds, startAt);
    const echoLevel = clamp(patch.profile.controls.echo ?? .15) * .35;
    echoGain.gain.setValueAtTime(echoLevel, startAt);
    feedback.gain.setValueAtTime(patch.echoFeedback, startAt);
    finalGain.connect(echo).connect(echoGain).connect(profileBus.output);
    echo.connect(feedback).connect(echo);
    voice.addNode(echo); voice.addNode(echoGain); voice.addNode(feedback);
    effectGains.push({ node: echoGain, level: echoLevel, fade: null }, { node: feedback, level: patch.echoFeedback, fade: null });
  }

  if (patch.chorusMix > 0 && patch.chorusDelaySeconds > 0) {
    const dry = context.createGain();
    const taps = [
      { delay: patch.chorusDelaySeconds, depth: patch.chorusDepthSeconds, rate: patch.chorusRateHz },
      { delay: Math.min(.09, patch.chorusDelaySeconds * 1.55), depth: patch.chorusDepthSeconds * .82, rate: patch.chorusRateHz * 1.17 },
      { delay: Math.min(.09, patch.chorusDelaySeconds * .72), depth: patch.chorusDepthSeconds * .62, rate: patch.chorusRateHz * .83 },
    ];
    dry.gain.value = 1 - patch.chorusMix * .35;
    finalGain.connect(dry).connect(profileBus.output);
    voice.addNode(dry);
    taps.forEach((tap) => {
      const chorusDelay = context.createDelay(.1);
      const chorusGain = context.createGain();
      const chorusLfo = context.createOscillator();
      const chorusDepth = context.createGain();
      const chorusLevel = patch.chorusMix / taps.length;
      chorusGain.gain.value = chorusLevel;
      chorusDelay.delayTime.setValueAtTime(tap.delay, startAt);
      chorusLfo.frequency.setValueAtTime(tap.rate, startAt);
      chorusDepth.gain.setValueAtTime(Math.min(tap.depth, tap.delay * .9), startAt);
      finalGain.connect(chorusDelay).connect(chorusGain).connect(profileBus.output);
      chorusLfo.connect(chorusDepth).connect(chorusDelay.delayTime);
      voice.addNode(chorusDelay); voice.addNode(chorusGain); voice.addNode(chorusDepth);
      voice.addSource(chorusLfo, startAt);
      effectGains.push({ node: chorusGain, level: chorusLevel, fade: null });
    });
  }

  voice.onRelease((_when, end, kind) => {
    const tailEnd = end + (kind === 'choke' ? .02 : leadEffectTailSeconds(patch));
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
  return { voice, sources: [main, second, ...lfos], frequency, profile: patch, profileBus };
};
