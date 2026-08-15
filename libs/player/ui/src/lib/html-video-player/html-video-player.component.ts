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
} from "@angular/core";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import { Channel, createDevLogger } from "@arm-nator/shared/interfaces";
import {
  InlinePlaybackPlayer,
  PlaybackDiagnostic,
  getPlaybackMediaExtensionFromUrl,
} from "../playback-diagnostics/playback-diagnostics.util";
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
import { createMpegTsConfig } from "../web-video-support/mpegts-live-recovery";
import { syncOnlineSubtitleTrack } from "../web-video-support/online-subtitle-track";
import { ProgressiveVodProxySession } from "../web-video-support/progressive-vod-proxy-session";
import { HtmlVideoElementSession } from "./html-video-element-session";
import { HtmlVideoLiveController } from "./html-video-live-controller";
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
  standalone: true,
})
export class HtmlVideoPlayerComponent implements OnInit, OnChanges, OnDestroy {
  /** Channel to play  */
  @Input() channel!: Channel;
  @Input() volume = 1;
  @Input() startTime = 0;
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
  private readonly runtimeSnapshotEffect = effect(() => {
    this.runtimeSnapshotChange.emit({
      state: this.controlsAdapter.state(),
      capabilities: this.controlsAdapter.capabilities(),
      media: this.controlsAdapter.mediaTelemetry(),
      engine: {
        engine: "html5",
        available: true,
        sessionStatus: this.controlsAdapter.state().status,
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
    isLive: () => this.isLive(),
    restartMpegTs: () => this.restartMpegTsAfterDisconnect(),
    bindControlsSource: (source) => this.bindControlsSource(source),
    play: () => this.handlePlayOperation(),
    emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
  });
  private readonly unregisterPlaybackIntentListener =
    this.controlsAdapter.registerPlaybackIntentListener((intent) =>
      this.liveController.handlePlaybackIntent(intent),
    );
  /** Shaka session for DASH (.mpd) streams, created on first use */
  private shakaSession: ShakaVideoSession | null = null;
  private controlsSource: HtmlVideoControlsSource | null = null;
  private controlsBridge: HtmlVideoPlayerControlsBridge | null = null;
  private videoSession: HtmlVideoElementSession | null = null;
  private readonly progressiveVodProxy = new ProgressiveVodProxySession();
  private sourceGeneration = 0;

  ngOnInit() {
    this.syncOnlineSubtitle();
    this.seriesNavigationSignal.set(this.seriesNavigation);
    this.controlsAdapter.setContext({
      seriesNavigation: this.seriesNavigationSignal,
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
    const sourceGeneration = ++this.sourceGeneration;
    this.videoSession?.resetForSourceChange();
    this.liveController.stop();
    this.clearControlsSource();
    this.progressiveVodProxy.release();
    this.destroyMpegtsPlayer();
    this.shakaSession?.stop();
    clearNativeVideoSources(this.videoPlayer.nativeElement);
    this.syncOnlineSubtitle();
    if (channel.url) {
      this.playbackIssue.emit(null);
      const url = channel.url;
      const extension = getPlaybackMediaExtensionFromUrl(channel.url);

      void window.electron
        ?.setUserAgent(
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
        session.start(this.videoPlayer.nativeElement, url, channel.drm);
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
        this.openMpegTsPlayer(url);
      } else if (shouldUseHls(extension) && Hls.isSupported()) {
        debugHtmlPlayer("Using hls.js for stream:", channel.name, url);
        this.liveController.openHls(url);
      } else {
        debugHtmlPlayer("Using native video player");
        this.syncOnlineSubtitle();
        this.bindControlsSource({ kind: "native" });
        const setSource = (sourceUrl: string): void => {
          setNativeVideoSource(
            this.videoPlayer.nativeElement,
            sourceUrl,
            getNativeMediaMimeType(extension),
          );
        };
        if (!this.isLive() && extension === "mp4") {
          void this.progressiveVodProxy
            .load(
              { setSource },
              url,
              {
                "User-Agent": channel.http?.["user-agent"],
                Referer: channel.http?.referrer,
                Origin: channel.http?.origin,
              },
              () => this.sourceGeneration === sourceGeneration,
            )
            .then((loaded) => {
              if (!loaded || this.sourceGeneration !== sourceGeneration) {
                return;
              }
              this.videoPlayer.nativeElement.load();
              this.handlePlayOperation();
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
      this.liveController.resetMpegTsRecovery();
      this.mpegtsUrl = "";
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

  private openMpegTsPlayer(url: string): void {
    const isLive = this.isLive();
    const player = mpegts.createPlayer(
      {
        type: "mpegts",
        isLive,
        url,
      },
      createMpegTsConfig(isLive),
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
        this.liveController.handleMpegTsError(url, { type, details, info });
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
    this.openMpegTsPlayer(url);
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
    this.getVideoSession().play();
  }

  /**
   * Destroy hls instance on component destroy and clean up event listener
   */
  ngOnDestroy(): void {
    this.sourceGeneration += 1;
    this.progressiveVodProxy.release();
    this.videoPlayer.nativeElement.removeEventListener(
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
    this.destroyMpegtsPlayer();
    this.shakaSession?.destroy();
    this.shakaSession = null;
  }

  private getVideoSession(): HtmlVideoElementSession {
    this.videoSession ??= new HtmlVideoElementSession({
      video: this.videoPlayer.nativeElement,
      getChannelUrl: () => this.channel?.url,
      getStartTime: () => this.startTime,
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      emitTimeUpdate: (value) => this.timeUpdate.emit(value),
      emitPlaybackEnded: () => this.playbackEnded.emit(),
      getSourceKind: () => this.controlsSource?.kind ?? null,
      getIsLive: () => this.isLive(),
    });
    return this.videoSession;
  }
}
