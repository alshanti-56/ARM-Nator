import { toAbsolutePlaybackPosition, toAbsolutePlaybackDuration, toLocalPlaybackPosition } from '../player-controls/playback-timeline';
import {
  Component,
  ElementRef,
  EventEmitter,
  effect,
  inject,
  input,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  viewChild,
  ViewChild,
  signal,
  ChangeDetectionStrategy
} from "@angular/core";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import { Channel, createDevLogger } from "@arm-nator/shared/interfaces";
import {
  classifyHlsPlaybackIssue,
  createPlaybackSourceMetadata,
  InlinePlaybackPlayer,
  PlaybackDiagnostic,
  getPlaybackMediaExtensionFromUrl,
} from "../playback-diagnostics/playback-diagnostics.util";
import { readBrowserPlaybackEvidence } from "../playback-diagnostics/playback-evidence";
import {
  PlayerControlsComponent,
  type PlayerMediaTitle,
  type PlayerRuntimeSnapshot,
  WebVideoControlsAdapter,
} from "../player-controls";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import { ShakaVideoSession } from "../shaka-engine/shaka-video-session";
import { exitOwnedFullscreen } from "../web-video-support/exit-owned-fullscreen.util";
import {
  clearNativeVideoSources,
  setNativeVideoSource,
} from "../web-video-support/web-video-native-source.util";
import {
  getNativeMediaMimeType,
  shouldUseHls,
  shouldUseMpegTs,
} from "../web-video-support/web-video-source-selection";
import {
  getPreparedProxyMediaExtension,
  getPreparedProxyMimeType,
} from "../web-video-support/prepared-proxy-source.util";
import { createMpegTsConfig } from "../web-video-support/mpegts-live-recovery";
import { syncOnlineSubtitleTrack } from "../web-video-support/online-subtitle-track";
import { ProgressiveVodProxySession } from "../web-video-support/progressive-vod-proxy-session";
import { MpegTsProxySession } from "../web-video-support/mpegts-proxy-session";
import { HlsProxySession } from "../web-video-support/hls-proxy-session";
import { HtmlVideoElementSession } from "./html-video-element-session";
import { HtmlVideoLiveController } from "./html-video-live-controller";
import { WorkspacePlayerStateService } from "../workspace-player/workspace-player-state.service";
import { awaitPlaybackTeardowns } from "../workspace-player/playback-teardown-registry";
import {
  HtmlVideoPlayerControlsBridge,
  type HtmlVideoControlsSource,
} from "./html-video-player-controls.bridge";

const debugHtmlPlayer = createDevLogger("HtmlVideoPlayer");

/**
 * This component contains the implementation of HTML5 based video player
 */
@Component({
  selector: "app-html-video-player",
  templateUrl: "./html-video-player.component.html",
  styleUrls: ["./html-video-player.component.scss"],
  imports: [PlayerControlsComponent],
  providers: [WebVideoControlsAdapter],
  changeDetection: ChangeDetectionStrategy.Eager,
  standalone: true,
})
export class HtmlVideoPlayerComponent implements OnInit, OnChanges, OnDestroy {
  /** Channel to play  */
  @Input() channel!: Channel;
  @Input() volume = 1;
  @Input() startTime = 0;
  @Input() seekOverride: ((absoluteSeconds: number) => void) | null = null;
  @Input() timelineOffsetSeconds = 0;
  @Input() durationSeconds: number | null = null;
  @Input() seriesNavigation: SeriesPlaybackNavigation | null = null;
  readonly isLive = input(true);
  readonly interactionEnabled = input(true);
  readonly showCaptions = input(false);
  readonly mediaTitle = input<PlayerMediaTitle | null>(null);
  readonly onlineSubtitleUrl = input("");
  readonly onlineSubtitleLabel = input("Online subtitle");
  readonly onlineSubtitleLanguage = input("und");
  @Output() timeUpdate = new EventEmitter<{
    currentTime: number;
    duration: number;
  }>();
  @Output() playbackIssue = new EventEmitter<PlaybackDiagnostic | null>();
  @Output() playbackEnded = new EventEmitter<void>();
  @Output() previousEpisodeRequested = new EventEmitter<void>();
  @Output() nextEpisodeRequested = new EventEmitter<void>();
  @Output() runtimeSnapshotChange = new EventEmitter<PlayerRuntimeSnapshot>();

