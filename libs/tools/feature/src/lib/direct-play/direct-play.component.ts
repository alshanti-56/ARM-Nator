import { ClipboardModule } from "@angular/cdk/clipboard";
import { DatePipe, JsonPipe, DecimalPipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
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
export class DirectPlayComponent {
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
  readonly runtimeSnapshot = signal<PlayerRuntimeSnapshot | null>(null);
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

    this.playback.set(playback);
    this.currentTime.set(0);
    this.duration.set(0);
    this.diagnostic.set(null);
    this.runtimeSnapshot.set(null);
    this.lastRuntimeStatus = "idle";
    this.timeline.set([]);
    this.errorMessage.set("");
    this.status.set("opening");
    this.recordEvent(
      "info",
      "Playback requested",
      `${this.selectedEngine()} · ${this.detectStreamType(streamUrl)}`,
    );

    const engine = this.selectedEngine();
    if (engine === VideoPlayer.MPV || engine === VideoPlayer.VLC) {
      try {
        await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.MPV ? "mpv" : "vlc",
        );
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

    this.status.set("playing");
    this.recordEvent("info", "Inline player mounted", this.selectedEngine());
  }

  async switchEngine(engine: VideoPlayer): Promise<void> {
    if (engine === this.selectedEngine()) {
      return;
    }
    this.selectedEngine.set(engine);
    if (this.playback()) {
      await this.play();
      this.recordEvent("info", "Player engine changed", engine);
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

  clear(): void {
    this.playback.set(null);
    this.status.set("ready");
    this.errorMessage.set("");
    this.currentTime.set(0);
    this.duration.set(0);
    this.diagnostic.set(null);
    this.runtimeSnapshot.set(null);
    this.lastRuntimeStatus = "idle";
    this.timeline.set([]);
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
