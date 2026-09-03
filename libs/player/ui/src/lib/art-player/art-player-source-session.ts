import type Artplayer from "artplayer";
import type { Option } from "artplayer";
import Hls, {
  ErrorTypes,
  type ErrorData,
  type LevelLoadedData,
  type ManifestParsedData,
} from "hls.js";
import mpegts from "mpegts.js";
import { createDevLogger, type ChannelDrm } from "@arm-nator/shared/interfaces";
import {
  InlinePlaybackPlayer,
  type PlaybackDiagnostic,
  classifyHlsPlaybackIssue,
  classifyMpegTsPlaybackIssue,
  classifyUnsupportedHlsManifestCodecs,
  createPlaybackSourceMetadata,
} from "../playback-diagnostics/playback-diagnostics.util";
import type {
  WebVideoControlsAdapter,
  WebVideoPlaybackIntent,
} from "../player-controls";
import type { ShakaModuleLoader } from "../shaka-engine/shaka-module.types";
import { ShakaVideoSession } from "../shaka-engine/shaka-video-session";
import { ArtPlayerHlsProxySession } from "./art-player-hls-proxy-session";
import {
  type WebVideoControlsSource,
  WebVideoSourceControlsBridge,
} from "../web-video-support/web-video-source-controls.bridge";
import {
  MpegTsLiveRecovery,
  createMpegTsConfig,
  isRecoverableMpegTsLiveFailure,
} from "../web-video-support/mpegts-live-recovery";
import { LivePlaybackRecovery } from "../web-video-support/live-playback-recovery";
import { LivePlaybackWatchdog } from "../web-video-support/live-playback-watchdog";
import { seekVideoToLiveEdge } from "../web-video-support/live-edge-resume";
import { VodPlaybackRecovery } from "../web-video-support/vod-playback-recovery";
import { ProgressiveVodProxySession } from "../web-video-support/progressive-vod-proxy-session";
import { MpegTsProxySession } from "../web-video-support/mpegts-proxy-session";

// Used only before the first live playlist exposes timing metadata.
const LIVE_HLS_FALLBACK_SEGMENT_DURATION_SECONDS = 2;
const INITIAL_LIVE_SYNC_SEGMENTS = 4;
const MAX_LIVE_SYNC_SEGMENTS = 6;
const LIVE_WINDOW_SAFETY_SEGMENTS = 2;
const debugMpegTs = createDevLogger("ArtPlayer MPEG-TS");
const MPEGTS_STARTUP_GRACE_MS = 20_000;

export interface ArtPlayerSourceSessionConfig {
  controlsAdapter: WebVideoControlsAdapter;
  isLive: () => boolean;
  showCaptions: () => boolean;
  emitPlaybackIssue: (issue: PlaybackDiagnostic) => void;
  /** DRM config of the active channel, used by the DASH (`mpd`) engine. */
  getDrm?: () => ChannelDrm | undefined;
  /** Test seam for the lazily imported shaka-player module. */
  loadShaka?: ShakaModuleLoader;
  /** Provider headers retained by the main-process HLS transport. */
  hlsRequestHeaders?: Record<string, string>;
  /** Provider headers used by progressive-VOD byte-range requests. */
  mediaRequestHeaders?: Record<string, string>;
  /** Provider headers used by the raw MPEG-TS transport. */
  mpegTsRequestHeaders?: Record<string, string>;
}

interface PendingPlaybackIssue {
  kind: "live-hls" | "vod-hls";
  hls?: Hls;
  issue: PlaybackDiagnostic;
  currentTime?: number;
}

/**
 * Owns ArtPlayer's custom source engines and the shared-controls track bridge.
 *
 * A session belongs to one ArtPlayer instance. Its customType callbacks use the
 * callback-local `art` argument and become no-ops after destroy, so ArtPlayer's
 * delayed URL dispatch cannot mutate a newer component player.
 */
export class ArtPlayerSourceSession {
  readonly customType: NonNullable<Option["customType"]> = {
    m3u8: (video, url) => this.startHls(video, url),
    mpd: (video, url) => this.startDash(video, url),
    mp4: (video, url) => this.startProgressiveVod(video, url),
    ts: (video, url) => this.startMpegTs(video, url),
    "video/matroska": (video, url) => this.startNative(video, url),
  };