  readonly controlsAdapter = inject(WebVideoControlsAdapter);
  private readonly unregisterPlaybackTeardown = inject(
    WorkspacePlayerStateService,
  ).registerPlaybackTeardown(() => this.teardownPlayback(), {
    repeatable: true,
  });
  private readonly runtimeSnapshotEffect = effect(() => {
    const state = this.controlsAdapter.state();
    const capabilities = this.controlsAdapter.capabilities();
    const media = this.controlsAdapter.mediaTelemetry();
    this.runtimeSnapshotChange.emit({
      state,
      capabilities,
      media: {
        ...media,
        ...readBrowserPlaybackEvidence(
          this.videoPlayer?.nativeElement,
        ),
      },
      engine: {
        engine: "html5",
        available: true,
        sessionStatus: state.status,
      },
    });
  });
  private readonly seriesNavigationSignal =
    signal<SeriesPlaybackNavigation | null>(null);

  /** Video player DOM element */
  readonly playerRoot = viewChild<ElementRef<HTMLElement>>("playerRoot");

  @ViewChild("videoPlayer", { static: true })
  videoPlayer!: ElementRef<HTMLVideoElement>;

  /** mpegts.js player for raw MPEG-TS streams */
  private mpegtsPlayer: mpegts.Player | null = null;
  private mpegtsUrl = "";
  private readonly liveController = new HtmlVideoLiveController({
    getVideo: () => this.videoPlayer.nativeElement,
    getSourceUrl: () => this.channel?.url,
    getPreparedProxy: () => this.channel?.http?.preparedProxy,
    getRequestPolicy: () => this.channel?.http?.requestPolicy,
    isDirect: () => this.channel?.http?.direct === true,
    isLive: () => this.isLive(),
    providerRecovery: () => this.channel?.http?.providerRecovery === true,
    getSourceKind: () => this.controlsSource?.kind ?? null,
    restartMpegTs: () => this.restartMpegTsAfterDisconnect(),
    bindControlsSource: (source) => this.bindControlsSource(source),
    clearControlsSource: () => this.clearControlsSource(),
    play: () => this.handlePlayOperation(),
    emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
  });
  private playbackIntent: 'play' | 'pause' | null = null;
  private readonly unregisterPlaybackIntentListener =
    this.controlsAdapter.registerPlaybackIntentListener((intent) => {
      this.playbackIntent = intent;
      this.liveController.handlePlaybackIntent(intent);
    });
  /** Shaka session for DASH (.mpd) streams, created on first use */
  private shakaSession: ShakaVideoSession | null = null;
  private controlsSource: HtmlVideoControlsSource | null = null;
  private controlsBridge: HtmlVideoPlayerControlsBridge | null = null;
  private videoSession: HtmlVideoElementSession | null = null;
  private readonly progressiveVodProxy = new ProgressiveVodProxySession();
  private readonly mpegTsProxy = new MpegTsProxySession();
  private readonly nativeHlsProxy = new HlsProxySession();
  private mpegTsRequestHeaders: Record<string, string> = {};
  private sourceGeneration = 0;
  private teardownInFlight: Promise<void> | null = null;
  private destroyed = false;

  ngOnInit() {
    this.syncOnlineSubtitle();
    this.seriesNavigationSignal.set(this.seriesNavigation);
    this.controlsAdapter.setContext({
      seriesNavigation: this.seriesNavigationSignal,
      getTimelineOffsetSeconds: () => this.timelineOffsetSeconds,
      getReportedDurationSeconds: () => this.durationSeconds,
      ...(this.seekOverride ? { onTimelineSeek: (seconds: number) => this.seekOverride?.(seconds) } : {}),
    });
    this.controlsBridge = new HtmlVideoPlayerControlsBridge({
      video: this.videoPlayer.nativeElement,
      adapter: this.controlsAdapter,
      isLive: () => this.isLive(),
      showCaptions: () => this.showCaptions(),
    });
    this.controlsBridge.attach();
    if (this.controlsSource) {
      this.bindControlsSource(this.controlsSource);
    }
    this.getVideoSession().attach();
    this.videoPlayer.nativeElement.addEventListener(
      "ended",
      this.handleMpegTsEnded,
    );
  }

