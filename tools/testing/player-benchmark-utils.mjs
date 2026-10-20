import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { extname, join, resolve } from "node:path";

/** Return a nearest-rank percentile from finite measurement samples. */
export function empiricalPercentile(values, percentile) {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new RangeError("Percentile must be between 0 and 1");
  }
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

export function resolveNativeReleaseDir(root, env = process.env) {
  return resolve(
    env.ARM_NATOR_NATIVE_DIR ?? join(root, "apps/electron-backend/native/build/Release"),
  );
}

export function resolveFfmpegPath(env = process.env) {
  return env.ARM_NATOR_FFMPEG ?? "ffmpeg";
}

/** Copy a local media fixture to a per-run path and return its cleanup hook. */
export function createIsolatedFixture(sourcePath, directory, label = "fixture") {
  mkdirSync(directory, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9-]/gi, "-");
  const isolatedPath = join(
    directory,
    `${safeLabel}-${process.pid}-${randomUUID()}${extname(sourcePath)}`,
  );
  copyFileSync(sourcePath, isolatedPath);
  return {
    path: isolatedPath,
    cleanup() {
      try {
        unlinkSync(isolatedPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

export function isSettledBackwardSeek(
  first,
  second,
  target,
  preSeekPosition,
  requiredDiscontinuitySeconds,
) {
  const firstPosition = Number(first?.positionSeconds);
  const secondPosition = Number(second?.positionSeconds);
  const observedDiscontinuity =
    preSeekPosition - Math.min(firstPosition, secondPosition);
  const closestTargetDistance = Math.min(
    Math.abs(firstPosition - target),
    Math.abs(secondPosition - target),
  );
  return {
    accepted:
      (first?.state ?? first?.status) === "playing" &&
      (second?.state ?? second?.status) === "playing" &&
      Number.isFinite(firstPosition) &&
      Number.isFinite(secondPosition) &&
      secondPosition > firstPosition + 0.05 &&
      closestTargetDistance < 1 &&
      observedDiscontinuity >= requiredDiscontinuitySeconds,
    observedDiscontinuity,
  };
}

export function isConfirmedStartup(snapshot, { audioOnly = false } = {}) {
  if (
    !["playing"].includes(snapshot?.state ?? snapshot?.status) ||
    !Number.isFinite(snapshot?.durationSeconds) ||
    snapshot.durationSeconds <= 0 ||
    !Number.isFinite(snapshot?.positionSeconds) ||
    snapshot.positionSeconds <= 0.05
  ) {
    return false;
  }
  if (audioOnly) {
    return (snapshot.audioTracks ?? []).some(
      (track) =>
        track.selected === true &&
        (snapshot.selectedAudioTrackId == null ||
          snapshot.selectedAudioTrackId === track.id),
    );
  }
  return (
    (snapshot.resolution?.width > 0 && snapshot.resolution?.height > 0) ||
    (snapshot.videoWidth > 0 && snapshot.videoHeight > 0)
  );
}
