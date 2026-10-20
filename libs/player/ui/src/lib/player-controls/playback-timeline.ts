/** Converts between a companion segment's local media clock and source VOD time. */
export function toAbsolutePlaybackPosition(
  localPositionSeconds: number,
  timelineOffsetSeconds = 0,
): number {
  const local = Number.isFinite(localPositionSeconds)
    ? Math.max(0, localPositionSeconds)
    : 0;
  return local + normalizeOffset(timelineOffsetSeconds);
}

/** Converts an absolute source VOD seek into the companion segment's local clock. */
export function toLocalPlaybackPosition(
  absolutePositionSeconds: number,
  timelineOffsetSeconds = 0,
): number {
  const absolute = Number.isFinite(absolutePositionSeconds)
    ? Math.max(0, absolutePositionSeconds)
    : 0;
  return Math.max(0, absolute - normalizeOffset(timelineOffsetSeconds));
}

/** Prefer the original source duration; otherwise infer an end from the local segment. */
export function toAbsolutePlaybackDuration(
  localDurationSeconds: number | null | undefined,
  timelineOffsetSeconds = 0,
  reportedDurationSeconds: number | null | undefined = null,
): number | null {
  if (isPositiveFinite(reportedDurationSeconds)) return reportedDurationSeconds;
  return isPositiveFinite(localDurationSeconds)
    ? normalizeOffset(timelineOffsetSeconds) + localDurationSeconds : null;
}

function normalizeOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
