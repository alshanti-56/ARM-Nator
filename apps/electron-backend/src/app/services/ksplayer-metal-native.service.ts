import { powerSaveBlocker, app } from "electron";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "module";
import path from "path";
import App from "../app";
import { playbackDiagnostics } from "./playback-diagnostics.service";
import { nativeProgressivePlaybackUrl } from "./progressive-response-recovery";
import {
  EmbeddedMpvAudioTrack,
  EmbeddedMpvBounds,
  EmbeddedMpvSession,
  EmbeddedMpvSessionStatus,
  EmbeddedMpvSubtitleTrack,
  KsPlayerMetalControls,
  KsPlayerMetalSession,
  KsPlayerMetalSupport,
  KSPLAYER_METAL_SESSION_UPDATE,
  PlayerSubtitleSettings,
  PlayerPictureSettings,
} from "@arm-nator/shared/interfaces";
import { toNativeViewBounds } from "./embedded-mpv-bounds.util";
import {
  EMPTY_KSPLAYER_METAL_CONTROLS,
  normalizeKsPlayerMetalControls,
} from "./ksplayer-metal-controls";

const BACKEND = "ksplayer-metal" as const;
const POLL_INTERVAL_MS = 500;

const DEFAULT_PICTURE = {
  brightness: 0,
  contrast: 0,
  blackLevel: 0,
  saturation: 0,
  gamma: 0,
} as const;

const DEFAULT_CONTROLS = EMPTY_KSPLAYER_METAL_CONTROLS;

export interface NativeKsPlayerMetalSessionSnapshot extends Partial<EmbeddedMpvSession> {
  backend: "ksplayer-metal";
  status?: EmbeddedMpvSessionStatus;
  state?: string;
  paused?: boolean;
  resolution?: {
    width?: number;
    height?: number;
  } | null;
  message?: string;
  embedding?: NativeKsPlayerMetalLiveEmbeddingDiagnostic | null;
}

interface NativeKsPlayerMetalOperationResult {
  ok?: boolean;
  reason?: string;
  message?: string;
}

/**
 * Additive build-smoke result for the native frame-layout path. It is never
 * invoked by normal playback; the optional addon method keeps older v1
 * runtimes loadable while a freshly built runtime can prove embedding safety.
 */
export interface NativeKsPlayerMetalEmbeddingDiagnostic {
  ok: boolean;
  reason?: string;
  initialFrame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  updatedFrame: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  childCountAfterAttach: number;
  childCountAfterDispose: number;
}

export interface NativeKsPlayerMetalFrameSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeKsPlayerMetalViewIdentity {
  className: string;
  role: string;
}

export interface NativeKsPlayerMetalViewSnapshot {
  className: string;
  frame: NativeKsPlayerMetalFrameSnapshot;
  bounds: NativeKsPlayerMetalFrameSnapshot;
  isFlipped: boolean;
  isHidden: boolean;
  childCount: number;
  superview?: NativeKsPlayerMetalViewIdentity | null;
}

export interface NativeKsPlayerMetalLayerSnapshot {
  className: string;
  frame: NativeKsPlayerMetalFrameSnapshot;
  bounds: NativeKsPlayerMetalFrameSnapshot;
  drawableSize: {
    width: number;
    height: number;
  };
  isHidden: boolean;
  contentsScale: number;
}

/**
 * Geometry-only live evidence for an Electron-hosted KSPlayer view. This is
 * intentionally additive and excludes URL/header data even though normal
 * playback snapshots retain their established streamUrl compatibility field.
 */
export interface NativeKsPlayerMetalLiveEmbeddingDiagnostic {
  available: boolean;
  ok: boolean;
  sessionId?: string | null;
  phase: string;
  requestedBounds?: NativeKsPlayerMetalFrameSnapshot | null;
  host?: NativeKsPlayerMetalViewSnapshot | null;
  container?: NativeKsPlayerMetalViewSnapshot | null;
  playerView?: NativeKsPlayerMetalViewSnapshot | null;
  metalPlayView?: NativeKsPlayerMetalViewSnapshot | null;
  metalLayer?: NativeKsPlayerMetalLayerSnapshot | null;
  childCounts: {
    hostBeforeAttach?: number | null;
    hostAfterAttach?: number | null;
    containerBeforePlayerAttach?: number | null;
    containerAfterPlayerAttach?: number | null;
    containerAfterPlayerDispose?: number | null;
    hostAfterDispose?: number | null;
  };
  reason?: string | null;
}

