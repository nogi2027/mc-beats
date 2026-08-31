import { DECK_TICKS, PPQ, safeTempo } from './deck.ts';

export const PLATTER_COAST_MS = 350;

export const wrapPlatterTick = (tick: number) => ((tick % DECK_TICKS) + DECK_TICKS) % DECK_TICKS;

export const platterAngleDegrees = (tick: number) => {
  const wrapped = wrapPlatterTick(tick);
  return wrapped === 0 ? 0 : -wrapped / DECK_TICKS * 360;
};

export const shortestPlatterOffset = (displayTick: number, transportTick: number) => {
  const difference = wrapPlatterTick(displayTick - transportTick);
  return difference > DECK_TICKS / 2 ? difference - DECK_TICKS : difference;
};

export const platterCoastTicks = (elapsedMs: number, tempo: number, durationMs = PLATTER_COAST_MS) => {
  const progress = Math.max(0, Math.min(1, elapsedMs / Math.max(1, durationMs)));
  const ticksPerMs = PPQ * safeTempo(tempo) / 60_000;
  return ticksPerMs * durationMs * (progress - progress * progress / 2);
};

export const platterResumeOffset = (resumeOffset: number, elapsedMs: number, coastElapsedMs: number, tempo: number, coastDurationMs = PLATTER_COAST_MS) => {
  if (resumeOffset <= 0) return 0;
  const coastProgress = Math.max(0, Math.min(1, coastElapsedMs / Math.max(1, coastDurationMs)));
  const ticksPerMs = PPQ * safeTempo(tempo) / 60_000;
  const speedDeficit = ticksPerMs * coastProgress;
  if (speedDeficit <= 0) return 0;
  const durationMs = Math.max(1, 2 * resumeOffset / speedDeficit);
  const elapsed = Math.max(0, Math.min(durationMs, elapsedMs));
  return Math.max(0, resumeOffset - speedDeficit * (elapsed - elapsed * elapsed / (2 * durationMs)));
};