  private player: Artplayer | null = null;
  private controlsBridge: WebVideoSourceControlsBridge | null = null;
  private pendingControlsSource: WebVideoControlsSource = { kind: "native" };
  private hls: Hls | null = null;
  private hlsUrl = "";
  private hlsVideo: HTMLVideoElement | null = null;
  private readonly hlsProxySession = new ArtPlayerHlsProxySession();
  private readonly progressiveVodProxy = new ProgressiveVodProxySession();
  private readonly mpegTsProxy = new MpegTsProxySession();
  private nativeSourceGeneration = 0;
  private readonly hlsWatchdog = new LivePlaybackWatchdog();
  private readonly hlsRecovery: LivePlaybackRecovery;
  private readonly vodHlsRecovery: VodPlaybackRecovery;
  private readonly unregisterPlaybackIntentListener: () => void;
  private pendingPlaybackIssue: PendingPlaybackIssue | null = null;
  private pendingPlaybackIssueTimer: ReturnType<typeof setTimeout> | undefined;
  private hlsResumeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHlsIssue: PlaybackDiagnostic | null = null;
  private playbackIntent: WebVideoPlaybackIntent | null = null;
  private vodHlsPlayingListener: EventListener | null = null;
  private hlsTargetDurationSeconds = LIVE_HLS_FALLBACK_SEGMENT_DURATION_SECONDS;
  private hlsObservedSegmentDurationSeconds =
    LIVE_HLS_FALLBACK_SEGMENT_DURATION_SECONDS;
  private hlsManifestListener:
    ((event: unknown, data: ManifestParsedData) => void) | null = null;
  private hlsErrorListener: ((event: unknown, data: ErrorData) => void) | null =
    null;
  private hlsLevelLoadedListener:
    ((event: unknown, data: LevelLoadedData) => void) | null = null;
  private mpegTsPlayer: mpegts.Player | null = null;
  private mpegTsUrl = "";
  private mpegTsVideo: HTMLVideoElement | null = null;
  private readonly mpegTsWatchdog = new LivePlaybackWatchdog();
  private readonly mpegTsRecovery: MpegTsLiveRecovery;
  private mpegTsErrorListener:
    ((type: string, details: string, info: unknown) => void) | null = null;
  private pendingMpegTsIssue: PlaybackDiagnostic | null = null;
  private mpegTsIssueTimer: ReturnType<typeof setTimeout> | undefined;
  private shakaSession: ShakaVideoSession | null = null;
  private destroyed = false;

  constructor(private readonly config: ArtPlayerSourceSessionConfig) {
    this.mpegTsRecovery = new MpegTsLiveRecovery({
      isLive: this.config.isLive,
      restart: () => this.restartMpegTsAfterDisconnect(),
      onExhausted: ({ reason }) => this.handleMpegTsRecoveryExhausted(reason),
      onScheduled: ({ attempt, delayMs, reason }) =>
        debugMpegTs(`Reconnect ${attempt} in ${delayMs}ms:`, reason),
    });
    this.hlsRecovery = new LivePlaybackRecovery({
      isLive: this.config.isLive,
      restart: () => this.restartHls(),
      getRecoveryBudgetMs: () => this.getHlsRecoveryBudgetMs(),
      onExhausted: ({ reason }) => this.handleHlsRecoveryExhausted(reason),
    });
    this.vodHlsRecovery = new VodPlaybackRecovery({
      retry: (kind) => {
        const hls = this.hls;
        if (!hls || this.config.isLive()) {
          return;
        }
        if (kind === "media") {
          hls.recoverMediaError();
        } else {
          hls.startLoad();
        }
      },
      onExhausted: () => this.handleVodHlsRecoveryExhausted(),
    });
    this.unregisterPlaybackIntentListener =
      this.config.controlsAdapter.registerPlaybackIntentListener((intent) =>
        this.handlePlaybackIntent(intent),
      );
  }

  attach(player: Artplayer): void {
    if (this.destroyed || this.player) {
      return;
    }

    this.player = player;
    const bridge = new WebVideoSourceControlsBridge({
      video: player.video,
      adapter: this.config.controlsAdapter,
      isLive: this.config.isLive,
      showCaptions: this.config.showCaptions,
    });
    this.controlsBridge = bridge;
    bridge.attach();
    bridge.setSource(this.pendingControlsSource);
  }

  refreshInputs(): void {
    this.controlsBridge?.refreshInputs();
  }

  shouldDeferNativePlaybackError(errorCode?: number): boolean {
    const video = this.hlsVideo;
    if (
      !this.config.isLive() ||
      !this.hls ||
      !video ||
      video.paused ||
      (errorCode !== 1 && errorCode !== 2)
    ) {
      return false;
    }

    return (
      this.getLiveBufferAheadSeconds(video) >=
      this.getMinimumLiveBufferSeconds()
    );
  }

