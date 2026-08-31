export type MetronomeSchedulePosition = { beat: number; nextBeat: number };

/** Drop beats that are already in the past instead of replaying a timer backlog. */
export const skipMissedMetronomeBeats = (
  position: MetronomeSchedulePosition,
  now: number,
  beatLength: number,
): MetronomeSchedulePosition => {
  if (!Number.isFinite(now) || !Number.isFinite(beatLength) || beatLength <= 0 || position.nextBeat >= now) return position;
  const skipped = Math.ceil((now - position.nextBeat) / beatLength);
  return {
    beat: position.beat + skipped,
    nextBeat: position.nextBeat + skipped * beatLength,
  };
};
