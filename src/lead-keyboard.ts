export type LeadKeyMode = 'major' | 'minor';

export type LeadKeyboardKey = {
  midi: number;
  shortcut: string;
  position?: number;
};

export type LeadKeyboardLayout = {
  white: LeadKeyboardKey[];
  black: LeadKeyboardKey[];
  shortcuts: string[];
  midiByShortcut: Record<string, number>;
};

const whiteShortcuts = ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'];
const modes = {
  major: {
    whiteOffsets: [0, 2, 4, 5, 7, 9, 11, 12, 14, 16],
    blackOffsets: [1, 3, 6, 8, 10, 13, 15],
    blackPositions: [10, 20, 40, 50, 60, 80, 90],
    blackShortcuts: ['s', 'd', 'g', 'h', 'j', 'l', ';'],
  },
  minor: {
    whiteOffsets: [0, 2, 3, 5, 7, 8, 10, 12, 14, 15],
    blackOffsets: [1, 4, 6, 9, 11, 13],
    blackPositions: [10, 30, 40, 60, 70, 80],
    blackShortcuts: ['s', 'f', 'g', 'j', 'k', 'l'],
  },
} as const;

export const buildLeadKeyboardLayout = (root: number, mode: LeadKeyMode, baseMidi = 60): LeadKeyboardLayout => {
  const keyRoot = Number.isFinite(root) ? ((Math.round(root) % 12) + 12) % 12 : 0;
  const shape = modes[mode];
  const white = shape.whiteOffsets.map((offset, index) => ({ midi: baseMidi + keyRoot + offset, shortcut: whiteShortcuts[index] }));
  const black = shape.blackOffsets.map((offset, index) => ({ midi: baseMidi + keyRoot + offset, shortcut: shape.blackShortcuts[index], position: shape.blackPositions[index] }));
  const keys = [...white, ...black];
  return {
    white,
    black,
    shortcuts: keys.map((key) => key.shortcut),
    midiByShortcut: Object.fromEntries(keys.map((key) => [key.shortcut, key.midi])),
  };
};
