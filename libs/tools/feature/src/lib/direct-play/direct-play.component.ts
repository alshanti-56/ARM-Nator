import { ClipboardModule } from "@angular/cdk/clipboard";
import { DatePipe, JsonPipe, DecimalPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import {
  PLAYER_ENGINES,
  PLAYER_FACADE,
  isManagedExternalPlayer,
} from "@arm-nator/player/core";
import {
  type PlaybackDiagnostic,
  type PlaybackFallbackRequest,
  type PlayerRuntimeSnapshot,
  WebPlayerViewComponent,
} from "@arm-nator/player/ui";
import {
  type ResolvedPortalPlayback,
  type ExternalPlayerSession,
  type PlaybackNetworkInspection,
  type PlayerEngineAvailability,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";

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

@Component({
  selector: "app-direct-play",
  imports: [
    ClipboardModule,
    DatePipe,
    DecimalPipe,
    FormsModule,
    JsonPipe,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    WebPlayerViewComponent,
  ],
  templateUrl: "./direct-play.component.html",
  styleUrl: "./direct-play.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DirectPlayComponent implements OnDestroy {
  private readonly player = inject(PLAYER_FACADE);

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
  readonly layoutMode = signal<"compact" | "full">("full");
  readonly embeddedSupport = signal<{
    available: boolean;
    reason?: string;
    engine?: string;
  } | null>(null);
  readonly externalEngineAvailability = signal<
    readonly PlayerEngineAvailability[]
  >([]);
  readonly timeline = signal<readonly DiagnosticTimelineItem[]>([]);
  private diagnosticSequence = 0;
  private lastRuntimeStatus = "idle";

  url = "";
  title = "";
  headersText = "";
  subtitleUrl = "";
  subtitleLabel = "Online subtitle";
  subtitleLanguage = "en";
  isLive = true;
  seekStepSeconds = 10;
  frameRate = 25;
  private readonly unsubscribeExternalSession?: () => void;

  constructor() {
    this.unsubscribeExternalSession =
      window.electron?.onExternalPlayerSessionUpdate?.((session) => {
        this.externalSession.set(session);
        this.recordEvent(
          session.status === "error" ? "error" : "info",
          `${session.player} session: ${session.status}`,
          session.error,
        );
      });
    void window.electron
      ?.getEmbeddedMpvSupport?.()
      .then((support) =>
        this.embeddedSupport.set({
          available: support.supported,
          reason: support.reason,
          engine: support.engine,
        }),
      )
      .catch((error: unknown) =>
        this.embeddedSupport.set({
          available: false,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    void window.electron
      ?.getPlayerEngineAvailability?.()
      .then((availability) => this.externalEngineAvailability.set(availability))
      .catch(() => undefined);
  }

  ngOnDestroy(): void {
    this.unsubscribeExternalSession?.();
  }

  readonly isExternalEngine = computed(() =>
    isManagedExternalPlayer(this.selectedEngine()),
  );
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
        ["Recording", capabilities.recording],
        ["Picture in picture", capabilities.pictureInPicture],
        ["Fullscreen", capabilities.fullscreen],
      ]
        .filter(([, enabled]) => enabled)
        .map(([label]) => String(label));
    }

    switch (this.selectedEngine()) {
      case VideoPlayer.EmbeddedMpv:
        return [
          "Play / pause",
          "Seek",
          "Volume",
          "Audio tracks",
          "Subtitles",
          "Speed",
          "Aspect",
          "Recording",
          "Fullscreen",
        ];
      case VideoPlayer.ArtPlayer:
      case VideoPlayer.Html5Player:
        return [
          "Play / pause",
          this.isLive ? "Live timeline" : "Seek",
          "Volume",
          "Speed",
          "Picture in picture",
          "Fullscreen",
        ];
      case VideoPlayer.MPV:
      case VideoPlayer.VLC:
        return ["Controlled in external player"];
    }
  });
  readonly engineAvailability = computed(() =>
    this.engines.map((engine) => {
      if (engine.id === VideoPlayer.EmbeddedMpv) {
        const support = this.embeddedSupport();
        return {
          engine: engine.id,
          available: support?.available ?? false,
          detail:
            support?.engine ?? support?.reason ?? "Checking native runtime",
        };
      }
      if (engine.id === VideoPlayer.MPV || engine.id === VideoPlayer.VLC) {
        const availability = this.externalEngineAvailability().find(
          (item) => item.engine === engine.id,
        );
        return {
          engine: engine.id,
          available: availability?.available ?? false,
          detail:
            availability?.path ??
            availability?.reason ??
            "Checking player binary",
        };
      }
      return { engine: engine.id, available: true, detail: "Available" };
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

    const playback: ResolvedPortalPlayback = {
      streamUrl,
      title: this.title.trim() || "Direct stream",
      headers: this.parseHeaders(this.headersText),
      isLive: this.isLive,
      subtitleUrl: this.subtitleUrl.trim() || undefined,
      subtitleLabel: this.subtitleLabel.trim() || undefined,
      subtitleLanguage: this.subtitleLanguage.trim() || undefined,
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
    this.errorMessage.set("");
    this.status.set("opening");
    this.recordEvent(
      "info",
      "Playback requested",
      `${this.selectedEngine()} · ${this.detectStreamType(streamUrl)}`,
    );
    void this.inspectNetwork(playback);

    const engine = this.selectedEngine();
    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        const session = await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.MPV ? "mpv" : "vlc",
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

    this.playerActive.set(true);
    this.status.set("opening");
    this.recordEvent("info", "Inline player mounted", this.selectedEngine());
  }

  async switchEngine(engine: VideoPlayer): Promise<void> {
    if (engine === this.selectedEngine()) {
      return;
    }
    this.selectedEngine.set(engine);
    if (this.playback()) {
      this.recordEvent("info", "Player engine changed", engine);
      await this.restartPlayback();
      return;
    }
    this.recordEvent("info", "Player engine changed", engine);
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
    this.lastRuntimeStatus = "idle";
    this.timeline.set([]);
  }

  async stopPlayback(): Promise<void> {
    this.playerActive.set(false);
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
    await this.stopPlayback();
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.status.set("opening");
    this.recordEvent("info", "Playback restarted", this.selectedEngine());

    const engine = this.selectedEngine();
    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        const session = await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.MPV ? "mpv" : "vlc",
        );
        if (session) {
          this.externalSession.set(session);
        }
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

    await Promise.resolve();
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

  async takeScreenshot(): Promise<void> {
    const video = document.querySelector(
      ".direct-play-page video",
    ) as HTMLVideoElement | null;
    const embeddedCanvas = document.querySelector(
      ".direct-play-page canvas[data-embedded-mpv-frame]",
    ) as HTMLCanvasElement | null;
    if (embeddedCanvas?.width && embeddedCanvas.height) {
      const link = document.createElement("a");
      link.download = `arm-nator-frame-${Date.now()}.png`;
      link.href = embeddedCanvas.toDataURL("image/png");
      link.click();
      this.recordEvent("info", "Screenshot saved", link.download);
      return;
    }
    const embeddedSessionId = this.runtimeSnapshot()?.engine?.sessionId;
    if (
      embeddedSessionId &&
      window.electron?.takeEmbeddedMpvScreenshot &&
      window.electron?.saveFileDialog
    ) {
      const targetPath = await window.electron.saveFileDialog(
        `arm-nator-frame-${Date.now()}.png`,
        [{ name: "PNG image", extensions: ["png"] }],
      );
      if (!targetPath) {
        return;
      }
      await window.electron.takeEmbeddedMpvScreenshot(
        embeddedSessionId,
        targetPath,
      );
      this.recordEvent("info", "Screenshot saved", targetPath);
      return;
    }
    if (!video || !video.videoWidth || !video.videoHeight) {
      this.recordEvent("warning", "Screenshot unavailable");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      const link = document.createElement("a");
      link.download = `arm-nator-frame-${Date.now()}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
      this.recordEvent("info", "Screenshot saved", link.download);
    } catch (error) {
      this.recordEvent(
        "error",
        "Screenshot failed",
        error instanceof Error ? error.message : String(error),
      );
    }
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