export interface NativeKsPlayerMetalAddon {
  getSupport(): KsPlayerMetalSupport;
  prepare(): KsPlayerMetalSupport | NativeKsPlayerMetalOperationResult | void;
  diagnoseEmbedding?():
    NativeKsPlayerMetalEmbeddingDiagnostic | NativeKsPlayerMetalOperationResult;
  getEmbeddingDiagnostic?(
    sessionId?: string,
  ):
    | NativeKsPlayerMetalLiveEmbeddingDiagnostic
    | NativeKsPlayerMetalOperationResult;
  createSession(
    sessionId: string,
    nativeHandle: Buffer,
    bounds: EmbeddedMpvBounds,
  ): unknown;
  load(
    sessionId: string,
    url: string,
    headers: Record<string, string>,
  ): unknown;
  setBounds(sessionId: string, bounds: EmbeddedMpvBounds): unknown;
  setPaused(sessionId: string, paused: boolean): unknown;
  seek(sessionId: string, seconds: number): unknown;
  setVolume(sessionId: string, volume: number): unknown;
  setAudioTrack(sessionId: string, trackId: number): unknown;
  setSubtitleTrack(sessionId: string, trackId: number): unknown;
  setSubtitleFile(sessionId: string, filePath: string): unknown;
  setSubtitleSettings(sessionId: string, settingsJSON: string): unknown;
  setPlaybackSpeed(sessionId: string, speed: number): unknown;
  setDisplayMode(sessionId: string, mode: string): unknown;
  setAspect?(sessionId: string, aspect: string): unknown;
  setPicture?(sessionId: string, pictureJSON: string): unknown;
  getSupportedControls(sessionId?: string): KsPlayerMetalControls;
  getSnapshot(sessionId: string): NativeKsPlayerMetalSessionSnapshot | null;
  disposeSession(sessionId: string): unknown;
  disposeAll(): unknown;
}

interface KsPlayerMetalRuntimeSession {
  id: string;
  title: string;
  streamUrl: string;
  volume: number;
  startedAt: string;
  updatedAt: string;
  lastPayloadKey: string;
  lastStatus: EmbeddedMpvSessionStatus | null;
}

interface RendererLifecycleWatch {
  window: Electron.BrowserWindow;
  webContents: Electron.WebContents;
  onRenderProcessGone: (
    event: Electron.Event,
    details: Electron.RenderProcessGoneDetails,
  ) => void;
  onDidNavigate: () => void;
  onWebContentsDestroyed: () => void;
  onWindowClosed: () => void;
}

