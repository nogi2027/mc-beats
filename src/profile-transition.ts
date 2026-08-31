import type { DeckSoundProfile } from './deck.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const interpolateValue = (source: unknown, target: unknown, progress: number): unknown => {
  if (typeof source === 'number' && typeof target === 'number' && Number.isFinite(source) && Number.isFinite(target)) return source + (target - source) * progress;
  if (Array.isArray(source) && Array.isArray(target)) return target.map((value, index) => interpolateValue(source[index], value, progress));
  if (source && target && typeof source === 'object' && typeof target === 'object') {
    const result: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(source as Record<string, unknown>), ...Object.keys(target as Record<string, unknown>)]);
    keys.forEach((key) => {
      const left = (source as Record<string, unknown>)[key];
      const right = (target as Record<string, unknown>)[key];
      result[key] = left === undefined ? clone(right) : right === undefined ? clone(left) : interpolateValue(left, right, progress);
    });
    return result;
  }
  return clone(progress < .5 ? source ?? target : target ?? source);
};

export const interpolateDeckProfile = (source: DeckSoundProfile, target: DeckSoundProfile, progress: number): DeckSoundProfile => {
  const safeProgress = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  return interpolateValue(source, target, safeProgress) as DeckSoundProfile;
};

export const profileTransitionProgress = (absoluteTick: number, startAbsoluteTick: number, endAbsoluteTick: number) => {
  if (endAbsoluteTick <= startAbsoluteTick) return 1;
  return Math.max(0, Math.min(1, (absoluteTick - startAbsoluteTick) / (endAbsoluteTick - startAbsoluteTick)));
};

export const profileAtTransitionTick = (source: DeckSoundProfile, target: DeckSoundProfile, startAbsoluteTick: number, endAbsoluteTick: number, absoluteTick: number) => interpolateDeckProfile(source, target, profileTransitionProgress(absoluteTick, startAbsoluteTick, endAbsoluteTick));