  /**
   * Listen for component input changes
   * @param changes component changes
   */
  ngOnChanges(changes: SimpleChanges): void {
    if (changes["seriesNavigation"]) {
      this.seriesNavigationSignal.set(this.seriesNavigation);
    }
    if (changes["channel"] && changes["channel"].currentValue) {
      this.playChannel(changes["channel"].currentValue);
    }
    if (changes["isLive"] || changes["showCaptions"]) {
      this.controlsBridge?.refreshInputs();
    }
    if (
      changes["onlineSubtitleUrl"] ||
      changes["onlineSubtitleLabel"] ||
      changes["onlineSubtitleLanguage"]
    ) {
      this.syncOnlineSubtitle();
      this.controlsBridge?.refreshInputs();
    }
    if (changes["interactionEnabled"]?.currentValue === false) {
      exitOwnedFullscreen(this.playerRoot()?.nativeElement, (error) =>
        debugHtmlPlayer("Failed to exit HTML5 player fullscreen:", error),
      );
    }
    if (changes["volume"]?.currentValue !== undefined) {
      debugHtmlPlayer(
        "Setting HTML5 player volume to:",
        changes["volume"].currentValue,
      );
      this.videoPlayer.nativeElement.volume = changes["volume"].currentValue;
    }
  }

  /**
   * Starts to play the given channel
   * @param channel given channel object
   */
  playChannel(channel: Channel): void {
    const teardown = this.teardownPlayback();
    const sourceGeneration = this.sourceGeneration;
    void teardown
      .then(() => {
        if (!this.destroyed && sourceGeneration === this.sourceGeneration) {
          this.startChannel(channel, sourceGeneration);
        }
      })
      .catch((error: unknown) =>
        debugHtmlPlayer("Unable to stop the previous source:", error),
      );
  }

  private startChannel(channel: Channel, sourceGeneration: number): void {
    this.playbackIntent = channel.http.startPaused ? 'pause' : null;
    this.syncOnlineSubtitle();
    if (channel.url) {
      this.playbackIssue.emit(null);
      const url = channel.url;
      const preparedProxy = channel.http.preparedProxy;
      const extension =
        getPreparedProxyMediaExtension(preparedProxy) ??
        getPlaybackMediaExtensionFromUrl(channel.url);
      const nativeMimeType =
        getPreparedProxyMimeType(preparedProxy) ??
        getNativeMediaMimeType(extension);

      void window.electron
        ?.setUserAgent?.(
          channel.http?.["user-agent"],
          channel.http?.referrer,
          channel.url,
        )
        .catch((error: unknown) => {
          console.warn(
            "[HtmlVideoPlayer] Failed to configure Electron request headers:",
            error,
          );
        });

      if (extension === "mpd") {
        debugHtmlPlayer(
          "Using Shaka Player for DASH stream:",
          channel.name,
          url,
        );
        const session = this.getShakaSession();
        this.bindControlsSource({ kind: "shaka", session });
        session.start(this.videoPlayer.nativeElement, url, channel.drm, {
          headers: this.getRequestHeaders(channel), requestPolicy: channel.http.requestPolicy,
          preparedProxy, direct: channel.http.direct, providerRecovery: channel.http.providerRecovery,
        });
        if (channel.drm && !channel.drm.supported) {
          // No source is loaded for unsupported DRM; reset the
          // element so the previous stream cannot resume playing
          // underneath the diagnostic banner.
          this.videoPlayer.nativeElement.load();
        } else {
          this.handlePlayOperation();
        }
      } else if (shouldUseMpegTs(extension) && mpegts.isSupported()) {
        debugHtmlPlayer("Using mpegts.js for TS stream:", channel.name, url);
        this.mpegtsUrl = url;
        this.mpegTsRequestHeaders = this.getRequestHeaders(channel);
        const currentGeneration = sourceGeneration;
        void this.mpegTsProxy
          .load(
            url,
            this.mpegTsRequestHeaders,
            () =>
              currentGeneration === this.sourceGeneration &&
              this.mpegtsUrl === url,
            this.isLive(),
            preparedProxy,
            channel.http.requestPolicy,
            channel.http.direct,
          )
          .then((playbackUrl) => {
            if (
              currentGeneration !== this.sourceGeneration ||
              this.mpegtsUrl !== url
            ) {
              return;
            }
            this.openMpegTsPlayer(playbackUrl, url);
          })
          .catch((error: unknown) => {
            if (
              currentGeneration !== this.sourceGeneration ||
              this.mpegtsUrl !== url
            ) {
              return;
            }
            this.liveController.handleMpegTsError(url, {
              type: "network",
              details: "MPEG-TS proxy initialization failed.",
              info: error,
            });
          });
      } else if (shouldUseHls(extension) && Hls.isSupported()) {
        debugHtmlPlayer("Using hls.js for stream:", channel.name, url);
        this.liveController.openHls(url, this.getRequestHeaders(channel));
      } else {
        debugHtmlPlayer("Using native video player");
        this.syncOnlineSubtitle();
        this.bindControlsSource({ kind: "native" });
        const setSource = (sourceUrl: string): void => {
          setNativeVideoSource(
            this.videoPlayer.nativeElement,
            sourceUrl,
            nativeMimeType,
          );
        };
        if (shouldUseHls(extension)) {
          void this.nativeHlsProxy
            .load(
              { loadSource: setSource },
              url,
              this.getRequestHeaders(channel),
              () => this.sourceGeneration === sourceGeneration,
              preparedProxy,
              channel.http.requestPolicy,
              channel.http.direct,
            )
            .then((loaded) => {
              if (this.sourceGeneration !== sourceGeneration) {
                return;
              }
              if (!loaded) {
                this.playbackIssue.emit(
                  classifyHlsPlaybackIssue(
                    {
                      type: "networkError",
                      details: "Electron HLS proxy initialization failed.",
                      fatal: true,
                    },
                    createPlaybackSourceMetadata({
                      url,
                      mimeType: "application/x-mpegURL",
                      player: InlinePlaybackPlayer.Html5,
                    }),
                  ),
                );
                return;
              }
              this.videoPlayer.nativeElement.load();
              this.handlePlayOperation();
            })
            .catch((error: unknown) => {
              debugHtmlPlayer("Unable to load the native HLS proxy:", error);
              if (this.sourceGeneration === sourceGeneration) {
                this.playbackIssue.emit(
                  classifyHlsPlaybackIssue(
                    {
                      type: "networkError",
                      details: "Electron HLS proxy initialization failed.",
                      fatal: true,
                      error,
                    },
                    createPlaybackSourceMetadata({
                      url,
                      mimeType: "application/x-mpegURL",
                      player: InlinePlaybackPlayer.Html5,
                    }),
                  ),
                );
              }
            });
        } else if (
          !this.isLive() &&
          (extension === "mp4" || preparedProxy?.format === "progressive")
        ) {
          void this.progressiveVodProxy
            .load(
              { setSource },
              url,
              {
                ...this.getRequestHeaders(channel),
              },
              () => this.sourceGeneration === sourceGeneration,
              preparedProxy,
              channel.http.requestPolicy,
              channel.http.direct,
            )
            .then((loaded) => {
              if (!loaded || this.sourceGeneration !== sourceGeneration) {
                return;
              }
              this.videoPlayer.nativeElement.load();
              this.handlePlayOperation();
            })
            .catch((error: unknown) => {
              debugHtmlPlayer("Unable to load the progressive VOD proxy:", error);
            });
        } else {
          setSource(url);
          this.videoPlayer.nativeElement.load();
          this.handlePlayOperation();
        }
      }
    }
  }