  resolveDuration(fallbackDuration: number): number {
    const correctedDuration = this.controlsBridge?.readDuration() ?? NaN;
    return Number.isNaN(correctedDuration)
      ? fallbackDuration
      : correctedDuration;
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.unregisterPlaybackIntentListener();
    this.controlsBridge?.destroy();
    this.controlsBridge = null;
    this.destroyHls();
    this.destroyMpegTs();
    this.mpegTsRecovery.destroy();
    this.mpegTsWatchdog.destroy();
    this.hlsWatchdog.destroy();
    this.hlsRecovery.destroy();
    this.vodHlsRecovery.destroy();
    this.progressiveVodProxy.release();
    this.mpegTsProxy.release();
    this.shakaSession?.destroy();
    this.shakaSession = null;
    this.player = null;
  }

  private startHls(
    video: HTMLVideoElement,
    url: string,
    preserveRecovery = false,
    resumePlayback = false,
  ): void {
    if (this.destroyed) {
      return;
    }

    this.prepareForSourceChange(preserveRecovery);
    this.hlsTargetDurationSeconds = LIVE_HLS_FALLBACK_SEGMENT_DURATION_SECONDS;
    this.hlsObservedSegmentDurationSeconds =
      LIVE_HLS_FALLBACK_SEGMENT_DURATION_SECONDS;
    if (Hls.isSupported()) {
      const hls = new Hls(
        this.config.isLive()
          ? {
              // Keep enough media behind the live edge for
              // providers whose segment fetch time approaches the
              // segment duration.
              liveSyncDurationCount: INITIAL_LIVE_SYNC_SEGMENTS,
              liveMaxLatencyDurationCount: 9,
              maxBufferLength: 30,
            }
          : {
              // VOD starts from the asset beginning. Do not carry
              // live latency controls into a finite playlist.
              startPosition: -1,
              abrEwmaFastVoD: 3,
              abrEwmaSlowVoD: 9,
            },
      );
      this.hls = hls;
      this.hlsUrl = url;
      this.hlsVideo = video;
      if (!this.config.isLive()) {
        this.vodHlsPlayingListener = () => {
          if (this.hlsVideo !== video) {
            return;
          }
          this.vodHlsRecovery.markProgress();
          this.clearPendingPlaybackIssue();
        };
        video.addEventListener("playing", this.vodHlsPlayingListener);
      }
      this.hlsManifestListener = (_event, data) => {
        if (this.destroyed || this.hls !== hls) {
          return;
        }
        this.handleHlsManifestParsed(url, data);
      };
      this.hlsErrorListener = (_event, data) => {
        if (this.destroyed || this.hls !== hls) {
          return;
        }
        this.handleHlsError(hls, url, data);
      };
      this.hlsLevelLoadedListener = (_event, data) => {
        if (this.destroyed || this.hls !== hls) {
          return;
        }
        this.adaptLiveSync(hls, data);
      };
      hls.on(Hls.Events.MANIFEST_PARSED, this.hlsManifestListener);
      hls.on(Hls.Events.ERROR, this.hlsErrorListener);
      hls.on(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
      hls.attachMedia(video);
      this.bindControlsSource({ kind: "hls", hls });
      void this.hlsProxySession
        .load(
          hls,
          url,
          this.config.hlsRequestHeaders,
          () => !this.destroyed && this.hls === hls,
        )
        .then((loaded) => {
          if (loaded && !this.destroyed && this.hls === hls) {
            if (this.config.isLive()) {
              this.hlsWatchdog.start(video, {
                isLive: this.config.isLive,
                onNoProgress: (reason) => this.hlsRecovery.request(reason),
                onPlaying: () => {
                  this.clearPendingPlaybackIssue();
                  this.clearHlsResumeTimer();
                  this.lastHlsIssue = null;
                  this.hlsRecovery.markPlaying();
                },
                onUnstable: () => this.hlsRecovery.markUnstable(),
                onUserPause: () => this.hlsRecovery.reset(),
              });
            }
            if (resumePlayback) {
              const playResult = video.play();
              if (playResult) {
                void playResult.catch(() => undefined);
              }
            }
          }
        });
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      this.bindControlsSource({ kind: "native" });
    }
  }

  private startMpegTs(video: HTMLVideoElement, url: string): void {
    if (this.destroyed) {
      return;
    }

    this.prepareForSourceChange();
    if (!mpegts.isSupported()) {
      return;
    }
    this.mpegTsUrl = url;
    this.mpegTsVideo = video;
    const sourceGeneration = this.nativeSourceGeneration;
    void this.mpegTsProxy
      .load(
        url,
        this.config.mpegTsRequestHeaders,
        () =>
          !this.destroyed &&
          sourceGeneration === this.nativeSourceGeneration &&
          this.mpegTsUrl === url &&
          this.mpegTsVideo === video,
      )
      .then((playbackUrl) => {
        if (
          this.destroyed ||
          sourceGeneration !== this.nativeSourceGeneration ||
          this.mpegTsUrl !== url ||
          this.mpegTsVideo !== video
        ) {
          return;
        }
        this.openMpegTs(video, playbackUrl, url);
      })
      .catch((error: unknown) => {
        if (
          this.destroyed ||
          sourceGeneration !== this.nativeSourceGeneration ||
          this.mpegTsUrl !== url ||
          this.mpegTsVideo !== video
        ) {
          return;
        }
        this.config.emitPlaybackIssue(
          classifyMpegTsPlaybackIssue(
            {
              type: "network",
              details: "MPEG-TS proxy initialization failed.",
              info: error,
            },
            this.createSourceMetadata(url, "video/mp2t"),
          ),
        );
      });
  }

  private openMpegTs(
    video: HTMLVideoElement,
    url: string,
    sourceUrl = url,
  ): void {
    const isLive = this.isMpegTsLive();
    const directHeaders =
      this.mpegTsProxy.currentUrl === url
        ? undefined
        : this.config.mpegTsRequestHeaders;
    const engine = mpegts.createPlayer(
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
    this.mpegTsPlayer = engine;
    this.mpegTsErrorListener = (type, details, info) => {
      if (this.destroyed || this.mpegTsPlayer !== engine) {
        return;
      }
      debugMpegTs("Engine error:", { type, details });
      if (isLive && isRecoverableMpegTsLiveFailure(type, details, info)) {
        this.deferMpegTsIssue(
          classifyMpegTsPlaybackIssue(
            { type, details, info },
            this.createSourceMetadata(sourceUrl, "video/mp2t"),
          ),
        );
        this.mpegTsRecovery.request(`${type}: ${details}`);
      } else {
        this.config.emitPlaybackIssue(
          classifyMpegTsPlaybackIssue(
            { type, details, info },
            this.createSourceMetadata(sourceUrl, "video/mp2t"),
          ),
        );
      }
    };
    this.mpegTsEndedListener = () => {
      if (isLive) {
        this.mpegTsRecovery.request("Live MPEG-TS connection reached EOF.");
      }
    };
    this.mpegTsPlayingListener = () => {
      this.mpegTsRecovery.markPlaying();
      this.clearMpegTsIssue();
    };
    this.mpegTsNativeErrorListener = () => {
      debugMpegTs(
        `Native media error: ${JSON.stringify({
          code: video.error?.code,
          message: video.error?.message,
          networkState: video.networkState,
          readyState: video.readyState,
        })}`,
      );
    };

    engine.attachMediaElement(video);
    this.bindControlsSource({ kind: "mpegts" });
    engine.on(mpegts.Events.ERROR, this.mpegTsErrorListener);
    video.addEventListener("ended", this.mpegTsEndedListener);
    video.addEventListener("playing", this.mpegTsPlayingListener);
    video.addEventListener("error", this.mpegTsNativeErrorListener);
    if (isLive) {
      this.mpegTsWatchdog.start(video, {
        isLive: this.config.isLive,
        startupGraceMs: MPEGTS_STARTUP_GRACE_MS,
        onNoProgress: (reason) => this.mpegTsRecovery.request(reason),
        onUnstable: () => this.mpegTsRecovery.markUnstable(),
        onUserPause: () => this.mpegTsRecovery.reset(),
      });
    }
    engine.load();
    const playResult = engine.play();
    if (playResult) {
      void playResult.catch((error: unknown) => {
        debugMpegTs(
          `Initial play() rejected: ${JSON.stringify({
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
            mediaErrorCode: video.error?.code,
            mediaErrorMessage: video.error?.message,
            networkState: video.networkState,
            readyState: video.readyState,
          })}`,
        );
      });
    }
  }

  private startDash(video: HTMLVideoElement, url: string): void {
    if (this.destroyed) {
      return;
    }

    this.prepareForSourceChange();
    const session = this.getShakaSession();
    this.bindControlsSource({ kind: "shaka", session });
    session.start(video, url, this.config.getDrm?.());
  }

  private startNative(video: HTMLVideoElement, url: string): void {
    if (this.destroyed) {
      return;
    }

    this.prepareForSourceChange();
    video.preload = "auto";
    video.src = url;
    this.bindControlsSource({ kind: "native" });
  }

  private startProgressiveVod(video: HTMLVideoElement, url: string): void {
    if (this.destroyed) {
      return;
    }

    this.prepareForSourceChange();
    this.bindControlsSource({ kind: "native" });
    const generation = ++this.nativeSourceGeneration;
    const setSource = (sourceUrl: string): void => {
      video.preload = "auto";
      video.src = sourceUrl;
    };

    void this.progressiveVodProxy
      .load(
        { setSource },
        url,
        this.config.mediaRequestHeaders,
        () => !this.destroyed && generation === this.nativeSourceGeneration,
      )
      .then((loaded) => {
        if (
          !loaded ||
          this.destroyed ||
          generation !== this.nativeSourceGeneration
        ) {
          return;
        }
        video.load();
        if (this.playbackIntent !== "pause") {
          const playResult = video.play();
          if (playResult) {
            void playResult.catch(() => undefined);
          }
        }
      });
  }

  private prepareForSourceChange(preserveHlsRecovery = false): void {
    this.controlsBridge?.clearSource();
    this.nativeSourceGeneration += 1;
    this.progressiveVodProxy.release();
    this.destroyHls(!preserveHlsRecovery);
    this.destroyMpegTs();
    this.shakaSession?.stop();
  }

  private getShakaSession(): ShakaVideoSession {
    this.shakaSession ??= new ShakaVideoSession({
      player: InlinePlaybackPlayer.ArtPlayer,
      emitPlaybackIssue: (issue) => this.config.emitPlaybackIssue(issue),
      showCaptions: this.config.showCaptions,
      loadShaka: this.config.loadShaka,
    });
    return this.shakaSession;
  }

  private bindControlsSource(source: WebVideoControlsSource): void {
    this.pendingControlsSource = source;
    this.controlsBridge?.setSource(source);
  }

  private handlePlaybackIntent(intent: WebVideoPlaybackIntent): void {
    this.playbackIntent = intent;
    this.hlsWatchdog.notifyPlaybackIntent(intent);
    this.mpegTsWatchdog.notifyPlaybackIntent(intent);
    if (intent === "play" && this.config.isLive()) {
      if (this.pendingControlsSource.kind === "mpegts") {
        // The shared adapter calls video.play() after notifying listeners.
        // Reconnect on the following microtask so that call cannot toggle the
        // freshly created, already-playing MPEG-TS engine back to paused.
        queueMicrotask(() => this.restartMpegTsAfterDisconnect());
      } else {
        const video = this.player?.video ?? this.hlsVideo;
        if (video) {
          seekVideoToLiveEdge(
            video,
            this.pendingControlsSource.kind === "hls"
              ? this.hls?.liveSyncPosition
              : null,
          );
        }
      }
      return;
    }
    if (intent === "pause") {
      this.clearPendingPlaybackIssue();
      this.clearHlsResumeTimer();
      // The watchdog may not be active while a new HLS source is loading.
      // Reset directly as well so a queued reconnect cannot survive that
      // gap.
      this.hlsRecovery.reset();
      this.mpegTsRecovery.reset();
      this.vodHlsRecovery.reset();
    }
  }

  private destroyHls(resetRecovery = true): void {
    this.hlsWatchdog.stop();
    this.clearPendingPlaybackIssue();
    this.clearHlsResumeTimer();
    this.vodHlsRecovery.reset();
    const hls = this.hls;
    if (hls) {
      if (this.hlsManifestListener) {
        hls.off(Hls.Events.MANIFEST_PARSED, this.hlsManifestListener);
      }
      if (this.hlsErrorListener) {
        hls.off(Hls.Events.ERROR, this.hlsErrorListener);
      }
      if (this.hlsLevelLoadedListener) {
        hls.off(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
      }
      hls.destroy();
    }
    if (this.hlsVideo && this.vodHlsPlayingListener) {
      this.hlsVideo.removeEventListener("playing", this.vodHlsPlayingListener);
    }
    this.vodHlsPlayingListener = null;
    this.hls = null;
    this.hlsManifestListener = null;
    this.hlsErrorListener = null;
    this.hlsLevelLoadedListener = null;
    this.hlsProxySession.release();
    if (resetRecovery) {
      this.hlsUrl = "";
      this.hlsVideo = null;
      this.lastHlsIssue = null;
      this.hlsRecovery.reset();
    }
  }

  private restartHls(): void {
    const video = this.hlsVideo;
    const url = this.hlsUrl;
    if (this.destroyed || !video || !url || !this.config.isLive()) {
      return;
    }
    if (
      this.getLiveBufferAheadSeconds(video) > this.getMinimumLiveBufferSeconds()
    ) {
      // A stalled manifest does not mean that the already-buffered MSE
      // media is unusable. Keep the current engine and ask it to load
      // again; replacing HLS here would throw away the visible buffer.
      this.hls?.startLoad();
      this.resumeHlsWhenBuffered(video, url);
      return;
    }
    this.startHls(video, url, true, true);
  }

  private resumeHlsWhenBuffered(video: HTMLVideoElement, url: string): void {
    this.clearHlsResumeTimer();
    const checkBuffer = () => {
      this.hlsResumeTimer = undefined;
      if (
        this.destroyed ||
        this.hlsVideo !== video ||
        this.hlsUrl !== url ||
        !this.config.isLive()
      ) {
        return;
      }
      if (
        this.getLiveBufferAheadSeconds(video) >
        this.getMinimumLiveBufferSeconds()
      ) {
        this.hlsResumeTimer = setTimeout(
          checkBuffer,
          this.getHlsRefreshDelayMs(),
        );
        return;
      }
      this.startHls(video, url, true, true);
    };
    this.hlsResumeTimer = setTimeout(checkBuffer, this.getHlsRefreshDelayMs());
  }

  private getLiveBufferAheadSeconds(video: HTMLVideoElement): number {
    const currentTime = video.currentTime;
    for (let index = 0; index < video.buffered.length; index += 1) {
      const start = video.buffered.start(index);
      const end = video.buffered.end(index);
      if (currentTime >= start && currentTime <= end) {
        return Math.max(0, end - currentTime);
      }
    }
    return 0;
  }

  private clearHlsResumeTimer(): void {
    if (this.hlsResumeTimer !== undefined) {
      clearTimeout(this.hlsResumeTimer);
      this.hlsResumeTimer = undefined;
    }
  }

  private getMinimumLiveBufferSeconds(): number {
    return Math.max(0.5, this.hlsObservedSegmentDurationSeconds);
  }

  private getHlsRefreshDelayMs(): number {
    return Math.max(250, Math.round(this.hlsTargetDurationSeconds * 1_000));
  }

  private getHlsIssueGraceMs(): number {
    return Math.max(
      250,
      Math.round(this.getMinimumLiveBufferSeconds() * 1_000),
    );
  }

  private getHlsRecoveryBudgetMs(): number {
    // Three target durations cover the minimum live-window expectation.
    // Before the playlist is parsed, the documented fallback above is used.
    return Math.max(10_000, Math.round(this.hlsTargetDurationSeconds * 3_000));
  }

  private mpegTsEndedListener: EventListener | null = null;
  private mpegTsPlayingListener: EventListener | null = null;
  private mpegTsNativeErrorListener: EventListener | null = null;

  private destroyMpegTs(preserveRecovery = false): void {
    this.mpegTsWatchdog.stop();
    this.clearMpegTsIssue();
    const engine = this.mpegTsPlayer;
    const video = this.mpegTsVideo;
    if (video && this.mpegTsEndedListener) {
      video.removeEventListener("ended", this.mpegTsEndedListener);
    }
    if (video && this.mpegTsPlayingListener) {
      video.removeEventListener("playing", this.mpegTsPlayingListener);
    }
    if (video && this.mpegTsNativeErrorListener) {
      video.removeEventListener("error", this.mpegTsNativeErrorListener);
    }
    this.mpegTsEndedListener = null;
    this.mpegTsPlayingListener = null;
    this.mpegTsNativeErrorListener = null;

    if (engine && this.mpegTsErrorListener) {
      engine.off(mpegts.Events.ERROR, this.mpegTsErrorListener);
    }
    this.mpegTsErrorListener = null;
    if (engine) {
      engine.pause();
      engine.unload();
      engine.detachMediaElement();
      engine.destroy();
    }
    this.mpegTsPlayer = null;
    if (!preserveRecovery) {
      this.mpegTsProxy.release();
      this.mpegTsRecovery.reset();
      this.mpegTsUrl = "";
      this.mpegTsVideo = null;
    }
  }

  private restartMpegTsAfterDisconnect(): void {
    const video = this.mpegTsVideo;
    const url = this.mpegTsUrl;
    if (this.destroyed || !video || !url || !this.isMpegTsLive()) {
      return;
    }
    this.destroyMpegTs(true);
    this.openMpegTs(video, this.mpegTsProxy.currentUrl ?? url, url);
  }

  private isMpegTsLive(): boolean {
    return this.config.isLive();
  }

  private handleMpegTsRecoveryExhausted(reason: string): void {
    const issue =
      this.pendingMpegTsIssue ??
      classifyMpegTsPlaybackIssue(
        { type: "network", details: reason, info: undefined },
        this.createSourceMetadata(this.mpegTsUrl, "video/mp2t"),
      );
    const video = this.mpegTsVideo;
    if (video && this.getLiveBufferAheadSeconds(video) > 0.5) {
      this.deferMpegTsIssue(issue);
      return;
    }
    this.clearMpegTsIssue();
    this.config.emitPlaybackIssue(issue);
  }

  private deferMpegTsIssue(issue: PlaybackDiagnostic): void {
    this.clearMpegTsIssue();
    this.pendingMpegTsIssue = issue;
    const check = () => {
      this.mpegTsIssueTimer = undefined;
      if (this.pendingMpegTsIssue !== issue) {
        return;
      }
      const video = this.mpegTsVideo;
      if (
        video &&
        !video.ended &&
        !video.error &&
        this.getLiveBufferAheadSeconds(video) > 0.5
      ) {
        this.mpegTsIssueTimer = setTimeout(check, 500);
        return;
      }
      this.pendingMpegTsIssue = null;
      this.config.emitPlaybackIssue(issue);
    };
    this.mpegTsIssueTimer = setTimeout(check, 500);
  }

  private clearMpegTsIssue(): void {
    if (this.mpegTsIssueTimer !== undefined) {
      clearTimeout(this.mpegTsIssueTimer);
      this.mpegTsIssueTimer = undefined;
    }
    this.pendingMpegTsIssue = null;
  }

  private handleHlsManifestParsed(url: string, data: ManifestParsedData): void {
    const metadata = this.createSourceMetadata(
      url,
      "application/x-mpegURL",
      data.levels
        .map((level) => level.audioCodec)
        .filter((codec): codec is string => Boolean(codec)),
      data.levels
        .map((level) => level.videoCodec)
        .filter((codec): codec is string => Boolean(codec)),
    );
    const issue = classifyUnsupportedHlsManifestCodecs(metadata);
    if (issue) {
      this.config.emitPlaybackIssue(issue);
    }
  }

  private adaptLiveSync(hls: Hls, data: LevelLoadedData): void {
    const details = data.details;
    if (!details.live || details.fragments.length === 0) {
      return;
    }

    if (Number.isFinite(details.targetduration) && details.targetduration > 0) {
      this.hlsTargetDurationSeconds = details.targetduration;
    }

    const recentDurations = details.fragments
      .map((fragment) => fragment.duration)
      .filter(
        (duration): duration is number =>
          Number.isFinite(duration) && duration > 0,
      )
      .slice(-5)
      .sort((left, right) => left - right);
    if (recentDurations.length > 0) {
      this.hlsObservedSegmentDurationSeconds =
        recentDurations[Math.floor(recentDurations.length / 2)];
    }

    const safeSegmentCount = Math.max(
      2,
      Math.min(
        MAX_LIVE_SYNC_SEGMENTS,
        details.fragments.length - LIVE_WINDOW_SAFETY_SEGMENTS,
      ),
    );
    const targetLatency = safeSegmentCount * details.targetduration;
    if (hls.targetLatency !== targetLatency) {
      hls.targetLatency = targetLatency;
    }
  }

  private handleHlsError(hls: Hls, url: string, data: ErrorData): void {
    if (!data.fatal) {
      return;
    }

    const issue = classifyHlsPlaybackIssue(
      {
        type: data.type,
        details: data.details,
        fatal: data.fatal,
        message: data.error?.message,
        error: data.error,
      },
      this.createSourceMetadata(url, "application/x-mpegURL"),
    );
    if (this.config.isLive()) {
      if (
        data.type === ErrorTypes.NETWORK_ERROR ||
        data.type === ErrorTypes.MEDIA_ERROR
      ) {
        this.deferLiveHlsIssue(hls, issue);
      } else {
        this.config.emitPlaybackIssue(issue);
      }
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        this.lastHlsIssue = issue;
        // Keep the current HLS instance alive while buffered media is
        // still playing. Destroying it here discards the MSE buffer
        // and creates a visible stop even when media remains queued.
        // Recovery remains scheduled, but restartHls() will only
        // replace the engine after the buffer is nearly exhausted.
        hls.stopLoad();
        hls.startLoad();
        this.hlsRecovery.request(`${data.type}: ${data.details}`, {
          cancelOnPlaying: false,
        });
      } else if (data.type === ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        this.hlsRecovery.request(`${data.type}: ${data.details}`, {
          cancelOnPlaying: false,
        });
      }
      return;
    }
    this.pendingPlaybackIssue = {
      kind: "vod-hls",
      issue,
    };
    if (data.type === ErrorTypes.NETWORK_ERROR) {
      this.vodHlsRecovery.request("asset", "VOD HLS asset request failed.");
    } else if (data.type === ErrorTypes.MEDIA_ERROR) {
      this.vodHlsRecovery.request(
        "media",
        "VOD HLS media recovery was requested.",
      );
    } else {
      this.clearPendingPlaybackIssue();
      this.config.emitPlaybackIssue(issue);
    }
  }

  private deferLiveHlsIssue(hls: Hls, issue: PlaybackDiagnostic): void {
    this.clearPendingPlaybackIssue();
    const video = this.hlsVideo;
    if (!video) {
      this.config.emitPlaybackIssue(issue);
      return;
    }
    this.pendingPlaybackIssue = {
      kind: "live-hls",
      hls,
      issue,
      currentTime: video.currentTime,
    };
    this.pendingPlaybackIssueTimer = setTimeout(() => {
      this.pendingPlaybackIssueTimer = undefined;
      const pending = this.pendingPlaybackIssue;
      this.pendingPlaybackIssue = null;
      if (
        !pending ||
        pending.kind !== "live-hls" ||
        this.destroyed ||
        this.hls !== pending.hls ||
        !this.hlsVideo
      ) {
        return;
      }
      const isPlaying =
        !this.hlsVideo.paused &&
        pending.currentTime !== undefined &&
        this.hlsVideo.currentTime - pending.currentTime >= 0.05;
      if (
        isPlaying ||
        this.getLiveBufferAheadSeconds(this.hlsVideo) >=
          this.getMinimumLiveBufferSeconds()
      ) {
        this.deferLiveHlsIssue(pending.hls, pending.issue);
        return;
      }
      this.config.emitPlaybackIssue(pending.issue);
    }, this.getHlsIssueGraceMs());
  }

  private handleHlsRecoveryExhausted(
    reason = "Live HLS recovery budget was exhausted.",
  ): void {
    const issue =
      this.lastHlsIssue ??
      classifyHlsPlaybackIssue(
        {
          type: ErrorTypes.NETWORK_ERROR,
          details: reason,
          fatal: true,
        },
        this.createSourceMetadata(this.hlsUrl, "application/x-mpegURL"),
      );
    if (!issue || !this.hlsVideo) {
      return;
    }
    if (
      this.hlsVideo.paused ||
      this.getLiveBufferAheadSeconds(this.hlsVideo) <
        this.getMinimumLiveBufferSeconds()
    ) {
      this.lastHlsIssue = null;
      this.config.emitPlaybackIssue(issue);
      return;
    }
    const hls = this.hls;
    if (hls) {
      this.deferLiveHlsIssue(hls, issue);
    } else {
      this.config.emitPlaybackIssue(issue);
    }
  }

  private handleVodHlsRecoveryExhausted(): void {
    const pending = this.pendingPlaybackIssue;
    if (!pending || pending.kind !== "vod-hls") {
      return;
    }
    this.deferVodHlsIssueUntilUnavailable(pending.issue);
  }

  private deferVodHlsIssueUntilUnavailable(issue: PlaybackDiagnostic): void {
    this.clearPendingPlaybackIssue();
    this.pendingPlaybackIssue = {
      kind: "vod-hls",
      issue,
    };
    const check = () => {
      this.pendingPlaybackIssueTimer = undefined;
      const pending = this.pendingPlaybackIssue;
      if (
        this.destroyed ||
        pending?.kind !== "vod-hls" ||
        pending.issue !== issue ||
        !this.hlsVideo
      ) {
        return;
      }
      const video = this.hlsVideo;
      const bufferAhead = this.getLiveBufferAheadSeconds(video);
      if (!video.ended && !video.error && bufferAhead > 0.5) {
        this.pendingPlaybackIssueTimer = setTimeout(check, 500);
        return;
      }
      this.pendingPlaybackIssue = null;
      this.config.emitPlaybackIssue(issue);
    };
    this.pendingPlaybackIssueTimer = setTimeout(check, 500);
  }

  private clearPendingPlaybackIssue(): void {
    if (this.pendingPlaybackIssueTimer !== undefined) {
      clearTimeout(this.pendingPlaybackIssueTimer);
      this.pendingPlaybackIssueTimer = undefined;
    }
    this.pendingPlaybackIssue = null;
  }

  private createSourceMetadata(
    url: string,
    mimeType?: string,
    audioCodecs: readonly string[] = [],
    videoCodecs: readonly string[] = [],
  ) {
    return createPlaybackSourceMetadata({
      url,
      mimeType,
      player: InlinePlaybackPlayer.ArtPlayer,
      audioCodecs,
      videoCodecs,
    });
  }
}