function dedupe(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function getResourcesPath(): string | undefined {
  return (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
}

/**
 * Resolve development, compiled-output, and packaged locations used by the
 * native lane. This list deliberately contains only ksplayer_metal.node.
 */
export function getKsPlayerMetalAddonCandidatePaths(): string[] {
  const resourcesPath = getResourcesPath();
  const appPath = app.getAppPath?.();
  const packaged = [
    resourcesPath
      ? path.resolve(
          resourcesPath,
          "app.asar.unpacked",
          "electron-backend",
          "native",
          "ksplayer_metal.node",
        )
      : undefined,
    resourcesPath
      ? path.resolve(
          resourcesPath,
          "app.asar.unpacked",
          "native",
          "ksplayer_metal.node",
        )
      : undefined,
    appPath
      ? path.resolve(
          path.dirname(appPath),
          "app.asar.unpacked",
          "electron-backend",
          "native",
          "ksplayer_metal.node",
        )
      : undefined,
    appPath
      ? path.resolve(
          path.dirname(appPath),
          "app.asar.unpacked",
          "native",
          "ksplayer_metal.node",
        )
      : undefined,
  ];

  const development = [
    path.resolve(
      process.cwd(),
      "apps/electron-backend/native/build/Release/ksplayer_metal.node",
    ),
    path.resolve(__dirname, "native/ksplayer_metal.node"),
    path.resolve(__dirname, "../../native/ksplayer_metal.node"),
  ];

  return app.isPackaged
    ? dedupe(packaged.filter(Boolean) as string[])
    : dedupe([...development, ...(packaged.filter(Boolean) as string[])]);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasOwnHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
}

function normalizeSupport(
  value: unknown,
  runtimePath?: string,
): KsPlayerMetalSupport {
  const support = value as Partial<KsPlayerMetalSupport> | null;
  return {
    supported: support?.supported === true,
    ...(typeof support?.reason === "string" ? { reason: support.reason } : {}),
    ...(typeof support?.architecture === "string"
      ? { architecture: support.architecture }
      : {}),
    ...(typeof support?.runtimePath === "string"
      ? { runtimePath: support.runtimePath }
      : runtimePath
        ? { runtimePath }
        : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLiveEmbeddingDiagnostic(
  value: unknown,
): value is NativeKsPlayerMetalLiveEmbeddingDiagnostic {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    typeof value.ok === "boolean" &&
    typeof value.phase === "string" &&
    isRecord(value.childCounts)
  );
}

function nativeOperationFailureReason(
  value: NativeKsPlayerMetalOperationResult,
  operation: string,
): string {
  return (
    (typeof value.reason === "string" && value.reason) ||
    (typeof value.message === "string" && value.message) ||
    `KSPlayer Metal ${operation} failed.`
  );
}

function assertNativeOperation(value: unknown, operation: string): void {
  if (!isRecord(value) || value.ok !== false) {
    return;
  }
  throw new Error(
    nativeOperationFailureReason(
      value as NativeKsPlayerMetalOperationResult,
      operation,
    ),
  );
}

function normalizePicture(value: unknown): PlayerPictureSettings {
  const picture = isRecord(value) ? value : {};
  const numberOrDefault = (key: keyof PlayerPictureSettings): number =>
    typeof picture[key] === "number" && Number.isFinite(picture[key])
      ? picture[key]
      : DEFAULT_PICTURE[key];
  return {
    brightness: numberOrDefault("brightness"),
    contrast: numberOrDefault("contrast"),
    blackLevel: numberOrDefault("blackLevel"),
    saturation: numberOrDefault("saturation"),
    gamma: numberOrDefault("gamma"),
  };
}

function isValidPicture(picture: PlayerPictureSettings): boolean {
  return (
    Object.keys(DEFAULT_PICTURE) as Array<keyof PlayerPictureSettings>
  ).every((key) => {
    const value = picture[key];
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= -100 &&
      value <= 100
    );
  });
}

const KSPLAYER_ASPECT_PRESETS = new Set([
  "no",
  "16:9",
  "4:3",
  "21:9",
  "2.35:1",
]);

function isValidAspectOverride(aspect: string): boolean {
  return KSPLAYER_ASPECT_PRESETS.has(aspect);
}

function normalizeStatus(
  value: unknown,
  paused?: unknown,
): EmbeddedMpvSessionStatus {
  if (value === "disposed") {
    return "closed";
  }
  const statuses: EmbeddedMpvSessionStatus[] = [
    "idle",
    "loading",
    "playing",
    "paused",
    "ended",
    "error",
    "closed",
  ];
  return statuses.includes(value as EmbeddedMpvSessionStatus)
    ? (value as EmbeddedMpvSessionStatus)
    : paused === true
      ? "paused"
      : "idle";
}

function normalizeTracks<
  T extends EmbeddedMpvAudioTrack | EmbeddedMpvSubtitleTrack,
>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export class KsPlayerMetalNativeService {
  private addon: NativeKsPlayerMetalAddon | null = null;
  private addonPath: string | null = null;
  private addonLoadError: Error | null = null;
  private readonly sessions = new Map<string, KsPlayerMetalRuntimeSession>();
  private pollingTimer: NodeJS.Timeout | null = null;
  private readonly pollFailuresLogged = new Set<string>();
  private powerBlockerId: number | null = null;
  private rendererLifecycleWatch: RendererLifecycleWatch | null = null;
  private nextSessionId = 1;
  private readonly loadAddonModule = createRequire(__filename);

  getSupport(): KsPlayerMetalSupport {
    const candidatePaths = getKsPlayerMetalAddonCandidatePaths();
    const runtimePath = this.addonPath
      ? this.addonPath
      : candidatePaths.find((candidatePath) => existsSync(candidatePath));

    if (process.platform !== "darwin") {
      return {
        supported: false,
        architecture: process.arch,
        ...(runtimePath ? { runtimePath } : {}),
        reason: "KSPlayer Metal requires macOS.",
      };
    }

    if (process.arch !== "arm64") {
      return {
        supported: false,
        architecture: process.arch,
        ...(runtimePath ? { runtimePath } : {}),
        reason: "KSPlayer Metal requires Apple Silicon (arm64).",
      };
    }

    if (this.addonLoadError) {
      return {
        supported: false,
        architecture: process.arch,
        ...(runtimePath ? { runtimePath } : {}),
        reason: this.addonLoadError.message,
      };
    }

    if (!this.addon && !runtimePath) {
      return {
        supported: false,
        architecture: process.arch,
        reason:
          this.readUnavailableReason(candidatePaths) ??
          [
            "Unable to locate the KSPlayer Metal native addon.",
            ...candidatePaths.map((candidatePath) => `- ${candidatePath}`),
          ].join("\n"),
      };
    }

    try {
      const addon = this.getAddon();
      return normalizeSupport(addon.getSupport(), runtimePath);
    } catch (error) {
      return {
        supported: false,
        architecture: process.arch,
        ...(runtimePath ? { runtimePath } : {}),
        reason: stringifyError(error),
      };
    }
  }

  prepare(): KsPlayerMetalSupport {
    const current = this.getSupport();
    if (!current.supported) {
      return current;
    }

    try {
      const addon = this.getAddon();
      const prepared = addon.prepare();
      if (isRecord(prepared) && typeof prepared.supported === "boolean") {
        return normalizeSupport(prepared, current.runtimePath);
      }
      if (isRecord(prepared) && prepared.ok === false) {
        return {
          ...current,
          supported: false,
          reason: nativeOperationFailureReason(
            prepared as NativeKsPlayerMetalOperationResult,
            "prepare",
          ),
        };
      }
      return normalizeSupport(addon.getSupport(), current.runtimePath);
    } catch (error) {
      return {
        ...current,
        supported: false,
        reason: stringifyError(error),
      };
    }
  }

  /**
   * Returns the native view-tree evidence for an active session, or the most
   * recent disposal evidence when that session has already been closed.
   * This is intentionally main-process-only diagnostic data; no renderer
   * bridge is added and no playback URL or request headers are included.
   */
  getEmbeddingDiagnostic(
    sessionId?: string,
  ): NativeKsPlayerMetalLiveEmbeddingDiagnostic {
    const addon = this.getAddon();
    if (typeof addon.getEmbeddingDiagnostic !== "function") {
      throw new Error(
        "KSPlayer Metal addon does not expose the live embedding diagnostic. Rebuild the native runtime.",
      );
    }

    const diagnostic = addon.getEmbeddingDiagnostic(sessionId);
    if (!isLiveEmbeddingDiagnostic(diagnostic)) {
      assertNativeOperation(diagnostic, "getEmbeddingDiagnostic");
      throw new Error(
        "KSPlayer Metal runtime returned malformed live embedding diagnostic data.",
      );
    }
    return diagnostic;
  }

  createSession(
    bounds: EmbeddedMpvBounds,
    title = "",
    initialVolume = 1,
  ): EmbeddedMpvSession {
    const support = this.prepare();
    if (!support.supported) {
      throw new Error(support.reason ?? "KSPlayer Metal is not supported.");
    }

    this.ensureRendererLifecycleWatch();
    const addon = this.getAddon();
    const sessionId = `ksplayer-metal-${Date.now()}-${this.nextSessionId++}`;
    const startedAt = new Date().toISOString();
    assertNativeOperation(
      addon.createSession(
        sessionId,
        this.getMainWindowHandle(),
        this.scaleBoundsForNativeView(bounds),
      ),
      "createSession",
    );
    this.sessions.set(sessionId, {
      id: sessionId,
      title,
      streamUrl: "",
      volume: initialVolume,
      startedAt,
      updatedAt: startedAt,
      lastPayloadKey: "",
      lastStatus: null,
    });

    // The native contract has no create-time volume argument. Apply the
    // requested initial value without making a successful creation fail
    // when an addon build reports volume as unavailable.
    try {
      const controls = normalizeKsPlayerMetalControls(
        addon.getSupportedControls(sessionId),
        typeof addon.setPicture === "function",
        typeof addon.setAspect === "function",
      );
      if (controls.volume) {
        assertNativeOperation(
          addon.setVolume(sessionId, initialVolume),
          "setVolume",
        );
      }
    } catch (error) {
      console.warn("[KSPlayer Metal] Initial volume was not applied:", error);
    }

    this.ensurePolling();
    return (
      this.refreshSession(sessionId) ??
      this.createPlaceholderSession(sessionId, title, startedAt, initialVolume)
    );
  }

  loadPlayback(
    sessionId: string,
    playback: {
      streamUrl: string;
      title?: string;
      headers?: Record<string, string>;
      userAgent?: string;
      referer?: string;
      origin?: string;
      subtitleUrl?: string;
    },
  ): void {
    const session = this.getRuntimeSession(sessionId);
    const headers: Record<string, string> = { ...(playback.headers ?? {}) };
    if (playback.userAgent && !hasOwnHeader(headers, "User-Agent")) {
      headers["User-Agent"] = playback.userAgent;
    }
    if (playback.referer && !hasOwnHeader(headers, "Referer")) {
      headers.Referer = playback.referer;
    }
    if (playback.origin && !hasOwnHeader(headers, "Origin")) {
      headers.Origin = playback.origin;
    }

    session.title = playback.title ?? session.title;
    session.streamUrl = playback.streamUrl;
    session.updatedAt = new Date().toISOString();
    playbackDiagnostics.record({ event: "native-load", transport: BACKEND, sessionId, sourceUrl: playback.streamUrl, requestHeaders: headers, activeSessions: this.sessions.size });
    try {
      assertNativeOperation(
        this.getAddon().load(sessionId, nativeProgressivePlaybackUrl(playback.streamUrl), headers),
        "load",
      );
    } catch (error) {
      playbackDiagnostics.record({ event: "native-error", transport: BACKEND, sessionId, sourceUrl: playback.streamUrl, error });
      throw error;
    }
    if (playback.subtitleUrl) {
      assertNativeOperation(
        this.getAddon().setSubtitleFile(sessionId, playback.subtitleUrl),
        "setSubtitleFile",
      );
    }
    this.refreshSession(sessionId);
  }

  setBounds(sessionId: string, bounds: EmbeddedMpvBounds): void {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setBounds(
        sessionId,
        this.scaleBoundsForNativeView(bounds),
      ),
      "setBounds",
    );
  }

  setPaused(sessionId: string, paused: boolean): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setPaused(sessionId, paused),
      "setPaused",
    );
    return this.refreshSession(sessionId);
  }

  seek(sessionId: string, seconds: number): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(this.getAddon().seek(sessionId, seconds), "seek");
    return this.refreshSession(sessionId);
  }

  setVolume(sessionId: string, volume: number): EmbeddedMpvSession | null {
    const session = this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setVolume(sessionId, volume),
      "setVolume",
    );
    session.volume = volume;
    return this.refreshSession(sessionId);
  }

  setSpeed(sessionId: string, speed: number): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setPlaybackSpeed(sessionId, speed),
      "setPlaybackSpeed",
    );
    return this.refreshSession(sessionId);
  }

  setDisplayMode(sessionId: string, mode: string): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setDisplayMode(sessionId, mode),
      "setDisplayMode",
    );
    return this.refreshSession(sessionId);
  }

  setAspect(sessionId: string, aspect: string): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    const addon = this.getAddon();
    if (typeof addon.setAspect !== "function") {
      throw new Error(
        "KSPlayer Metal aspect override requires a rebuilt native runtime.",
      );
    }
    if (!isValidAspectOverride(aspect)) {
      throw new Error("Unsupported KSPlayer Metal aspect override.");
    }
    assertNativeOperation(addon.setAspect(sessionId, aspect), "setAspect");
    return this.refreshSession(sessionId);
  }

  setPicture(
    sessionId: string,
    picture: PlayerPictureSettings,
  ): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    const addon = this.getAddon();
    if (typeof addon.setPicture !== "function") {
      throw new Error(
        "KSPlayer Metal picture adjustments require a rebuilt native runtime.",
      );
    }
    if (!isValidPicture(picture)) {
      throw new Error(
        "Picture settings must be finite values between -100 and 100.",
      );
    }
    const normalized = normalizePicture(picture);
    assertNativeOperation(
      addon.setPicture(sessionId, JSON.stringify(normalized)),
      "setPicture",
    );
    return this.refreshSession(sessionId);
  }

  setAudioTrack(sessionId: string, trackId: number): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setAudioTrack(sessionId, trackId),
      "setAudioTrack",
    );
    return this.refreshSession(sessionId);
  }

  setSubtitleTrack(
    sessionId: string,
    trackId: number,
  ): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setSubtitleTrack(sessionId, trackId),
      "setSubtitleTrack",
    );
    return this.refreshSession(sessionId);
  }

  setSubtitleFile(
    sessionId: string,
    filePath: string,
  ): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setSubtitleFile(sessionId, filePath),
      "setSubtitleFile",
    );
    return this.refreshSession(sessionId);
  }

  setSubtitleSettings(
    sessionId: string,
    settings: PlayerSubtitleSettings,
  ): EmbeddedMpvSession | null {
    this.getRuntimeSession(sessionId);
    assertNativeOperation(
      this.getAddon().setSubtitleSettings(sessionId, JSON.stringify(settings)),
      "setSubtitleSettings",
    );
    return this.refreshSession(sessionId);
  }

  getSupportedControls(sessionId?: string): KsPlayerMetalControls {
    try {
      const addon = this.getAddon();
      return normalizeKsPlayerMetalControls(
        addon.getSupportedControls(sessionId),
        typeof addon.setPicture === "function",
        typeof addon.setAspect === "function",
      );
    } catch (error) {
      console.warn("[KSPlayer Metal] Supported-controls query failed:", error);
      return { ...DEFAULT_CONTROLS };
    }
  }

  disposeSession(sessionId: string): EmbeddedMpvSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    try {
      assertNativeOperation(
        this.getAddon().disposeSession(sessionId),
        "disposeSession",
      );
    } catch (error) {
      console.warn("[KSPlayer Metal] disposeSession failed:", error);
      throw error;
    }

    this.sessions.delete(sessionId);
    playbackDiagnostics.record({ event: "native-release", transport: BACKEND, sessionId, sourceUrl: session.streamUrl, activeSessions: this.sessions.size });
    this.pollFailuresLogged.delete(sessionId);
    const closed = this.createClosedSession(session);
    this.sendSessionUpdate(closed);
    this.stopPollingIfIdle();
    this.updatePowerBlocker();
    return closed;
  }

  disposeAll(): void {
    const sessions = [...this.sessions.values()];
    try {
      if (this.addon) {
        assertNativeOperation(this.addon.disposeAll(), "disposeAll");
      } else if (sessions.length > 0) {
        throw new Error("KS Player addon is unavailable while sessions are active.");
      }
    } catch (error) {
      console.warn("[KSPlayer Metal] disposeAll failed:", error);
      throw error;
    }

    this.sessions.clear();
    this.pollFailuresLogged.clear();
    sessions.forEach((session) =>
      this.sendSessionUpdate(this.createClosedSession(session)),
    );
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.updatePowerBlocker();
  }

  shutdown(strict = false): void {
    let failure: unknown;
    try {
      this.disposeAll();
    } catch (error) {
      failure = error;
      console.warn("[KSPlayer Metal] Shutdown could not dispose all sessions:", error);
    }
    this.detachRendererLifecycleWatch();
    if (strict && failure) throw failure;
  }

  private ensurePolling(): void {
    if (this.pollingTimer) {
      return;
    }

    this.pollingTimer = setInterval(() => {
      [...this.sessions.keys()].forEach((sessionId) => {
        const session = this.sessions.get(sessionId);
        if (
          session?.lastStatus === "paused" ||
          session?.lastStatus === "ended" ||
          session?.lastStatus === "error" ||
          session?.lastStatus === "idle"
        ) {
          return;
        }
        try {
          this.refreshSession(sessionId);
          this.pollFailuresLogged.delete(sessionId);
        } catch (error) {
          if (!this.pollFailuresLogged.has(sessionId)) {
            this.pollFailuresLogged.add(sessionId);
            console.error(
              `[KSPlayer Metal] Polling session "${sessionId}" failed:`,
              error,
            );
          }
        }
      });
    }, POLL_INTERVAL_MS);
  }

  /**
   * macOS recreates App.mainWindow after the final window closes. Keep the
   * exact listener identities for the currently active window so an old
   * WebContents cannot retain the service's lifecycle watch or clean up a
   * session owned by its replacement.
   */
  private ensureRendererLifecycleWatch(): void {
    const mainWindow = this.getUsableMainWindow();
    const currentWatch = this.rendererLifecycleWatch;

    if (!mainWindow) {
      this.detachRendererLifecycleWatch();
      this.disposeForRendererLifecycle("window unavailable");
      return;
    }

    if (
      currentWatch?.window === mainWindow &&
      currentWatch.webContents === mainWindow.webContents
    ) {
      return;
    }

    if (currentWatch) {
      this.detachRendererLifecycleWatch();
      this.disposeForRendererLifecycle("main window replaced");
    }

    const dispose = (reason: string) =>
      this.disposeForRendererLifecycle(reason);
    const release = (reason: string) =>
      this.releaseRendererLifecycleResources(mainWindow, reason);
    const watch: RendererLifecycleWatch = {
      window: mainWindow,
      webContents: mainWindow.webContents,
      onRenderProcessGone: (_event, details) =>
        dispose(`process gone (${details.reason})`),
      onDidNavigate: () => dispose("reloaded"),
      onWebContentsDestroyed: () => release("web contents destroyed"),
      onWindowClosed: () => release("window closed"),
    };

    this.rendererLifecycleWatch = watch;
    watch.webContents.on("render-process-gone", watch.onRenderProcessGone);
    watch.webContents.on("did-navigate", watch.onDidNavigate);
    watch.webContents.once("destroyed", watch.onWebContentsDestroyed);
    watch.window.once("closed", watch.onWindowClosed);
  }

  private releaseRendererLifecycleResources(
    window: Electron.BrowserWindow,
    reason: string,
  ): void {
    if (this.rendererLifecycleWatch?.window !== window) {
      return;
    }

    this.detachRendererLifecycleWatch(window);
    this.disposeForRendererLifecycle(reason);
  }

  private disposeForRendererLifecycle(reason: string): void {
    if (
      this.sessions.size === 0 &&
      !this.pollingTimer &&
      this.powerBlockerId === null
    ) {
      return;
    }

    if (this.sessions.size > 0) {
      console.warn(
        `[KSPlayer Metal] Disposing ${this.sessions.size} session(s): renderer ${reason}`,
      );
    }
    try {
      this.disposeAll();
    } catch (error) {
      console.warn(
        `[KSPlayer Metal] Renderer ${reason} cleanup failed; retaining session ownership:`,
        error,
      );
    }
  }

  private detachRendererLifecycleWatch(
    expectedWindow?: Electron.BrowserWindow,
  ): void {
    const watch = this.rendererLifecycleWatch;
    if (!watch || (expectedWindow && watch.window !== expectedWindow)) {
      return;
    }

    this.rendererLifecycleWatch = null;
    try {
      watch.webContents.off("render-process-gone", watch.onRenderProcessGone);
    } catch {
      // A destroyed WebContents can reject listener removal.
    }
    try {
      watch.webContents.off("did-navigate", watch.onDidNavigate);
    } catch {
      // A destroyed WebContents can reject listener removal.
    }
    try {
      watch.webContents.off("destroyed", watch.onWebContentsDestroyed);
    } catch {
      // A destroyed WebContents can reject listener removal.
    }
    try {
      watch.window.off("closed", watch.onWindowClosed);
    } catch {
      // A destroyed BrowserWindow can reject listener removal.
    }
  }

  private stopPollingIfIdle(): void {
    if (this.sessions.size > 0 || !this.pollingTimer) {
      return;
    }
    clearInterval(this.pollingTimer);
    this.pollingTimer = null;
  }

  private refreshSession(sessionId: string): EmbeddedMpvSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const snapshot = this.getAddon().getSnapshot(sessionId);
    if (!snapshot) {
      return null;
    }

    const resolution = snapshot.resolution;
    const videoWidth =
      typeof snapshot.videoWidth === "number"
        ? snapshot.videoWidth
        : typeof resolution?.width === "number"
          ? resolution.width
          : undefined;
    const videoHeight =
      typeof snapshot.videoHeight === "number"
        ? snapshot.videoHeight
        : typeof resolution?.height === "number"
          ? resolution.height
          : undefined;
    const snapshotError =
      typeof snapshot.error === "string"
        ? snapshot.error
        : typeof snapshot.message === "string"
          ? snapshot.message
          : undefined;

    const payload: KsPlayerMetalSession = {
      id: session.id,
      backend: BACKEND,
      title: session.title,
      streamUrl: snapshot.streamUrl || session.streamUrl,
      status: normalizeStatus(
        snapshot.status ?? snapshot.state,
        snapshot.paused,
      ),
      frameReady: snapshot.frameReady === true,
      positionSeconds: this.nonNegativeNumber(snapshot.positionSeconds),
      durationSeconds:
        typeof snapshot.durationSeconds === "number"
          ? Math.max(0, snapshot.durationSeconds)
          : null,
      volume:
        typeof snapshot.volume === "number" ? snapshot.volume : session.volume,
      audioTracks: normalizeTracks<EmbeddedMpvAudioTrack>(snapshot.audioTracks),
      selectedAudioTrackId:
        typeof snapshot.selectedAudioTrackId === "number"
          ? snapshot.selectedAudioTrackId
          : null,
      subtitleTracks: normalizeTracks<EmbeddedMpvSubtitleTrack>(
        snapshot.subtitleTracks,
      ),
      selectedSubtitleTrackId:
        typeof snapshot.selectedSubtitleTrackId === "number"
          ? snapshot.selectedSubtitleTrackId
          : null,
      playbackSpeed:
        typeof snapshot.playbackSpeed === "number" ? snapshot.playbackSpeed : 1,
      aspectOverride:
        typeof snapshot.aspectOverride === "string"
          ? snapshot.aspectOverride
          : "no",
      picture: normalizePicture(snapshot.picture),
      ...(typeof videoWidth === "number" ? { videoWidth } : {}),
      ...(typeof videoHeight === "number" ? { videoHeight } : {}),
      ...(typeof snapshot.container === "string"
        ? { container: snapshot.container }
        : {}),
      ...(typeof snapshot.videoCodec === "string"
        ? { videoCodec: snapshot.videoCodec }
        : {}),
      ...(typeof snapshot.audioCodec === "string"
        ? { audioCodec: snapshot.audioCodec }
        : {}),
      ...(typeof snapshot.hwdecCurrent === "string"
        ? { hwdecCurrent: snapshot.hwdecCurrent }
        : {}),
      ...(typeof snapshot.fps === "number" ? { fps: snapshot.fps } : {}),
      ...(typeof snapshot.bitrate === "number"
        ? { bitrate: snapshot.bitrate }
        : {}),
      ...(typeof snapshot.droppedFrames === "number"
        ? { droppedFrames: snapshot.droppedFrames }
        : {}),
      ...(typeof snapshot.bufferedSeconds === "number"
        ? { bufferedSeconds: snapshot.bufferedSeconds }
        : {}),
      startedAt: session.startedAt,
      updatedAt: new Date().toISOString(),
      ...(snapshotError ? { error: snapshotError } : {}),
    };

    session.streamUrl = payload.streamUrl;
    session.volume = payload.volume;
    session.updatedAt = payload.updatedAt;
    if (session.lastStatus !== payload.status) {
      playbackDiagnostics.record({ event: "native-state", transport: BACKEND, sessionId, sourceUrl: payload.streamUrl, state: payload.status, error: payload.error, activeSessions: this.sessions.size });
    }
    session.lastStatus = payload.status;
    const nextPayloadKey = JSON.stringify({ ...payload, updatedAt: "" });
    if (session.lastPayloadKey !== nextPayloadKey) {
      session.lastPayloadKey = nextPayloadKey;
      this.sendSessionUpdate(payload);
    }
    this.updatePowerBlocker();
    return payload;
  }

  private createPlaceholderSession(
    id: string,
    title: string,
    startedAt: string,
    volume: number,
  ): KsPlayerMetalSession {
    return {
      id,
      backend: BACKEND,
      title,
      streamUrl: "",
      status: "idle",
      positionSeconds: 0,
      durationSeconds: null,
      volume,
      audioTracks: [],
      selectedAudioTrackId: null,
      subtitleTracks: [],
      selectedSubtitleTrackId: null,
      playbackSpeed: 1,
      aspectOverride: "no",
      picture: { ...DEFAULT_PICTURE },
      startedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private createClosedSession(
    session: KsPlayerMetalRuntimeSession,
  ): KsPlayerMetalSession {
    return {
      id: session.id,
      backend: BACKEND,
      title: session.title,
      streamUrl: session.streamUrl,
      status: "closed",
      positionSeconds: 0,
      durationSeconds: null,
      volume: session.volume,
      audioTracks: [],
      selectedAudioTrackId: null,
      subtitleTracks: [],
      selectedSubtitleTrackId: null,
      playbackSpeed: 1,
      aspectOverride: "no",
      picture: { ...DEFAULT_PICTURE },
      startedAt: session.startedAt,
      updatedAt: new Date().toISOString(),
    };
  }

  private nonNegativeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, value)
      : 0;
  }

  private updatePowerBlocker(): void {
    const shouldBlock = [...this.sessions.values()].some(
      (session) => session.lastStatus === "playing",
    );

    if (shouldBlock && this.powerBlockerId === null) {
      try {
        this.powerBlockerId = powerSaveBlocker.start("prevent-display-sleep");
      } catch {
        this.powerBlockerId = null;
      }
      return;
    }

    if (!shouldBlock && this.powerBlockerId !== null) {
      const blockerId = this.powerBlockerId;
      this.powerBlockerId = null;
      try {
        if (powerSaveBlocker.isStarted(blockerId)) {
          powerSaveBlocker.stop(blockerId);
        }
      } catch {
        // Best effort; Electron releases the blocker on process exit.
      }
    }
  }

  private sendSessionUpdate(session: EmbeddedMpvSession): void {
    const mainWindow = this.getUsableMainWindow();
    if (!mainWindow) {
      return;
    }
    try {
      mainWindow.webContents.send(KSPLAYER_METAL_SESSION_UPDATE, session);
    } catch {
      // The renderer can disappear between the lifecycle check and send.
    }
  }

  private getRuntimeSession(sessionId: string): KsPlayerMetalRuntimeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`KSPlayer Metal session "${sessionId}" was not found.`);
    }
    return session;
  }

  private getMainWindowHandle(): Buffer {
    const mainWindow = this.getUsableMainWindow();
    if (!mainWindow) {
      throw new Error("The Electron main window is not available.");
    }
    return mainWindow.getNativeWindowHandle();
  }

  private scaleBoundsForNativeView(
    bounds: EmbeddedMpvBounds,
  ): EmbeddedMpvBounds {
    let zoomFactor = 1;
    try {
      const mainWindow = this.getUsableMainWindow();
      if (mainWindow) {
        zoomFactor = mainWindow.webContents.getZoomFactor();
      }
    } catch {
      zoomFactor = 1;
    }
    return toNativeViewBounds(bounds, { zoomFactor });
  }

  private getUsableMainWindow(): Electron.BrowserWindow | null {
    const mainWindow = App.mainWindow;
    if (!mainWindow) {
      return null;
    }

    try {
      return mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()
        ? null
        : mainWindow;
    } catch {
      return null;
    }
  }

  private getAddon(): NativeKsPlayerMetalAddon {
    if (this.addon) {
      return this.addon;
    }
    if (this.addonLoadError) {
      throw this.addonLoadError;
    }

    const candidatePaths = getKsPlayerMetalAddonCandidatePaths();
    const existing = candidatePaths.filter((candidatePath) =>
      existsSync(candidatePath),
    );
    if (existing.length === 0) {
      this.addonLoadError = new Error(
        [
          "Unable to locate the KSPlayer Metal native addon.",
          ...candidatePaths.map((candidatePath) => `- ${candidatePath}`),
        ].join("\n"),
      );
      throw this.addonLoadError;
    }

    const loadErrors: string[] = [];
    for (const candidatePath of existing) {
      try {
        this.addon = this.loadAddonModule(
          candidatePath,
        ) as NativeKsPlayerMetalAddon;
        this.addonPath = candidatePath;
        return this.addon;
      } catch (error) {
        loadErrors.push(`${candidatePath}: ${stringifyError(error)}`);
      }
    }

    this.addonLoadError = new Error(
      [
        "Unable to load the KSPlayer Metal native addon.",
        ...loadErrors.map((error) => `- ${error}`),
      ].join("\n"),
    );
    throw this.addonLoadError;
  }

  private readUnavailableReason(candidatePaths: string[]): string | null {
    for (const candidatePath of candidatePaths) {
      for (const marker of [
        "ksplayer-metal-unavailable.txt",
        "ksplayer_metal-unavailable.txt",
      ]) {
        const markerPath = path.join(path.dirname(candidatePath), marker);
        if (existsSync(markerPath)) {
          return readFileSync(markerPath, "utf8").trim();
        }
      }
    }
    return null;
  }
}

export const ksPlayerMetalNativeService = new KsPlayerMetalNativeService();
