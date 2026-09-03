import type { Instrument } from './synth/contract.ts';

export const MUSIC_PRESETS: Record<Instrument, readonly string[]> = {
  drums: ['Clean', 'Classic', 'Soft', 'Tight', 'Industrial', 'Lo-fi', '808', 'Circuit', 'Glitch'],
  bass: ['Sub', 'Rubber', 'Acid', 'Pluck', 'Pulse', 'Distorted'],
  chords: ['Warm Pad', 'Soft Keys', 'Glass FM', 'Organ', 'Pluck', 'Wide Saw'],
  lead: ['Bright Mono', 'Soft Sine', 'Pulse Lead', 'FM Bell', 'Distorted', 'Airy', 'Strings'],
  metronome: ['Classic Click', 'Bright Click', 'Soft Tick', 'Wood Block', 'Digital', 'Low Tick'],
};

export const NOTE_NAMES = ['C', 'C#', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'A♭', 'A', 'B♭', 'B'] as const;

export const SCALE_INTERVALS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
} as const;
