import type {
  EmbeddedMpvBounds,
  EmbeddedMpvSession,
} from "@arm-nator/shared/interfaces";
export function canRevealNativeFrame(input: {
  enabled: boolean;
  activeSessionId: string | null;
  snapshot: EmbeddedMpvSession | null;
  closing: boolean;
}): boolean {
  return (
    input.enabled &&
    !input.closing &&
    !!input.activeSessionId &&
    input.snapshot?.id === input.activeSessionId &&
    input.snapshot.frameReady === true &&
    ["loading", "playing", "paused", "ended"].includes(input.snapshot.status)
  );
}
export type NativeApertureRadius = number | { top: number; bottom: number };

/** Scene and native viewport use content-window CSS pixels, including during fullscreen. */
export function nativeSceneClip(
  b: EmbeddedMpvBounds,
  width: number,
  height: number,
  radius: NativeApertureRadius = 0,
): string {
  const top = typeof radius === 'number' ? radius : radius.top;
  const lower = typeof radius === 'number' ? radius : radius.bottom;
  if (
    ![b.x, b.y, b.width, b.height, width, height, top, lower].every(
      Number.isFinite,
    ) ||
    b.width <= 0 ||
    b.height <= 0 ||
    width <= 0 ||
    height <= 0
  )
    return "none";
  const x = Math.max(0, b.x),
    y = Math.max(0, b.y),
    right = Math.min(width, b.x + b.width),
    bottom = Math.min(height, b.y + b.height);
  if (right <= x || bottom <= y) return "none";
  const limit = Math.min((right - x) / 2, (bottom - y) / 2);
  const rt = Math.max(0, Math.min(top, limit));
  const rb = Math.max(0, Math.min(lower, limit));
  return `path(evenodd, "M0 0 H${width} V${height} H0 Z M${x + rt} ${y} H${right - rt} Q${right} ${y} ${right} ${y + rt} V${bottom - rb} Q${right} ${bottom} ${right - rb} ${bottom} H${x + rb} Q${x} ${bottom} ${x} ${bottom - rb} V${y + rt} Q${x} ${y} ${x + rt} ${y} Z")`;
}
