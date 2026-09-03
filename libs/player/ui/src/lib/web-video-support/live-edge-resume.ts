const LIVE_EDGE_SAFETY_SECONDS = 0.1;

/** Moves a media element to the current playable live edge. */
export function seekVideoToLiveEdge(
  video: HTMLMediaElement,
  preferredPosition?: number | null,
): boolean {
  let target =
    typeof preferredPosition === "number" &&
    Number.isFinite(preferredPosition) &&
    preferredPosition >= 0
      ? preferredPosition
      : null;

  if (target === null) {
    try {
      const ranges = video.seekable;
      if (ranges.length === 0) {
        return false;
      }
      const lastRange = ranges.length - 1;
      const start = ranges.start(lastRange);
      const end = ranges.end(lastRange);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
      }
      target = Math.max(start, end - LIVE_EDGE_SAFETY_SECONDS);
    } catch {
      return false;
    }
  }

  try {
    video.currentTime = target;
    return true;
  } catch {
    return false;
  }
}
