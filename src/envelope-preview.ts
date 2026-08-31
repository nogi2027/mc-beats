export type EnvelopePreviewValues = {
  attackMs: number;
  decayMs: number;
  sustainLevel: number;
  releaseMs: number;
};

export type EnvelopePreviewPoint = { x: number; y: number };
export type EnvelopePreviewRegion = { label: 'A' | 'D' | 'S' | 'R'; x: number; width: number };
export type EnvelopePreviewGeometry = {
  width: number;
  height: number;
  points: EnvelopePreviewPoint[];
  regions: EnvelopePreviewRegion[];
};

const finiteOr = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const nonnegative = (value: number) => Math.max(0, finiteOr(value, 0));
const bounded = (value: number, min: number, max: number) => Math.min(max, Math.max(min, finiteOr(value, min)));

/** Build a small, deterministic ADSR outline. Log-scaled time keeps a long
 * release visible without making the attack, decay, and sustain unreadable. */
export const envelopePreviewGeometry = (input: Partial<EnvelopePreviewValues>, width = 240, height = 72): EnvelopePreviewGeometry => {
  const safeWidth = Math.max(1, finiteOr(width, 240));
  const safeHeight = Math.max(1, finiteOr(height, 72));
  const attack = nonnegative(finiteOr(input.attackMs ?? 0, 0));
  const decay = nonnegative(finiteOr(input.decayMs ?? 0, 0));
  const sustain = bounded(finiteOr(input.sustainLevel ?? 0, 0), 0, 1);
  const release = nonnegative(finiteOr(input.releaseMs ?? 0, 0));
  const weight = (milliseconds: number) => Math.log1p(milliseconds / 40) + .25;
  const attackWeight = weight(attack);
  const decayWeight = weight(decay);
  const sustainWeight = Math.max(.6, weight(Math.max(attack, decay) * 1.4));
  const releaseWeight = weight(release);
  const total = attackWeight + decayWeight + sustainWeight + releaseWeight;
  const xAt = (position: number) => Math.min(safeWidth, Math.max(0, position / total * safeWidth));
  const attackX = xAt(attackWeight);
  const decayX = xAt(attackWeight + decayWeight);
  const sustainX = xAt(attackWeight + decayWeight + sustainWeight);
  const yAt = (level: number) => Math.min(safeHeight, Math.max(0, safeHeight - bounded(level, 0, 1) * safeHeight));
  const points = [
    { x: 0, y: safeHeight },
    { x: attackX, y: yAt(1) },
    { x: decayX, y: yAt(sustain) },
    { x: sustainX, y: yAt(sustain) },
    { x: safeWidth, y: safeHeight },
  ];
  const regions = [
    { label: 'A' as const, x: 0, width: attackX },
    { label: 'D' as const, x: attackX, width: Math.max(0, decayX - attackX) },
    { label: 'S' as const, x: decayX, width: Math.max(0, sustainX - decayX) },
    { label: 'R' as const, x: sustainX, width: Math.max(0, safeWidth - sustainX) },
  ];
  return { width: safeWidth, height: safeHeight, points, regions };
};

export const envelopePath = (geometry: EnvelopePreviewGeometry) => geometry.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`).join(' ');
