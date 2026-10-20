import type { SeekPreviewCue } from "@arm-nator/shared/interfaces";
// Frames already decoded by the active web player only. No seek or second video.
const frames = new Map<string, SeekPreviewCue>();
let retainedBytes = 0;
const MAX_BYTES = 2 * 1024 * 1024;
export function rememberSeekFrame(
  key: string,
  seconds: number,
  url: string,
): void {
  const bucket = Math.floor(seconds / 30),
    id = JSON.stringify([key, bucket]);
  if (
    !key ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !url.startsWith("data:image/jpeg;base64,") ||
    url.length * 2 > MAX_BYTES
  )
    return;
  const old = frames.get(id);
  if (old) retainedBytes -= old.url.length * 2;
  frames.delete(id);
  frames.set(id, { start: bucket * 30, end: (bucket + 1) * 30, url });
  retainedBytes += url.length * 2;
  while (frames.size > 120 || retainedBytes > MAX_BYTES) {
    const first = frames.keys().next().value;
    if (first === undefined) break;
    retainedBytes -= frames.get(first)!.url.length * 2;
    frames.delete(first);
  }
}
export function cachedSeekFrame(
  key: string,
  seconds: number,
): SeekPreviewCue | null {
  return frames.get(JSON.stringify([key, Math.floor(seconds / 30)])) ?? null;
}
