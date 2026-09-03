import {
  Component,
  ElementRef,
  input,
  OnChanges,
  OnDestroy,
  OnInit,
  output,
  signal,
  SimpleChanges,
  viewChild,
} from "@angular/core";
import Artplayer from "artplayer";
import type { Option } from "artplayer";
import artplayerPluginHlsControl from "artplayer-plugin-hls-control";
import Hls, { type ErrorData } from "hls.js";
import type { Channel } from "@arm-nator/shared/interfaces";
import {
  DEFAULT_ASPECT_PRESETS,
  DEFAULT_PICTURE_SETTINGS,
  DEFAULT_SPEED_PRESETS,
  DEFAULT_SUBTITLE_SETTINGS,
  type PlayerControlsCapabilities,
  type PlayerControlsState,
  type PlayerMediaTelemetry,
  type PlayerMediaTitle,
  type PlayerRuntimeSnapshot,
} from "../player-controls";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import {
  classifyHlsPlaybackIssue,
  classifyNativePlaybackIssue,
  createPlaybackSourceMetadata,
  InlinePlaybackPlayer,
  type PlaybackDiagnostic,
} from "../playback-diagnostics/playback-diagnostics.util";
import {
  ArtPlayer2VodTransport,
  type ArtPlayer2VodSourceMode,
} from "./art-player2-vod-transport";
import { seekVideoToLiveEdge } from "../web-video-support/live-edge-resume";

type ArtplayerWithHls = Artplayer & { hls?: Hls };

interface BufferMetrics {
  bufferedSeconds: number;
  bufferAheadSeconds: number;
}

/**
 * The stock ArtPlayer 5.4.0 lane with an isolated VOD transport wrapper.
 *
 * It intentionally uses ArtPlayer's own controls and HLS.js adapter instead
 * of the application's customized ArtPlayer source/recovery sessions. The
 * VOD wrapper only supplies a browser-compatible URL and does not modify
 * ArtPlayer's controls or import the legacy player components.
 */
@Component({
  selector: "app-art-player2",
  imports: [],
  templateUrl: "./art-player2.component.html",
  styleUrls: ["./art-player2.component.scss"],
})
export class ArtPlayer2Component implements OnInit, OnChanges, OnDestroy {
  readonly channel = input.required<Channel>();
  readonly volume = input(1);
  readonly showCaptions = input(false);
  readonly startTime = input(0);
  readonly seriesNavigation = input<SeriesPlaybackNavigation | null>(null);
  readonly isLive = input(true);
  readonly interactionEnabled = input(true);
  readonly mediaTitle = input<PlayerMediaTitle | null>(null);
  readonly requestHeaders = input<Record<string, string>>({});
  readonly onlineSubtitleUrl = input("");
  readonly onlineSubtitleLabel = input("Online subtitle");
  readonly onlineSubtitleLanguage = input("und");

  readonly timeUpdate = output<{
    currentTime: number;
    duration: number;
  }>();
  readonly playbackIssue = output<PlaybackDiagnostic | null>();
  readonly runtimeSnapshotChange = output<PlayerRuntimeSnapshot>();
  readonly playbackEnded = output<void>();
  readonly previousEpisodeRequested = output<void>();
  readonly nextEpisodeRequested = output<void>();

  readonly playerRoot = viewChild<ElementRef<HTMLElement>>("playerRoot");
  private readonly artplayerContainer =
    viewChild.required<ElementRef<HTMLDivElement>>("artplayer");
  private player: Artplayer | null = null;
  private hls: Hls | null = null;
  private hlsArt: ArtplayerWithHls | null = null;
  private readonly vodTransport = new ArtPlayer2VodTransport();
  private vodSource: {
    mode: ArtPlayer2VodSourceMode;
    url: string;
    sourceUrl: string;
    headers: Record<string, string>;
  } | null = null;
  private vodFallbackAttempted = false;
  private vodFallbackInFlight = false;
  private lastObservedTime = 0;
  private stallTimer: number | null = null;
  private resumeAfterStall = false;
  private resumeAtLiveEdgePending = false;
  private sourceGeneration = 0;
  private destroyed = false;
  readonly bufferReadout = signal("Buffer —");
  private bufferTimer: number | null = null;
  private readonly nativeListeners: Array<readonly [string, EventListener]> =
    [];

