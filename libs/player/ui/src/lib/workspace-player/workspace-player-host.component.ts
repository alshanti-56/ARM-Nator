import { ClipboardModule } from "@angular/cdk/clipboard";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatTooltipModule } from "@angular/material/tooltip";
import { TranslatePipe } from "@ngx-translate/core";
import {
  PLAYER_ENGINES,
  PLAYER_FACADE,
  isManagedExternalPlayer,
} from "@arm-nator/player/core";
import type {
  BrowserViewBounds,
  PlayerEngineAvailability,
} from "@arm-nator/shared/interfaces";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import type { PlaybackFallbackRequest } from "../playback-diagnostics/playback-diagnostics.model";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import { WebPlayerViewComponent } from "../web-player-view/web-player-view.component";
import { hasStartedNativeSession } from "./workspace-player-native-session";
import { WorkspacePlayerStateService } from "./workspace-player-state.service";

const CODEC_ALIASES: Readonly<Record<string, string>> = {
  avc: "H.264",
  avc1: "H.264",
  av01: "AV1",
  av1: "AV1",
  h264: "H.264",
  h265: "HEVC",
  hevc: "HEVC",
  hev1: "HEVC",
  hvc1: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  theora: "Theora",
  vp08: "VP8",
  vp09: "VP9",
  vp8: "VP8",
  vp9: "VP9",
};

export interface WorkspaceNativeSupport {
  readonly supported: boolean;
  readonly reason?: string;
  readonly runtimePath?: string;
}

export interface WorkspacePlayerEngineAvailability {
  readonly id: VideoPlayer;
  readonly available: boolean;
  readonly detail: string;
}
/**
 * Native backends are independent. In particular, a working embedded MPV
 * runtime does not make KS Player selectable (or vice versa).
 */
export function getWorkspacePlayerEngineAvailability(
  engine: VideoPlayer,
  embeddedMpvSupport: WorkspaceNativeSupport | null,
  ksPlayerMetalSupport: WorkspaceNativeSupport | null,
  externalEngineAvailability: readonly PlayerEngineAvailability[] | null = null,
): WorkspacePlayerEngineAvailability {
  if (engine === VideoPlayer.EmbeddedMpv) {
    const available = embeddedMpvSupport?.supported === true;
    return {
      id: engine,
      available,
      detail: available
        ? "Available"
        : (embeddedMpvSupport?.reason ?? "Checking embedded MPV support"),
    };
  }

  if (engine === VideoPlayer.KsPlayer) {
    const available = ksPlayerMetalSupport?.supported === true;
    return {
      id: engine,
      available,
      detail: available
        ? (ksPlayerMetalSupport?.runtimePath ?? "Available")
        : (ksPlayerMetalSupport?.reason ?? "Checking KS Player support"),
    };
  }

  if (isManagedExternalPlayer(engine)) {
    if (externalEngineAvailability === null) {
      return {
        id: engine,
        available: true,
        detail: "Checking external player availability",
      };
    }

    const availability = externalEngineAvailability.find(
      (item) => item.engine === engine,
    );
    return {
      id: engine,
      available: availability?.available === true,
      detail:
        availability?.path ??
        availability?.reason ??
        "Optional external player is unavailable",
    };
  }

  return { id: engine, available: true, detail: "Available" };
}

function safeMediaLabel(value: string | undefined): string | null {
  const label = value?.trim();
  if (
    !label ||
    [...label].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || code === 0xfffd;
    })
  ) {
    return null;
  }
  return label;
}

function formatCodecLabel(codec: string | undefined): string {
  const safeCodec = safeMediaLabel(codec);
  if (safeCodec) {
    return CODEC_ALIASES[safeCodec.toLowerCase()] ?? safeCodec;
  }
  return "—";
}

function formatMediaFormat(container: string | undefined): string {
  return safeMediaLabel(container) ?? "—";
}

