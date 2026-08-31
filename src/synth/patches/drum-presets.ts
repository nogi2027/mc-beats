/** Shared drum preset overrides. The first six entries mirror the legacy
 * preset table exactly; the last three are new procedural kits. */
export type DrumPresetOverride = {
  presetId: string;
  controls: Record<string, number>;
  parameters: Record<string, number>;
  volume: number;
};

export const DRUM_PRESET_OVERRIDES: DrumPresetOverride[] = [
  { presetId: 'Clean', controls: { punch: .5, tightness: .55, dirt: .05, room: .12 }, volume: .7, parameters: { kickStartHz: 170, kickDecayMs: 360, snareBodyHz: 180, closedHatMs: 42, openHatMs: 360 } },
  { presetId: 'Classic', controls: { punch: .75, tightness: .45, dirt: .2, room: .22 }, volume: .68, parameters: { kickStartHz: 210, kickPitchFallMs: 75, snareBodyHz: 210, snareNoiseMs: 210, clapGapMs: 18 } },
  { presetId: 'Soft', controls: { punch: .35, tightness: .8, dirt: 0, room: .35 }, volume: .64, parameters: { kickStartHz: 155, kickDecayMs: 240, snareNoiseMs: 120, closedHatMs: 30, openHatMs: 280 } },
  { presetId: 'Tight', controls: { punch: .7, tightness: .95, dirt: .08, room: .08 }, volume: .72, parameters: { kickPitchFallMs: 45, kickDecayMs: 180, snareNoiseMs: 90, closedHatMs: 18, openHatMs: 180, tomFallMs: 70 } },
  { presetId: 'Industrial', controls: { punch: .9, tightness: .35, dirt: .65, room: .18 }, volume: .58, parameters: { kickStartHz: 250, kickEndHz: 42, kickDecayMs: 500, snareBodyHz: 260, snareNoiseMs: 300, percAHz: 1100, percBHz: 1750 } },
  { presetId: 'Lo-fi', controls: { punch: .4, tightness: .7, dirt: .85, room: .4 }, volume: .55, parameters: { kickStartHz: 130, kickEndHz: 55, kickPitchFallMs: 150, snareBodyHz: 150, closedHatMs: 65, openHatMs: 520, clapGapMs: 28 } },
  { presetId: '808', controls: { punch: .95, tightness: .68, dirt: .12, room: .04 }, volume: .7, parameters: { kickStartHz: 190, kickEndHz: 32, kickPitchFallMs: 180, kickDecayMs: 720, kickClickHz: 4200, kickClickMs: 8, snareBodyHz: 165, snareBodyMs: 95, snareNoiseMs: 110, closedHatMs: 24, openHatMs: 210, closedHatFilterHz: 9800, openHatFilterHz: 7600, tomLowStartHz: 145, tomLowEndHz: 58, tomHighStartHz: 250, tomHighEndHz: 112, cowbellHzA: 620, cowbellHzB: 910, cowbellDecayMs: 150 } },
  { presetId: 'Circuit', controls: { punch: .86, tightness: .9, dirt: .28, room: .06 }, volume: .66, parameters: { kickStartHz: 220, kickEndHz: 62, kickPitchFallMs: 42, kickDecayMs: 210, snareBodyHz: 240, snareBodyMs: 70, snareNoiseMs: 75, snareNoiseHz: 3600, closedHatMs: 16, openHatMs: 150, closedHatFilterHz: 11200, openHatFilterHz: 9200, percAHz: 960, percBHz: 1680, rimHz: 2100, rimDecayMs: 28 } },
  { presetId: 'Glitch', controls: { punch: .78, tightness: .98, dirt: .4, room: .02 }, volume: .6, parameters: { kickStartHz: 260, kickEndHz: 48, kickPitchFallMs: 28, kickDecayMs: 145, snareBodyHz: 310, snareBodyMs: 52, snareNoiseMs: 55, snareNoiseHz: 5200, closedHatMs: 11, openHatMs: 105, closedHatFilterHz: 12000, openHatFilterHz: 10000, clapGapMs: 8, clapBurstMs: 24, percAHz: 1370, percBHz: 2270, rimHz: 2860, rimDecayMs: 20, cowbellHzA: 710, cowbellHzB: 1170 } },
];

export const DRUM_PRESET_IDS = DRUM_PRESET_OVERRIDES.map((preset) => preset.presetId);