  ngOnInit(): void {
    void this.initPlayer();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const channelChanged =
      changes["channel"] && !changes["channel"].firstChange;
    const liveChanged =
      changes["isLive"] &&
      !changes["isLive"].firstChange &&
      changes["isLive"].previousValue !== changes["isLive"].currentValue;
    if (channelChanged || liveChanged) {
      this.restartPlayer();
      return;
    }

    if (changes["volume"]?.currentValue !== undefined) {
      this.applyVolume(changes["volume"].currentValue);
    }

    if (changes["interactionEnabled"]) {
      this.playerRoot()?.nativeElement.classList.toggle(
        "art-player2-shell--interaction-disabled",
        !this.interactionEnabled(),
      );
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.sourceGeneration += 1;
    this.destroyPlayer();
  }

  private async initPlayer(): Promise<void> {
    const generation = ++this.sourceGeneration;
    const channel = this.channel();
    this.playbackIssue.emit(null);
    const originalUrl = channel.url;
    const isHls = this.isHlsSource(originalUrl);
    let sourceUrl = originalUrl;
    const headers = this.getRequestHeaders();

    this.destroyPlayer();
    if (this.destroyed) {
      return;
    }

    this.vodSource = null;
    this.vodFallbackAttempted = false;
    this.vodFallbackInFlight = false;
    this.lastObservedTime = 0;
    this.resumeAfterStall = false;
    this.resumeAtLiveEdgePending = false;

    if (!this.isLive() && !isHls) {
      const source = await this.vodTransport.prepare(
        originalUrl,
        headers,
        () => !this.destroyed && generation === this.sourceGeneration,
      );
      if (this.destroyed || generation !== this.sourceGeneration) {
        return;
      }
      sourceUrl = source.url;
      this.vodSource = {
        ...source,
        sourceUrl: originalUrl,
        headers,
      };
    }

    if (this.destroyed || generation !== this.sourceGeneration) {
      return;
    }

    this.createPlayer(sourceUrl, isHls);
  }

  private createPlayer(sourceUrl: string, isHls: boolean): void {
    const options: Option = {
      container: this.artplayerContainer().nativeElement,
      url: sourceUrl,
      isLive: this.isLive(),
      autoplay: true,
      autoPlayback: false,
      volume: this.clampVolume(this.volume()),
      setting: true,
      playbackRate: true,
      aspectRatio: true,
      fullscreen: true,
      fullscreenWeb: true,
      pip: true,
      hotkey: true,
      playsInline: true,
      mutex: true,
      backdrop: true,
      customType: {
        m3u8: (video, url, art) => this.startHls(video, url, art),
      },
      plugins: isHls
        ? [
            artplayerPluginHlsControl({
              quality: {
                control: true,
                setting: true,
                title: "Quality",
                auto: "Auto",
                getName: (level: object) => {
                  const item = level as { height?: number; name?: string };
                  return item.height
                    ? `${item.height}P`
                    : (item.name ?? "Auto");
                },
              },
              audio: {
                control: true,
                setting: true,
                title: "Audio",
                auto: "Auto",
                getName: (track: object) => {
                  const item = track as {
                    name?: string;
                    lang?: string;
                    language?: string;
                  };
                  return item.name ?? item.lang ?? item.language ?? "Audio";
                },
              },
            }),
          ]
        : [],
    };

    const player = new Artplayer(options);
    this.player = player;
    this.bindNativeEvents(player.video);
    this.bufferTimer = window.setInterval(() => {
      const video = player.video;
      const metrics = this.readBufferMetrics(video);
      this.updateBufferReadout(video, metrics);
      if (!video.paused) {
        this.emitRuntimeSnapshot(video, metrics);
      }
    }, 1000);
    player.on("ready", () => {
      this.applyStartTime();
      this.emitRuntimeSnapshot();
    });
    this.applyVolume(this.volume());
  }

  private startHls(video: HTMLVideoElement, url: string, art: Artplayer): void {
    this.destroyHls();

    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
      } else {
        art.notice.show = "Unsupported playback format: m3u8";
      }
      return;
    }

