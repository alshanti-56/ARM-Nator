import type mpegts from "mpegts.js";
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
    liveBufferLatencyChasing: true,
    liveBufferLatencyMaxLatency: 20,
    liveBufferLatencyMinRemain: 8,
  };
}

export function isRecoverableMpegTsLiveFailure(
  type: string,
  details: string,
  info: unknown,
): boolean {
  const text = `${type} ${details} ${stringifyInfo(info)}`.toLowerCase();
  if (/\b(?:401|403|404)\b/.test(text)) {
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
