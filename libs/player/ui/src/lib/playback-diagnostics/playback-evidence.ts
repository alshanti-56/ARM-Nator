import type { PlayerMediaTelemetry } from "../player-controls/player-controls.model";
import { getPlaybackMediaExtensionFromUrl } from "@arm-nator/providers/shared/util";

export function readBrowserPlaybackEvidence(
  video?: HTMLVideoElement,
  presentedFramesOverride?: number,
): Pick<PlayerMediaTelemetry, "presentedFrames" | "audioOnly" | "muted"> {
  if (!video) {
    return {};
  }

  const evidence: {
    presentedFrames?: number;
    audioOnly?: boolean;
    muted?: boolean;
  } = {};
  const presentedFrames =
    isFrameCount(presentedFramesOverride) && presentedFramesOverride !== undefined
      ? presentedFramesOverride
      : readQualityFrameCount(video);
  if (presentedFrames !== undefined) {
    evidence.presentedFrames = presentedFrames;
  }

  if (video.readyState >= 2) {
    evidence.audioOnly = video.videoWidth === 0 && video.videoHeight === 0;
  }
  if (typeof video.muted === "boolean") {
    evidence.muted = video.muted;
  }

  return evidence;
}

const AUDIO_ONLY_EXTENSIONS = new Set([
  "aac",
  "flac",
  "m4a",
  "m4b",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  "wma",
]);

export function isKnownAudioOnlySourceUrl(sourceUrl: string): boolean {
  return AUDIO_ONLY_EXTENSIONS.has(
    getPlaybackMediaExtensionFromUrl(sourceUrl).toLowerCase(),
  );
}

function readQualityFrameCount(video: HTMLVideoElement): number | undefined {
  try {
    const quality = video.getVideoPlaybackQuality?.();
    const totalFrames = quality?.totalVideoFrames;
    if (!isFrameCount(totalFrames)) {
      return undefined;
    }
    const droppedFrames = quality?.droppedVideoFrames;
    return Math.max(0, totalFrames - (isFrameCount(droppedFrames) ? droppedFrames : 0));
  } catch {
    return undefined;
  }
}

function isFrameCount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