    const hls = new Hls();
    const artWithHls = art as ArtplayerWithHls;
    this.hls = hls;
    this.hlsArt = artWithHls;
    artWithHls.hls = hls;

    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data: ErrorData) => {
      this.handleHlsError(hls, url, data);
    });
    hls.loadSource(url);
  }

  private bindNativeEvents(video: HTMLVideoElement): void {
    const onTimeUpdate: EventListener = () => {
      if (Number.isFinite(video.currentTime)) {
        this.lastObservedTime = video.currentTime;
      }
      this.timeUpdate.emit({
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
      this.updateBufferReadout(video, this.readBufferMetrics(video));
    };
    const onSeeking: EventListener = () => {
      if (Number.isFinite(video.currentTime)) {
        this.lastObservedTime = video.currentTime;
      }
      this.scheduleStallRecovery(video);
      this.emitRuntimeSnapshot(video);
    };
    const onError: EventListener = () => {
      void this.handleNativeError(video);
    };
    const onWaiting: EventListener = () => {
      this.resumeAfterStall ||= !video.paused;
      this.scheduleStallRecovery(video);
      this.emitRuntimeSnapshot(video);
    };
    const onStalled: EventListener = () => {
      this.resumeAfterStall ||= !video.paused;
      this.scheduleStallRecovery(video);
      this.emitRuntimeSnapshot(video);
    };
    const onPlaying: EventListener = () => {
      this.resumeAfterStall = false;
      this.clearStallTimer();
      this.emitRuntimeSnapshot(video);
    };
    const onPlay: EventListener = () => {
      if (!this.isLive() || !this.resumeAtLiveEdgePending) {
        return;
      }
      this.resumeAtLiveEdgePending = false;
      seekVideoToLiveEdge(video, this.hls?.liveSyncPosition);
    };
    const onPause: EventListener = () => {
      this.resumeAtLiveEdgePending = this.isLive();
      this.emitRuntimeSnapshot(video);
    };
    const onEnded: EventListener = () => {
      this.playbackEnded.emit();
      this.emitRuntimeSnapshot(video);
    };

    for (const [event, listener] of [
      ["timeupdate", onTimeUpdate],
      ["seeking", onSeeking],
      ["error", onError],
      ["waiting", onWaiting],
      ["stalled", onStalled],
      ["play", onPlay],
      ["playing", onPlaying],
      ["pause", onPause],
      ["ended", onEnded],
    ] as const) {
      video.addEventListener(event, listener);
      this.nativeListeners.push([event, listener]);
    }
  }

  private applyStartTime(): void {
    const player = this.player;
    const startTime = Number(this.startTime());
    if (
      !player ||
      this.isLive() ||
      !Number.isFinite(startTime) ||
      startTime <= 0
    ) {
      return;
    }

    const duration = player.duration;
    const target = Number.isFinite(duration)
      ? Math.min(startTime, Math.max(0, duration - 0.1))
      : startTime;
    player.currentTime = target;
  }

  private destroyPlayer(): void {
    for (const [event, listener] of this.nativeListeners.splice(0)) {
      this.player?.video.removeEventListener(event, listener);
    }
    if (this.bufferTimer !== null) {
      window.clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
    this.bufferReadout.set("Buffer —");
    this.clearStallTimer();
    this.destroyHls();
    this.player?.destroy();
    this.player = null;
    this.vodTransport.release();
    this.vodSource = null;
    this.vodFallbackInFlight = false;
    this.resumeAtLiveEdgePending = false;
  }

  private destroyHls(): void {
    this.hls?.destroy();
    if (this.hlsArt?.hls === this.hls) {
      delete this.hlsArt.hls;
    }
    this.hls = null;
    this.hlsArt = null;
  }

  private restartPlayer(): void {
    this.sourceGeneration += 1;
    this.destroyPlayer();
    void this.initPlayer();
  }

  private async handleNativeError(video: HTMLVideoElement): Promise<void> {
    const vodSource = this.vodSource;
    const canFallbackToProxy =
      !this.destroyed &&
      !this.isLive() &&
      vodSource?.mode === "direct" &&
      !this.vodFallbackAttempted &&
      !this.vodFallbackInFlight;

    if (canFallbackToProxy && vodSource) {
      this.vodFallbackAttempted = true;
      this.vodFallbackInFlight = true;
      const targetTime =
        Number.isFinite(video.currentTime) && video.currentTime > 0.5
          ? video.currentTime
          : this.lastObservedTime;
      const shouldResume = this.resumeAfterStall || !video.paused;

      try {
        const fallback = await this.vodTransport.fallbackToProxy(
          vodSource.sourceUrl,
          vodSource.headers,
          () => !this.destroyed,
        );
        if (this.destroyed || !this.player || this.player.video !== video) {
          return;
        }

        if (fallback?.mode !== "proxy") {
          // The fallback transport may be unavailable. Let the normal
          // diagnostic path below report the original native failure.
        } else {
          this.vodSource = {
            ...fallback,
            sourceUrl: vodSource.sourceUrl,
            headers: vodSource.headers,
          };
          video.preload = "auto";
          video.src = fallback.url;
          video.addEventListener(
            "loadedmetadata",
            () => {
              if (targetTime > 0 && Number.isFinite(video.duration)) {
                video.currentTime = Math.min(
                  targetTime,
                  Math.max(0, video.duration - 0.1),
                );
              }
              if (shouldResume) {
                void video.play().catch(() => undefined);
              }
            },
            { once: true },
          );
          video.load();
          return;
        }
      } finally {
        this.vodFallbackInFlight = false;
      }
    }

    if (this.destroyed || !this.player || this.player.video !== video) {
      return;
    }
    this.playbackIssue.emit(
      classifyNativePlaybackIssue(
        video.error,
        createPlaybackSourceMetadata({
          url: vodSource?.sourceUrl ?? this.channel().url,
          mimeType: video.currentSrc.includes(".m3u8")
            ? "application/x-mpegURL"
            : "video/mp4",
          player: InlinePlaybackPlayer.ArtPlayer,
        }),
      ),
    );
    this.emitRuntimeSnapshot(video);
  }

  private handleHlsError(hls: Hls, url: string, data: ErrorData): void {
    if (this.hls !== hls || !data.fatal) {
      return;
    }
    this.playbackIssue.emit(
      classifyHlsPlaybackIssue(
        {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          message: data.error?.message,
          error: data.error,
        },
        createPlaybackSourceMetadata({
          url,
          mimeType: "application/x-mpegURL",
          player: InlinePlaybackPlayer.ArtPlayer,
        }),
      ),
    );
    this.emitRuntimeSnapshot(this.player?.video);
  }

  private scheduleStallRecovery(video: HTMLVideoElement): void {
    if (
      this.isLive() ||
      this.vodSource?.mode !== "direct" ||
      this.vodFallbackAttempted ||
      this.vodFallbackInFlight
    ) {
      return;
    }

    this.clearStallTimer();
    this.stallTimer = window.setTimeout(() => {
      this.stallTimer = null;
      void this.handleNativeError(video);
    }, 3000);
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      window.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private getRequestHeaders(): Record<string, string> {
    const channel = this.channel();
    const headers = { ...this.requestHeaders() };
    const channelHeaders = {
      "User-Agent": channel.http["user-agent"],
      Referer: channel.http.referrer,
      Origin: channel.http.origin,
    };
    for (const [name, value] of Object.entries(channelHeaders)) {
      if (
        value &&
        !Object.keys(headers).some(
          (existing) => existing.toLowerCase() === name.toLowerCase(),
        )
      ) {
        headers[name] = value;
      }
    }
    return headers;
  }

  private applyVolume(value: number): void {
    const video = this.player?.video;
    if (!video) {
      return;
    }
    const volume = this.clampVolume(value);
    video.volume = volume;
    video.muted = volume <= 0;
  }

  private readBufferMetrics(video: HTMLVideoElement): BufferMetrics {
    const currentTime = video.currentTime;
    let bufferedSeconds = 0;
    let bufferAheadSeconds = 0;
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        const start = video.buffered.start(index);
        const end = video.buffered.end(index);
        bufferedSeconds += Math.max(0, end - start);
        if (
          Number.isFinite(currentTime) &&
          currentTime >= start &&
          currentTime <= end
        ) {
          bufferAheadSeconds = Math.max(0, end - currentTime);
        }
      }
    } catch {
      // Media ranges can change while being read.
    }
    return { bufferedSeconds, bufferAheadSeconds };
  }

  private updateBufferReadout(
    video = this.player?.video,
    metrics?: BufferMetrics,
  ): void {
    if (!video || !Number.isFinite(video.currentTime)) {
      this.bufferReadout.set("Buffer —");
      return;
    }

    const bufferAheadSeconds =
      metrics?.bufferAheadSeconds ?? this.readBufferMetrics(video).bufferAheadSeconds;
    const nextReadout = `Buffer ${Math.floor(bufferAheadSeconds)}s`;
    if (this.bufferReadout() !== nextReadout) {
      this.bufferReadout.set(nextReadout);
    }
  }

  private emitRuntimeSnapshot(
    video = this.player?.video,
    metrics?: BufferMetrics,
  ): void {
    if (!video) {
      return;
    }

    const isLive = this.isLive();
    const duration =
      Number.isFinite(video.duration) && video.duration > 0
        ? video.duration
        : null;
    const bufferMetrics = metrics ?? this.readBufferMetrics(video);

    const status: PlayerControlsState["status"] = video.error
      ? "error"
      : video.ended
        ? "ended"
        : video.paused
          ? "paused"
          : video.readyState < 3
            ? "loading"
            : "playing";
    const capabilities: PlayerControlsCapabilities = {
      seek: !isLive && duration !== null && video.readyState >= 1,
      volume: true,
      audioTracks: false,
      subtitles: false,
      playbackSpeed: true,
      aspectRatio: true,
      fullscreen: true,
      seriesNavigation: this.seriesNavigation() !== null,
      stop: true,
      restart: true,
      frameStep: false,
      pictureAdjustments: false,
    };
    const state: PlayerControlsState = {
      status,
      statusMessage: "",
      stalled: status === "loading" && !video.paused && !video.ended,
      positionSeconds: Number.isFinite(video.currentTime)
        ? Math.max(0, video.currentTime)
        : 0,
      durationSeconds: duration,
      isLive,
      canSeek: capabilities.seek,
      volume: this.clampVolume(video.volume),
      audioTracks: [],
      subtitleTracks: [],
      subtitlesEnabled: false,
      playbackSpeed: video.playbackRate,
      speedPresets: DEFAULT_SPEED_PRESETS,
      aspectRatio: "no",
      aspectPresets: DEFAULT_ASPECT_PRESETS,
      picture: DEFAULT_PICTURE_SETTINGS,
      subtitle: DEFAULT_SUBTITLE_SETTINGS,
      canPreviousEpisode: this.seriesNavigation()?.canPrevious === true,
      canNextEpisode: this.seriesNavigation()?.canNext === true,
    };
    const quality = video.getVideoPlaybackQuality?.();
    const media: PlayerMediaTelemetry = {
      sourceKind: this.isHlsSource(this.channel().url) ? "hls" : "native",
      resolvedUrl: video.currentSrc || undefined,
      width: video.videoWidth || undefined,
      height: video.videoHeight || undefined,
      bufferedSeconds: bufferMetrics.bufferedSeconds,
      bufferAheadSeconds: bufferMetrics.bufferAheadSeconds,
      droppedFrames: quality?.droppedVideoFrames,
      totalFrames: quality?.totalVideoFrames,
      eofReason: video.ended ? "media-element-ended" : undefined,
    };
    this.runtimeSnapshotChange.emit({
      state,
      capabilities,
      media,
      engine: {
        engine: "artplayer2",
        available: true,
        sessionStatus: state.status,
      },
    });
  }

  private isHlsSource(url: string): boolean {
    return /\.m3u8(?:[?#]|$)/i.test(url);
  }

  private clampVolume(value: number): number {
    const numericValue = Number(value);
    return Number.isFinite(numericValue)
      ? Math.max(0, Math.min(1, numericValue))
      : 1;
  }
}
