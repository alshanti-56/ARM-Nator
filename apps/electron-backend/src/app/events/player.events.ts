import { ipcMain } from "electron";
import {
  CLOSE_EXTERNAL_PLAYER_SESSION,
  ExternalPlayerControlAction,
  PlaybackNetworkInspection,
  PlayerContentInfo,
} from "@arm-nator/shared/interfaces";
import {
  MPV_PLAYER_PATH,
  store,
  VLC_PLAYER_PATH,
} from "../services/store.service";
import { normalizePlayerPathForStore } from "./external-player-launch-context";
import {
  externalPlayerSessions,
  traceExternalPlayer,
} from "./external-player-runtime";
import {
  controlMpvSession,
  getMpvAvailability,
  openMpvPlayer,
  setMpvReuseInstance,
} from "./mpv-session.service";
import {
  controlVlcSession,
  getVlcAvailability,
  openVlcPlayer,
  setVlcReuseInstance,
} from "./vlc-session.service";

export {
  buildExternalPlayerSpawnSpec,
  buildPlayerArgsWithCustomArguments,
  isRunningInFlatpak,
  parseExternalPlayerArguments,
  resolveExternalPlayerLaunchContext,
  shouldReuseMpvInstance,
  shouldReuseVlcInstance,
  shouldUseMpvSocketBridge,
} from "./external-player-launch-context";
export {
  buildVlcEnqueueCommands,
  parseVlcRcNumericResponse,
  parseVlcRcPlaybackState,
} from "./vlc-session.service";

export default class PlayerEvents {
  static bootstrapPlayerEvents(): Electron.IpcMain {
    return ipcMain;
  }
}

const PLAYBACK_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

ipcMain.handle(
  "INSPECT_PLAYBACK_URL",
  async (
    _event,
    requestedUrl: string,
    requestHeaders: Record<string, string> = {},
  ): Promise<PlaybackNetworkInspection> => {
    const startedAt = performance.now();
    const redirectChain: PlaybackNetworkInspection["redirectChain"] = [];
    let currentUrl = requestedUrl;

    try {
      for (let redirectCount = 0; redirectCount <= 10; redirectCount++) {
        const response = await fetch(currentUrl, {
          method: "GET",
          headers: {
            Range: "bytes=0-65535",
            ...requestHeaders,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const location = response.headers.get("location") ?? undefined;
        redirectChain.push({
          url: currentUrl,
          status: response.status,
          location,
        });

        if (PLAYBACK_REDIRECT_STATUSES.has(response.status) && location) {
          await response.body?.cancel();
          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        const contentType = response.headers.get("content-type") ?? undefined;
        const contentLengthValue = response.headers.get("content-length");
        const contentLength = contentLengthValue
          ? Number(contentLengthValue)
          : undefined;
        const lowerUrl = currentUrl.toLowerCase().split("?")[0];
        const isHlsManifest =
          contentType?.includes("mpegurl") || lowerUrl.endsWith(".m3u8");
        let detectedLive: boolean | undefined;
        if (isHlsManifest) {
          const manifest = await response.text();
          detectedLive = !manifest.includes("#EXT-X-ENDLIST");
        } else {
          detectedLive =
            contentType?.startsWith("video/") &&
            Number.isFinite(contentLength) &&
            (contentLength ?? 0) > 0
              ? false
              : undefined;
          await response.body?.cancel();
        }
        return {
          requestedUrl,
          finalUrl: response.url || currentUrl,
          status: response.status,
          statusText: response.statusText,
          contentType,
          contentLength:
            Number.isFinite(contentLength) && contentLength! >= 0
              ? contentLength
              : undefined,
          headers,
          redirectChain,
          detectedLive,
          elapsedMs: performance.now() - startedAt,
        };
      }
      throw new Error("Too many redirects.");
    } catch (error) {
      return {
        requestedUrl,
        finalUrl: currentUrl,
        status: 0,
        statusText: "Network error",
        headers: {},
        redirectChain,
        elapsedMs: performance.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

ipcMain.handle("GET_PLAYER_ENGINE_AVAILABILITY", async () => [
  getMpvAvailability(),
  getVlcAvailability(),
]);

ipcMain.handle(
  "OPEN_MPV_PLAYER",
  async (
    _event,
    url: string,
    title: string,
    thumbnail?: string,
    userAgent?: string,
    referer?: string,
    origin?: string,
    contentInfo?: PlayerContentInfo,
    startTime?: number,
    headers?: Record<string, string>,
    subtitleUrl?: string,
  ) =>
    openMpvPlayer({
      url,
      title,
      thumbnail,
      userAgent,
      referer,
      origin,
      contentInfo,
      startTime,
      headers,
      subtitleUrl,
    }),
);

ipcMain.handle(
  "SET_MPV_PLAYER_PATH",
  (_event, mpvPlayerPath: string | null | undefined) => {
    const normalizedPlayerPath = normalizePlayerPathForStore(mpvPlayerPath);
    traceExternalPlayer("set mpv player path", {
      playerPath: normalizedPlayerPath,
    });
    store.set(MPV_PLAYER_PATH, normalizedPlayerPath);
  },
);

ipcMain.handle("SET_MPV_REUSE_INSTANCE", (_event, reuseInstance: boolean) => {
  setMpvReuseInstance(reuseInstance);
});

ipcMain.handle(
  "OPEN_VLC_PLAYER",
  async (
    _event,
    url: string,
    title: string,
    thumbnail?: string,
    userAgent?: string,
    referer?: string,
    origin?: string,
    contentInfo?: PlayerContentInfo,
    startTime?: number,
    headers?: Record<string, string>,
    subtitleUrl?: string,
  ) =>
    openVlcPlayer({
      url,
      title,
      thumbnail,
      userAgent,
      referer,
      origin,
      contentInfo,
      startTime,
      headers,
      subtitleUrl,
    }),
);

ipcMain.handle(
  "SET_VLC_PLAYER_PATH",
  (_event, vlcPlayerPath: string | null | undefined) => {
    const normalizedPlayerPath = normalizePlayerPathForStore(vlcPlayerPath);
    traceExternalPlayer("set vlc player path", {
      playerPath: normalizedPlayerPath,
    });
    store.set(VLC_PLAYER_PATH, normalizedPlayerPath);
  },
);

ipcMain.handle("SET_VLC_REUSE_INSTANCE", (_event, reuseInstance: boolean) => {
  setVlcReuseInstance(reuseInstance);
});

ipcMain.handle(
  CLOSE_EXTERNAL_PLAYER_SESSION,
  async (_event, sessionId: string) => {
    return externalPlayerSessions.closeSession(sessionId);
  },
);

ipcMain.handle(
  "CONTROL_EXTERNAL_PLAYER_SESSION",
  async (
    _event,
    sessionId: string,
    action: ExternalPlayerControlAction,
    value?: number,
  ) => {
    if (action === "stop") {
      return externalPlayerSessions.closeSession(sessionId);
    }
    const session = externalPlayerSessions.getSession(sessionId);
    return session?.player === "mpv"
      ? controlMpvSession(sessionId, action, value)
      : controlVlcSession(sessionId, action, value);
  },
);
