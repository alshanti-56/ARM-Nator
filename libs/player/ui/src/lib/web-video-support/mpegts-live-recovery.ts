import type mpegts from "mpegts.js";
import { extractHttpStatusCode } from "../playback-diagnostics/playback-error-patterns.util";
export {
  LivePlaybackRecovery as MpegTsLiveRecovery,
  type LiveRecoveryScheduled as MpegTsRecoveryScheduled,
} from "./live-playback-recovery";

export function createMpegTsConfig(isLive: boolean): mpegts.Config {
  if (!isLive) {
    return {
      lazyLoad: true,
      reuseRedirectedURL: true,
      accurateSeek: true,
    };
  }

  return {
    isLive: true,
    enableStashBuffer: true,
    lazyLoad: false,
    reuseRedirectedURL: true,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: 120,
    autoCleanupMinBackwardDuration: 30,
    fixAudioTimestampGap: true,
    // The Electron relay already paces corrected PCR in real time. Letting
    // mpegts.js chase latency as well makes playback audibly/video-visibly
    // accelerate while consuming the deliberate startup safety buffer.
    liveBufferLatencyChasing: false,
  };
}

export function isRecoverableMpegTsLiveFailure(
  type: string,
  details: string,
  info: unknown,
): boolean {
  const text = `${type} ${details} ${stringifyInfo(info)}`.toLowerCase();
  const status = extractHttpStatusCode(type, details, info);
  if (
    status !== null &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425 &&
    status !== 429
  ) {
    return false;
  }

  return [
    "httpstatuscodeinvalid",
    "networkstatuscodeinvalid",
    "earlyeof",
    "early eof",
    "networkexception",
    "networktimeout",
    "connection reset",
    "connection closed",
    "socket closed",
    "failed to fetch",
  ].some((marker) => text.includes(marker));
}

function stringifyInfo(info: unknown): string {
  if (typeof info === "string") {
    return info;
  }
  try {
    return JSON.stringify(info) ?? "";
  } catch {
    return String(info ?? "");
  }
}