  private bindControlsSource(source: HtmlVideoControlsSource): void {
    this.controlsSource = source;
    this.controlsBridge?.setSource(source);
  }

  private clearControlsSource(): void {
    this.controlsBridge?.clearSource();
    this.controlsSource = null;
  }

  private syncOnlineSubtitle(): void {
    if (!this.videoPlayer?.nativeElement) {
      return;
    }
    syncOnlineSubtitleTrack(this.videoPlayer.nativeElement, {
      url: this.onlineSubtitleUrl(),
      label: this.onlineSubtitleLabel(),
      language: this.onlineSubtitleLanguage(),
    });
  }

  private destroyMpegtsPlayer(preserveRecovery = false): void {
    if (!preserveRecovery) {
      this.mpegTsProxy.release();
      this.liveController.resetMpegTsRecovery();
      this.mpegtsUrl = "";
      this.mpegTsRequestHeaders = {};
    }
    const player = this.mpegtsPlayer;
    this.mpegtsPlayer = null;
    if (!player) {
      return;
    }
    player.pause();
    player.unload();
    player.detachMediaElement();
    player.destroy();
  }

  private openMpegTsPlayer(url: string, sourceUrl = url): void {
    const isLive = this.isLive();
    const directHeaders =
      this.mpegTsProxy.currentUrl === url
        ? undefined
        : this.mpegTsRequestHeaders;
    const player = mpegts.createPlayer(
      {
        type: "mpegts",
        isLive,
        url,
      },
      {
        ...createMpegTsConfig(isLive),
        ...(directHeaders ? { headers: directHeaders } : {}),
      },
    );
    this.mpegtsPlayer = player;
    player.attachMediaElement(this.videoPlayer.nativeElement);
    this.bindControlsSource({ kind: "mpegts" });
    player.on(
      mpegts.Events.ERROR,
      (type: string, details: string, info: unknown): void => {
        if (this.mpegtsPlayer !== player) {
          return;
        }
        this.liveController.handleMpegTsError(sourceUrl, {
          type,
          details,
          info,
        });
      },
    );
    player.load();
    this.handlePlayOperation();
    this.liveController.startMpegTsWatchdog();
  }

