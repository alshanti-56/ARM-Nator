/* eslint-disable max-lines */
import {
  Directive,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import {
  PLAYER_ENGINES,
  PLAYER_FACADE,
  isManagedExternalPlayer,
} from "@arm-nator/player/core";
import {
  type PlaybackDiagnostic,
  type PlaybackFallbackRequest,
  type PlayerRuntimeSnapshot,
  WorkspacePlayerStateService,
} from "@arm-nator/player/ui";
import { SettingsStore } from "@arm-nator/services";
import {
  type ResolvedPortalPlayback,
  type ExternalPlayerSession,
  type KsPlayerMetalSupport,
  type PlaybackNetworkInspection,
  type PlayerEngineAvailability,
  VideoPlayer,
  type DirectPlayLayoutMode,
} from "@arm-nator/shared/interfaces";
import {
  type DirectPlayEmbeddedSupport,
  getDirectPlayNativeEngineAccess,
  getDirectPlayNativeSupport,
  getDirectPlayStaticCapabilities,
  isDirectPlayNativeEngine,
} from "./direct-play-capabilities";
import { hasStartedEmbeddedMpvSession } from "./direct-play-native-session";

interface DirectPlaybackInfo {
  readonly protocol: string;
  readonly host: string;
  readonly streamType: string;
  readonly headerCount: number;
}

interface DiagnosticTimelineItem {
  readonly id: number;
  readonly timestamp: number;
  readonly level: "info" | "warning" | "error";
  readonly title: string;
  readonly details?: string;
}

@Directive()
export class DirectPlayController implements OnDestroy {
  private readonly player = inject(PLAYER_FACADE);
  private readonly settingsStore = inject(SettingsStore);
  private readonly workspacePlayer = inject(WorkspacePlayerStateService);

  readonly engines = PLAYER_ENGINES;
  readonly playback = signal<ResolvedPortalPlayback | null>(null);
  readonly selectedEngine = signal(VideoPlayer.ArtPlayer);
  readonly status = signal<
    "ready" | "opening" | "playing" | "paused" | "ended" | "external" | "error"
  >("ready");
  readonly errorMessage = signal("");
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly diagnostic = signal<PlaybackDiagnostic | null>(null);
  readonly diagnostics = signal<readonly PlaybackDiagnostic[]>([]);
  readonly runtimeSnapshot = signal<PlayerRuntimeSnapshot | null>(null);
  readonly networkInspection = signal<PlaybackNetworkInspection | null>(null);
  readonly externalSession = signal<ExternalPlayerSession | null>(null);
  readonly playerActive = signal(false);
  readonly layoutMode = signal<DirectPlayLayoutMode>("full");
  readonly embeddedSupport = signal<DirectPlayEmbeddedSupport | null>(null);
  readonly ksPlayerMetalSupport = signal<KsPlayerMetalSupport | null>(null);
  readonly nativeEngineMessage = signal<string | null>(null);
  readonly metalPlaybackFailure = signal<string | null>(null);
  readonly externalEngineAvailability = signal<
    readonly PlayerEngineAvailability[] | null
  >(null);
  readonly timeline = signal<readonly DiagnosticTimelineItem[]>([]);
  private diagnosticSequence = 0;
  private lastRuntimeStatus = "idle";

  url = "";
  title = "";
  headersText = "";
  isLive = true;
  seekStepSeconds = 10;
  frameRate = 25;
  private readonly unsubscribeExternalSession?: () => void;
  private pendingPreferredEngine: VideoPlayer | null = null;

  constructor() {
    void this.loadPreferences();
    effect(() => {
      const current = this.playback();
      const workspacePlayback = this.workspacePlayer.playback();
      const snapshot = this.workspacePlayer.runtimeSnapshot();
      if (
        current &&
        workspacePlayback?.streamUrl === current.streamUrl &&
        snapshot
      ) {
        untracked(() => this.onRuntimeSnapshot(snapshot));
      }
    });
    effect(() => {
      const current = this.playback();
      const workspacePlayback = this.workspacePlayer.playback();
      const diagnostic = this.workspacePlayer.diagnostic();
      if (
        current &&
        workspacePlayback?.streamUrl === current.streamUrl &&
        diagnostic
      ) {
        untracked(() => this.onDiagnostic(diagnostic));
      }
    });
    const electron =
      typeof window === "undefined" ? undefined : window.electron;
    this.unsubscribeExternalSession = electron?.onExternalPlayerSessionUpdate?.(
      (session) => {
        this.externalSession.set(session);
        this.recordEvent(
          session.status === "error" ? "error" : "info",
          `${session.player} session: ${session.status}`,
          session.error,
        );
      },
    );
    this.loadNativeEngineSupport(electron);
    if (typeof electron?.getPlayerEngineAvailability === "function") {
      void electron
        .getPlayerEngineAvailability()
        .then((availability) => {
          this.externalEngineAvailability.set(availability);
          this.applyPendingPreferredEngine();
        })
        .catch(() => this.externalEngineAvailability.set([]));
    } else {
      this.externalEngineAvailability.set([]);
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeExternalSession?.();
  }

  readonly isExternalEngine = computed(() =>
    isManagedExternalPlayer(this.selectedEngine()),
  );
  readonly isNativeEngine = isDirectPlayNativeEngine;
  readonly selectedNativeEngineAccess = computed(() =>
    getDirectPlayNativeEngineAccess(
      this.selectedEngine(),
      this.embeddedSupport(),
      this.ksPlayerMetalSupport(),
    ),
  );
  readonly canLaunchSelectedEngine = computed(() => {
    if (!this.selectedNativeEngineAccess().canLaunch) {
      return false;
    }
    return (
      this.engineAvailability().find(
        (engine) => engine.engine === this.selectedEngine(),
      )?.available ?? true
    );
  });
  readonly selectedNativeEngineMessage = computed(() => {
    const access = this.selectedNativeEngineAccess();
    if (access.native && !access.canSelect) {
      return this.unavailableNativeEngineMessage(
        this.selectedEngine(),
        access.detail,
      );
    }
    const selected = this.engineAvailability().find(
      (engine) => engine.engine === this.selectedEngine(),
    );
    if (selected && !selected.available) {
      return this.unavailableEngineMessage(
        this.selectedEngine(),
        selected.detail,
      );
    }
    return this.nativeEngineMessage();
  });
  readonly inlineEngines = computed(() =>
    this.engines.filter((engine) => !isManagedExternalPlayer(engine.id)),
  );
  readonly externalEngines = computed(() =>
    this.engines.filter((engine) => isManagedExternalPlayer(engine.id)),
  );
  readonly capabilitySummary = computed(() => {
    const runtime = this.runtimeSnapshot();
    if (runtime) {
      const capabilities = runtime.capabilities;
      return [
        ["Play / pause", true],
        ["Seek", capabilities.seek],
        ["Volume", capabilities.volume],
        ["Audio tracks", capabilities.audioTracks],
        ["Subtitles", capabilities.subtitles],
        ["Speed", capabilities.playbackSpeed],
        ["Aspect", capabilities.aspectRatio],
        ["Fullscreen", capabilities.fullscreen],
      ]
        .filter(([, enabled]) => enabled)
        .map(([label]) => String(label));
    }

    return getDirectPlayStaticCapabilities(this.selectedEngine(), this.isLive);
  });
  readonly engineAvailability = computed(() =>
    this.engines.map((engine) => {
      const support = getDirectPlayNativeSupport(
        engine.id,
        this.embeddedSupport(),
        this.ksPlayerMetalSupport(),
      );
      if (support) {
        return {
          engine: engine.id,
          native: true,
          ...support,
        };
      }
      if (engine.id === VideoPlayer.MPV || engine.id === VideoPlayer.VLC) {
        const availabilityEngine = engine.id;
        const externalAvailability = this.externalEngineAvailability();
        const availability = externalAvailability?.find(
          (item) => item.engine === availabilityEngine,
        );
        return {
          engine: engine.id,
          native: false,
          available:
            externalAvailability === null
              ? true
              : (availability?.available ?? false),
          detail:
            availability?.path ??
            availability?.reason ??
            "Checking player binary",
        };
      }
      return {
        engine: engine.id,
        native: false,
        available: true,
        detail: "Available",
      };
    }),
  );
  readonly playbackInfo = computed<DirectPlaybackInfo | null>(() => {
    const playback = this.playback();
    if (!playback) {
      return null;
    }

    let protocol = "Unknown";
    let host = "Unknown";
    try {
      const parsed = new URL(playback.streamUrl);
      protocol = parsed.protocol.replace(":", "").toUpperCase();
      host = parsed.host;
    } catch {
      // Raw paths and custom protocols remain playable by native engines.
    }

    return {
      protocol,
      host,
      streamType: this.detectStreamType(playback.streamUrl),
      headerCount: Object.keys(playback.headers ?? {}).length,
    };
  });

  async play(): Promise<void> {
    const streamUrl = this.url.trim();
    if (!streamUrl) {
      this.errorMessage.set("Enter a playback URL.");
      this.status.set("error");
      return;
    }

    const engine = this.selectedEngine();
    if (!this.ensureEngineAccess(engine, "launch")) {
      return;
    }

    const playback: ResolvedPortalPlayback = {
      streamUrl,
      title: this.title.trim() || "Direct stream",
      headers: this.parseHeaders(this.headersText),
      isLive: this.isLive,
    };

    const firstRequest = this.playback() === null;
    this.playback.set(playback);
    this.playerActive.set(false);
    this.currentTime.set(0);
    this.duration.set(0);
    this.diagnostic.set(null);
    this.runtimeSnapshot.set(null);
    this.lastRuntimeStatus = "idle";
    if (firstRequest) {
      this.timeline.set([]);
      this.diagnostics.set([]);
    }
    this.nativeEngineMessage.set(null);
    this.metalPlaybackFailure.set(null);
    this.errorMessage.set("");
    this.status.set("opening");
    this.recordEvent(
      "info",
      "Playback requested",
      `${this.selectedEngine()} · ${this.detectStreamType(streamUrl)}`,
    );
    void this.inspectNetwork(playback);

    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        const session = await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.VLC ? "vlc" : "mpv",
        );
        if (session) {
          this.externalSession.set(session);
        }
        this.status.set("external");
        this.recordEvent(
          "info",
          "External player opened",
          this.selectedEngine(),
        );
      } catch (error) {
        this.markExternalEngineUnavailable(
          engine,
          error instanceof Error ? error.message : "External player failed.",
        );
        this.errorMessage.set(
          error instanceof Error ? error.message : "External player failed.",
        );
        this.status.set("error");
        this.recordEvent(
          "error",
          "External player failed",
          this.errorMessage(),
        );
      }
      return;
    }

    this.player.openInlinePlayback(playback, engine);
    this.playerActive.set(true);
    this.status.set("opening");
    this.recordEvent("info", "Inline player mounted", this.selectedEngine());
  }

  async switchEngine(engine: VideoPlayer): Promise<void> {
    if (engine === this.selectedEngine()) {
      return;
    }
    if (!this.selectEngine(engine)) {
      return;
    }
    if (this.playback()) {
      this.recordEvent("info", "Player engine changed", engine);
      if (!isManagedExternalPlayer(engine)) {
        this.workspacePlayer.switchEngine(engine);
        return;
      }
      await this.restartPlayback();
      return;
    }
    this.recordEvent("info", "Player engine changed", engine);
  }

  setLayoutMode(layout: DirectPlayLayoutMode): void {
    this.layoutMode.set(layout);
    void this.persistPreferences();
  }

  selectEngine(engine: VideoPlayer): boolean {
    this.pendingPreferredEngine = null;
    if (!this.ensureEngineAccess(engine, "selection")) {
      return false;
    }
    this.selectedEngine.set(engine);
    this.nativeEngineMessage.set(null);
    this.metalPlaybackFailure.set(null);
    void this.persistPreferences();
    return true;
  }

  setSeekStepSeconds(value: unknown): void {
    const parsed = Number(value);
    this.seekStepSeconds = Number.isFinite(parsed)
      ? Math.min(600, Math.max(1, Math.round(parsed)))
      : 10;
    void this.persistPreferences();
  }

  setFrameRate(value: unknown): void {
    const parsed = Number(value);
    this.frameRate = Number.isFinite(parsed)
      ? Math.min(240, Math.max(1, parsed))
      : 25;
    void this.persistPreferences();
  }

  async openFallback(request: PlaybackFallbackRequest): Promise<void> {
    try {
      await this.player.openExternalPlayback(request.playback, request.player);
      this.status.set("external");
      this.recordEvent(
        "warning",
        `Fallback opened in ${request.player}`,
        request.diagnostic.code,
      );
    } catch (error) {
      this.markExternalEngineUnavailable(
        request.player === "vlc" ? VideoPlayer.VLC : VideoPlayer.MPV,
        error instanceof Error ? error.message : "External player failed.",
      );
      this.errorMessage.set(
        error instanceof Error ? error.message : "External player failed.",
      );
      this.status.set("error");
      this.recordEvent("error", "Fallback failed", this.errorMessage());
    }
  }

  onTimeUpdate(event: { currentTime: number; duration: number }): void {
    this.currentTime.set(event.currentTime);
    this.duration.set(event.duration);
  }

  onRuntimeSnapshot(snapshot: PlayerRuntimeSnapshot): void {
    if (
      this.selectedEngine() === VideoPlayer.KsPlayer &&
      hasStartedEmbeddedMpvSession(snapshot.engine)
    ) {
      if (!this.metalPlaybackFailure()) {
        const message =
          snapshot.engine?.supportReason ??
          "KS Player failed. Playback was stopped instead of continuing with embedded MPV.";
        this.metalPlaybackFailure.set(message);
        this.nativeEngineMessage.set(message);
        this.errorMessage.set(message);
        this.playerActive.set(false);
        this.status.set("error");
        this.recordEvent("error", "KS Player playback failed", message);
        this.workspacePlayer.stop();
      }
      return;
    }

    this.runtimeSnapshot.set(snapshot);
    this.currentTime.set(snapshot.state.positionSeconds);
    this.duration.set(snapshot.state.durationSeconds ?? 0);

    const runtimeStatus = snapshot.state.status;
    if (runtimeStatus !== this.lastRuntimeStatus) {
      this.lastRuntimeStatus = runtimeStatus;
      this.recordEvent(
        runtimeStatus === "error" ? "error" : "info",
        `Player state: ${runtimeStatus}`,
        snapshot.state.statusMessage || undefined,
      );
    }

    switch (runtimeStatus) {
      case "loading":
      case "idle":
        this.status.set("opening");
        break;
      case "playing":
        this.status.set("playing");
        break;
      case "paused":
        this.status.set("paused");
        break;
      case "ended":
        this.status.set("ended");
        break;
      case "error":
        this.status.set("error");
        break;
    }
  }

  onDiagnostic(issue: PlaybackDiagnostic | null): void {
    this.diagnostic.set(issue);
    if (!issue) {
      return;
    }

    this.diagnostics.update((items) => [...items, issue]);
    this.status.set("error");
    this.recordEvent(
      "error",
      `${issue.source}: ${issue.code}`,
      issue.details ?? issue.nativeErrorMessage,
    );
  }

  readonly diagnosticReport = computed(() =>
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        status: this.status(),
        engine: this.selectedEngine(),
        playback: this.playback(),
        runtime: {
          currentTime: this.currentTime(),
          duration: this.duration(),
          snapshot: this.runtimeSnapshot(),
        },
        diagnostic: this.diagnostic(),
        diagnostics: this.diagnostics(),
        network: this.networkInspection(),
        externalSession: this.externalSession(),
        timeline: this.timeline(),
      },
      null,
      2,
    ),
  );

  exportDiagnostics(): void {
    const blob = new Blob([this.diagnosticReport()], {
      type: "application/json",
    });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `arm-nator-playback-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(downloadUrl);
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "00:00";
    }
    const wholeSeconds = Math.floor(seconds);
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = wholeSeconds % 60;
    const base = `${minutes.toString().padStart(2, "0")}:${remainder
      .toString()
      .padStart(2, "0")}`;
    return hours ? `${hours.toString().padStart(2, "0")}:${base}` : base;
  }

  formatBitrate(bitsPerSecond: number | undefined): string {
    return bitsPerSecond && Number.isFinite(bitsPerSecond)
      ? `${Math.round(bitsPerSecond / 1000)} kbps`
      : "Unknown";
  }

  clear(): void {
    void this.stopPlayback();
    if (
      this.workspacePlayer.playback()?.streamUrl === this.playback()?.streamUrl
    ) {
      this.workspacePlayer.close();
    }
    this.playback.set(null);
    this.status.set("ready");
    this.errorMessage.set("");
    this.currentTime.set(0);
    this.duration.set(0);
    this.diagnostic.set(null);
    this.diagnostics.set([]);
    this.networkInspection.set(null);
    this.externalSession.set(null);
    this.runtimeSnapshot.set(null);
    this.nativeEngineMessage.set(null);
    this.metalPlaybackFailure.set(null);
    this.lastRuntimeStatus = "idle";
    this.timeline.set([]);
  }

  async stopPlayback(): Promise<void> {
    this.playerActive.set(false);
    if (
      this.workspacePlayer.playback()?.streamUrl === this.playback()?.streamUrl
    ) {
      this.workspacePlayer.stop();
    }
    const external = this.externalSession();
    if (external?.canClose) {
      await window.electron
        ?.closeExternalPlayerSession(external.id)
        .catch(() => undefined);
    }
    this.status.set("ended");
    this.recordEvent("info", "Playback stopped");
  }

  async controlExternal(
    action: "toggle-pause" | "seek-relative",
    value?: number,
  ): Promise<void> {
    const session = this.externalSession();
    if (!session || !window.electron?.controlExternalPlayerSession) {
      return;
    }
    const updated = await window.electron.controlExternalPlayerSession(
      session.id,
      action,
      value,
    );
    if (updated) {
      this.externalSession.set(updated);
    }
    this.recordEvent(
      "info",
      `External control: ${action}`,
      value === undefined ? undefined : String(value),
    );
  }

  async restartPlayback(): Promise<void> {
    const playback = this.playback();
    if (!playback) {
      return;
    }
    const engine = this.selectedEngine();
    if (!this.ensureEngineAccess(engine, "launch")) {
      return;
    }
    await this.stopPlayback();
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.status.set("opening");
    this.recordEvent("info", "Playback restarted", this.selectedEngine());

    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        const session = await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.VLC ? "vlc" : "mpv",
        );
        if (session) {
          this.externalSession.set(session);
        }
        this.workspacePlayer.close();
        this.status.set("external");
      } catch (error) {
        this.status.set("error");
        this.recordEvent(
          "error",
          "Restart failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      return;
    }

    this.workspacePlayer.restart();
    this.playerActive.set(true);
  }

  seekByConfiguredStep(direction: -1 | 1): void {
    const embeddedSessionId = this.runtimeSnapshot()?.engine?.sessionId;
    if (embeddedSessionId && window.electron?.seekEmbeddedMpv) {
      void window.electron.seekEmbeddedMpv(
        embeddedSessionId,
        Math.max(0, this.currentTime() + direction * this.seekStepSeconds),
      );
      return;
    }
    const video = document.querySelector(
      ".direct-play-page video",
    ) as HTMLVideoElement | null;
    if (!video || !Number.isFinite(video.duration)) {
      return;
    }
    video.currentTime = Math.max(
      0,
      Math.min(
        video.duration,
        video.currentTime + direction * this.seekStepSeconds,
      ),
    );
    this.recordEvent(
      "info",
      "Configured seek",
      `${direction * this.seekStepSeconds}s`,
    );
  }

  seekFrame(direction: -1 | 1): void {
    const embeddedSessionId = this.runtimeSnapshot()?.engine?.sessionId;
    const frameDuration = 1 / Math.max(1, this.frameRate);
    if (embeddedSessionId && window.electron?.seekEmbeddedMpv) {
      void window.electron.seekEmbeddedMpv(
        embeddedSessionId,
        Math.max(0, this.currentTime() + direction * frameDuration),
      );
      return;
    }
    const video = document.querySelector(
      ".direct-play-page video",
    ) as HTMLVideoElement | null;
    if (!video) {
      return;
    }
    video.pause();
    video.currentTime = Math.max(
      0,
      video.currentTime + direction * frameDuration,
    );
  }

  private async inspectNetwork(
    playback: ResolvedPortalPlayback,
  ): Promise<void> {
    if (!window.electron?.inspectPlaybackUrl) {
      return;
    }
    const inspection = await window.electron.inspectPlaybackUrl(
      playback.streamUrl,
      playback.headers,
    );
    if (this.playback()?.streamUrl !== playback.streamUrl) {
      return;
    }
    this.networkInspection.set(inspection);
    if (typeof inspection.detectedLive === "boolean") {
      this.isLive = inspection.detectedLive;
      const current = this.playback();
      if (current) {
        this.playback.set({
          ...current,
          isLive: inspection.detectedLive,
        });
      }
    }
    this.recordEvent(
      inspection.error ? "error" : "info",
      inspection.error ? "Network inspection failed" : "Network inspected",
      inspection.error ??
        `${inspection.status} ${inspection.contentType ?? "unknown type"} · ${inspection.redirectChain.length - 1} redirects`,
    );
  }

  private async loadPreferences(): Promise<void> {
    await this.settingsStore.loadSettings();
    const preferences = this.settingsStore.getSettings().directPlay;
    if (!preferences) {
      return;
    }
    this.pendingPreferredEngine = preferences.engine;
    this.applyPendingPreferredEngine();
    this.layoutMode.set(preferences.layout);
    this.seekStepSeconds = preferences.seekStepSeconds;
    this.frameRate = preferences.frameRate;
  }

  private async persistPreferences(): Promise<void> {
    await this.settingsStore.updateSettings({
      directPlay: {
        engine: this.selectedEngine(),
        layout: this.layoutMode(),
        seekStepSeconds: this.seekStepSeconds,
        frameRate: this.frameRate,
      },
    });
  }

  private loadNativeEngineSupport(
    electron: Window["electron"] | undefined,
  ): void {
    if (!electron) {
      this.embeddedSupport.set({
        available: false,
        reason: "Embedded MPV requires the Electron desktop app.",
      });
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player requires the Electron desktop app.",
      });
      return;
    }

    if (typeof electron.getEmbeddedMpvSupport !== "function") {
      this.embeddedSupport.set({
        available: false,
        reason: "Embedded MPV is unavailable in this build.",
      });
    } else {
      void Promise.resolve()
        .then(() => electron.getEmbeddedMpvSupport())
        .then((support) => {
          this.embeddedSupport.set({
            available: support.supported,
            reason: support.reason,
          });
          this.applyPendingPreferredEngine();
        })
        .catch((error: unknown) => {
          this.embeddedSupport.set({
            available: false,
            reason: this.getErrorMessage(error),
          });
          this.applyPendingPreferredEngine();
        });
    }

    if (typeof electron.getKsPlayerMetalSupport !== "function") {
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player is unavailable in this build.",
      });
    } else {
      void Promise.resolve()
        .then(() => electron.getKsPlayerMetalSupport())
        .then((support) => {
          this.ksPlayerMetalSupport.set(support);
          this.applyPendingPreferredEngine();
        })
        .catch((error: unknown) => {
          this.ksPlayerMetalSupport.set({
            supported: false,
            reason: this.getErrorMessage(error),
          });
          this.applyPendingPreferredEngine();
        });
    }
  }

  private applyPendingPreferredEngine(): void {
    const engine = this.pendingPreferredEngine;
    if (!engine) {
      return;
    }

    const access = getDirectPlayNativeEngineAccess(
      engine,
      this.embeddedSupport(),
      this.ksPlayerMetalSupport(),
    );
    if (access.native && !access.canSelect) {
      if (this.isNativeSupportPending(engine)) {
        return;
      }
      this.pendingPreferredEngine = null;
      this.nativeEngineMessage.set(
        this.unavailableNativeEngineMessage(engine, access.detail),
      );
      return;
    }

    if (isManagedExternalPlayer(engine)) {
      const availability = this.engineAvailability().find(
        (item) => item.engine === engine,
      );
      if (availability?.available === false) {
        this.pendingPreferredEngine = null;
        this.nativeEngineMessage.set(
          this.unavailableEngineMessage(engine, availability.detail),
        );
        return;
      }
    }

    this.pendingPreferredEngine = null;
    this.selectedEngine.set(engine);
    this.nativeEngineMessage.set(null);
  }

  private ensureEngineAccess(
    engine: VideoPlayer,
    action: "selection" | "launch",
  ): boolean {
    const access = getDirectPlayNativeEngineAccess(
      engine,
      this.embeddedSupport(),
      this.ksPlayerMetalSupport(),
    );
    if (access.native) {
      if (action === "selection" ? access.canSelect : access.canLaunch) {
        return true;
      }

      const message = this.unavailableNativeEngineMessage(
        engine,
        access.detail,
      );
      this.nativeEngineMessage.set(message);
      if (action === "launch") {
        this.errorMessage.set(message);
        this.status.set("error");
      }
      this.recordEvent("warning", `${engine} ${action} blocked`, access.detail);
      return false;
    }

    const external = this.engineAvailability().find(
      (item) => item.engine === engine,
    );
    if (external?.available === false) {
      const message = this.unavailableEngineMessage(engine, external.detail);
      this.nativeEngineMessage.set(message);
      if (action === "launch") {
        this.errorMessage.set(message);
        this.status.set("error");
      }
      this.recordEvent(
        "warning",
        `${engine} ${action} blocked`,
        external.detail,
      );
      return false;
    }

    return true;
  }

  private isNativeSupportPending(engine: VideoPlayer): boolean {
    return (
      (engine === VideoPlayer.EmbeddedMpv && this.embeddedSupport() === null) ||
      (engine === VideoPlayer.KsPlayer && this.ksPlayerMetalSupport() === null)
    );
  }

  private unavailableNativeEngineMessage(
    engine: VideoPlayer,
    detail: string | undefined,
  ): string {
    return `${engine} is unavailable: ${detail ?? "Native support is unavailable."}`;
  }

  private unavailableEngineMessage(
    engine: VideoPlayer,
    detail: string | undefined,
  ): string {
    return `${engine} is unavailable (optional external player): ${detail ?? "Install or configure the player in Settings."}`;
  }

  private markExternalEngineUnavailable(
    engine: VideoPlayer,
    reason: string,
  ): void {
    this.externalEngineAvailability.update((current) => {
      const next = current ? [...current] : [];
      const existing = next.find((item) => item.engine === engine);
      if (existing) {
        existing.available = false;
        existing.reason = reason;
      } else {
        next.push({ engine, available: false, reason });
      }
      return next;
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private recordEvent(
    level: DiagnosticTimelineItem["level"],
    title: string,
    details?: string,
  ): void {
    const event: DiagnosticTimelineItem = {
      id: ++this.diagnosticSequence,
      timestamp: Date.now(),
      level,
      title,
      details,
    };
    this.timeline.update((items) => [...items, event]);
  }

  private parseHeaders(value: string): Record<string, string> | undefined {
    const headers: Record<string, string> = {};
    for (const line of value.split(/\r?\n/)) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      const name = line.slice(0, separator).trim();
      const headerValue = line.slice(separator + 1).trim();
      if (name && headerValue) {
        headers[name] = headerValue;
      }
    }
    return Object.keys(headers).length ? headers : undefined;
  }

  private detectStreamType(url: string): string {
    const cleanUrl = url.toLowerCase().split("?")[0];
    if (cleanUrl.endsWith(".m3u8")) return "HLS";
    if (cleanUrl.endsWith(".mpd")) return "DASH";
    if (cleanUrl.endsWith(".ts") || cleanUrl.endsWith(".mpegts"))
      return "MPEG-TS";
    if (cleanUrl.endsWith(".mp4")) return "MP4";
    if (cleanUrl.endsWith(".mkv")) return "Matroska";
    return "Automatic";
  }
}