function formatHwdecLabel(hwdec: string | undefined): string {
  const safeHwdec = safeMediaLabel(hwdec);
  if (!safeHwdec) {
    return "—";
  }

  const normalized = safeHwdec.toLowerCase();
  if (normalized === "no") {
    return "Software";
  }
  if (normalized === "videotoolbox") {
    return "VideoToolbox";
  }
  if (normalized === "videotoolbox-copy") {
    return "VideoToolbox Copy";
  }
  return safeHwdec;
}

@Component({
  selector: "app-workspace-player-host",
  imports: [
    ClipboardModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
    WebPlayerViewComponent,
  ],
  templateUrl: "./workspace-player-host.component.html",
  styleUrl: "./workspace-player-host.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePlayerHostComponent {
  private readonly element = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly player = inject(PLAYER_FACADE);
  private readonly playerSurface =
    viewChild<ElementRef<HTMLElement>>("playerSurface");
  private lastYoutubeBounds = "";
  private readonly embeddedMpvSupport = signal<WorkspaceNativeSupport | null>(
    null,
  );
  private readonly ksPlayerMetalSupport = signal<WorkspaceNativeSupport | null>(
    null,
  );
  private readonly externalEngineAvailability = signal<
    readonly PlayerEngineAvailability[] | null
  >(null);
  private readonly metalPlaybackFailure = signal<string | null>(null);

  readonly state = inject(WorkspacePlayerStateService);
  readonly engines = PLAYER_ENGINES;
  readonly engineAvailability = computed(() =>
    this.engines.map((engine) => ({
      ...engine,
      ...getWorkspacePlayerEngineAvailability(
        engine.id,
        this.embeddedMpvSupport(),
        this.ksPlayerMetalSupport(),
        this.externalEngineAvailability(),
      ),
    })),
  );
  readonly selectedEngineBlockedReason = computed(() => {
    if (
      this.state.engine() === VideoPlayer.KsPlayer &&
      this.metalPlaybackFailure()
    ) {
      return this.metalPlaybackFailure();
    }

    const selectedEngine = this.engineAvailability().find(
      (engine) => engine.id === this.state.engine(),
    );
    return selectedEngine?.available === false ? selectedEngine.detail : null;
  });
  readonly isMini = computed(() => this.state.presentation() === "mini");
  readonly isYouTube = computed(() => this.state.youtube() !== null);
  readonly mediaTitle = computed(() => {
    const youtube = this.state.youtube();
    if (youtube) {
      return youtube.title || "YouTube";
    }
    const playback = this.state.playback();
    return playback?.title || playback?.streamUrl || "";
  });
  readonly snapshot = this.state.runtimeSnapshot;
  readonly playbackNavigation = computed<SeriesPlaybackNavigation | null>(
    () => {
      const context = this.state.context();
      if (!context || (!context.onPrevious && !context.onNext)) {
        return null;
      }
      return {
        canPrevious: context.canPrevious === true,
        canNext: context.canNext === true,
        autoplayEnabled: context.autoplayNext === true,
      };
    },
  );
  private readonly youtubeSurfaceEffect = effect((onCleanup) => {
    this.state.youtube();
    const surface = this.playerSurface()?.nativeElement;
    if (!surface || !window.electron) {
      this.lastYoutubeBounds = "";
      return;
    }

    const sync = (): void => this.syncYoutubeSurface();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    window.addEventListener("resize", sync);
    sync();

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      this.lastYoutubeBounds = "";
    });
  });
  readonly mediaSummary = computed(() => {
    const media = this.snapshot()?.media;
    if (!media) {
      return {
        resolution: "—",
        format: "—",
        codec: "—",
        hwdec: "—",
      };
    }
    return {
      resolution:
        media.width && media.height ? `${media.width}×${media.height}` : "—",
      format: formatMediaFormat(media.container),
      codec: formatCodecLabel(media.videoCodec),
      hwdec: formatHwdecLabel(media.hwdecCurrent),
    };
  });

  constructor() {
    this.loadNativeEngineSupport();
    this.loadExternalEngineAvailability();
  }

  isEngineActive(engine: VideoPlayer): boolean {
    return (
      this.state.engine() === engine &&
      this.selectedEngineBlockedReason() === null
    );
  }

  async switchEngine(engine: VideoPlayer): Promise<void> {
    const playback = this.state.playback();
    if (!playback || engine === this.state.engine()) {
      return;
    }
    if (!this.getEngineAvailability(engine).available) {
      return;
    }
    this.metalPlaybackFailure.set(null);
    if (isManagedExternalPlayer(engine)) {
      try {
        await this.player.openExternalPlayback(
          playback,
          engine === VideoPlayer.VLC ? "vlc" : "mpv",
        );
      } catch (error) {
        this.markExternalEngineUnavailable(engine, this.getErrorMessage(error));
      }
      this.state.close();
      return;
    }
    this.state.switchEngine(engine);
  }

  async openFallback(request: PlaybackFallbackRequest): Promise<void> {
    await this.player.openExternalPlayback(request.playback, request.player);
  }

  onTimeUpdate(event: { currentTime: number; duration: number }): void {
    this.state.onTimeUpdate(event);
  }

  onRuntimeSnapshot(
    snapshot: Parameters<WorkspacePlayerStateService["onRuntimeSnapshot"]>[0],
  ): void {
    if (
      this.state.engine() === VideoPlayer.KsPlayer &&
      hasStartedNativeSession(snapshot.engine, "embedded-mpv") &&
      !this.metalPlaybackFailure()
    ) {
      const reason =
        snapshot.engine?.supportReason ?? "KS Player playback failed.";
      this.metalPlaybackFailure.set(
        `${reason} Playback was stopped; embedded MPV is not used as a fallback.`,
      );
      this.state.stop();
    }
    this.state.onRuntimeSnapshot(snapshot);
  }

  private getEngineAvailability(
    engine: VideoPlayer,
  ): WorkspacePlayerEngineAvailability {
    return getWorkspacePlayerEngineAvailability(
      engine,
      this.embeddedMpvSupport(),
      this.ksPlayerMetalSupport(),
      this.externalEngineAvailability(),
    );
  }

  private loadExternalEngineAvailability(): void {
    const electron =
      typeof window === "undefined" ? undefined : window.electron;
    if (typeof electron?.getPlayerEngineAvailability !== "function") {
      this.externalEngineAvailability.set([]);
      return;
    }

    void electron
      .getPlayerEngineAvailability()
      .then((availability) => this.externalEngineAvailability.set(availability))
      .catch(() => this.externalEngineAvailability.set([]));
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

  private loadNativeEngineSupport(): void {
    if (typeof window === "undefined" || !window.electron) {
      this.embeddedMpvSupport.set({
        supported: false,
        reason: "Embedded MPV requires the Electron desktop app.",
      });
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player requires the Electron desktop app.",
      });
      return;
    }

    const electron = window.electron;
    if (typeof electron.getEmbeddedMpvSupport !== "function") {
      this.embeddedMpvSupport.set({
        supported: false,
        reason: "Embedded MPV is unavailable in this build.",
      });
    } else {
      void electron
        .getEmbeddedMpvSupport()
        .then((support) => this.embeddedMpvSupport.set(support))
        .catch((error: unknown) =>
          this.embeddedMpvSupport.set({
            supported: false,
            reason: this.getErrorMessage(error),
          }),
        );
    }

    if (typeof electron.getKsPlayerMetalSupport !== "function") {
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player is unavailable in this build.",
      });
    } else {
      void electron
        .getKsPlayerMetalSupport()
        .then((support) => this.ksPlayerMetalSupport.set(support))
        .catch((error: unknown) =>
          this.ksPlayerMetalSupport.set({
            supported: false,
            reason: this.getErrorMessage(error),
          }),
        );
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private syncYoutubeSurface(): void {
    if (!this.state.youtube() || !window.electron) {
      return;
    }

    const surface = this.playerSurface()?.nativeElement;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const bounds: BrowserViewBounds = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const key = Object.values(bounds).join(",");
    if (key === this.lastYoutubeBounds) {
      return;
    }
    this.lastYoutubeBounds = key;
    void window.electron.setBrowserViewBounds(bounds, "youtube-mini");
  }
}