  private readonly handleMpegTsEnded = (): void => {
    this.liveController.handleLiveEnded(this.controlsSource?.kind);
  };

  private restartMpegTsAfterDisconnect(): void {
    const url = this.mpegtsUrl;
    if (!url || !this.isLive()) {
      return;
    }
    this.destroyMpegtsPlayer(true);
    this.openMpegTsPlayer(this.mpegTsProxy.currentUrl ?? url, url);
  }

  private getShakaSession(): ShakaVideoSession {
    this.shakaSession ??= new ShakaVideoSession({
      player: InlinePlaybackPlayer.Html5,
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      showCaptions: () => this.showCaptions(),
    });
    return this.shakaSession;
  }

  /**
   * Handles promise based play operation
   */
  handlePlayOperation(): void {
    if (this.playbackIntent === 'pause') { this.videoPlayer.nativeElement.pause(); return; }
    this.getVideoSession().play();
  }

  /**
   * Destroy hls instance on component destroy and clean up event listener
   */
  ngOnDestroy(): void {
    this.destroyed = true;
    this.sourceGeneration += 1;
    const cleanup = this.teardownPlayback();
    this.videoPlayer?.nativeElement.removeEventListener(
      "ended",
      this.handleMpegTsEnded,
    );
    this.controlsBridge?.destroy();
    this.controlsBridge = null;
    this.controlsSource = null;
    this.unregisterPlaybackIntentListener();
    this.liveController.destroy();
    this.videoSession?.destroy();
    this.videoSession = null;
    void cleanup
      .then(() => this.unregisterPlaybackTeardown())
      .catch((error: unknown) =>
        debugHtmlPlayer("Unable to stop playback during component teardown:", error),
      );
  }

  private teardownPlayback(): Promise<void> {
    this.sourceGeneration += 1;
    if (this.teardownInFlight) {
      return this.teardownInFlight;
    }

    const videoSession = this.videoSession;
    const shakaSession = this.shakaSession;
    const cleanup = (async (): Promise<void> => {
      videoSession?.resetForSourceChange();
      const video = this.videoPlayer?.nativeElement;
      if (video) {
        clearNativeVideoSources(video);
      }
      this.liveController.stop();
      this.clearControlsSource();
      this.destroyMpegtsPlayer();
      if (this.destroyed) {
        this.liveController.destroy();
      }
      await awaitPlaybackTeardowns([
        this.progressiveVodProxy.releaseAndWait(),
        this.nativeHlsProxy.releaseAndWait(),
        this.mpegTsProxy.releaseAndWait(),
        this.liveController.releaseProxyAndWait(),
        shakaSession
          ? this.destroyed
            ? shakaSession.destroyAndWait()
            : shakaSession.stopAndWait()
          : Promise.resolve(),
      ]);
      if (this.destroyed) {
        if (this.videoSession === videoSession) {
          this.videoSession = null;
        }
        if (this.shakaSession === shakaSession) {
          this.shakaSession = null;
        }
      }
    })().finally(() => {
      this.teardownInFlight = null;
    });
    this.teardownInFlight = cleanup;
    return cleanup;
  }

  private getVideoSession(): HtmlVideoElementSession {
    this.videoSession ??= new HtmlVideoElementSession({
      video: this.videoPlayer.nativeElement,
      getChannelUrl: () => this.channel?.url,
      getStartTime: () => toLocalPlaybackPosition(this.startTime, this.timelineOffsetSeconds),
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      emitTimeUpdate: (value) => this.timeUpdate.emit({
        currentTime: toAbsolutePlaybackPosition(value.currentTime, this.timelineOffsetSeconds),
        duration: toAbsolutePlaybackDuration(value.duration, this.timelineOffsetSeconds, this.durationSeconds) ?? 0,
      }),
      emitPlaybackEnded: () => this.playbackEnded.emit(),
      getSourceKind: () => this.controlsSource?.kind ?? null,
      getIsLive: () => this.isLive(),
    });
    return this.videoSession;
  }

  private getRequestHeaders(channel: Channel): Record<string, string> {
    const headers = { ...(channel.http.headers ?? {}) };
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
}
