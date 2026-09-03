import Hls, {
  ErrorTypes,
  type ErrorData,
  type LevelLoadedData,
  type ManifestParsedData,
} from "hls.js";
import { createDevLogger } from "@arm-nator/shared/interfaces";
import type { HtmlVideoControlsSource } from "./html-video-player-controls.bridge";
import { emitUnsupportedHlsManifestCodecs } from "./html-video-player-diagnostics";
import {
  classifyHlsPlaybackIssue,
  classifyMpegTsPlaybackIssue,
  createPlaybackSourceMetadata,
  InlinePlaybackPlayer,
  type PlaybackDiagnostic,
} from "../playback-diagnostics/playback-diagnostics.util";
import { LivePlaybackRecovery } from "../web-video-support/live-playback-recovery";
import { LivePlaybackWatchdog } from "../web-video-support/live-playback-watchdog";
import { seekVideoToLiveEdge } from "../web-video-support/live-edge-resume";
import { isRecoverableMpegTsLiveFailure } from "../web-video-support/mpegts-live-recovery";
import { VodPlaybackRecovery } from "../web-video-support/vod-playback-recovery";
import type { WebVideoPlaybackIntent } from "../player-controls/web-video-controls.adapter";

const debugHtmlPlayer = createDevLogger("HtmlVideoPlayer");
const FALLBACK_LIVE_TARGET_DURATION_SECONDS = 2;
const MPEGTS_RECOVERY_BUDGET_MS = 15_000;

export interface HtmlVideoLiveControllerConfig {
  readonly getVideo: () => HTMLVideoElement;
  readonly getSourceUrl: () => string | undefined;
  readonly isLive: () => boolean;
  readonly getSourceKind: () => HtmlVideoControlsSource["kind"] | null;
  readonly restartMpegTs: () => void;
  readonly bindControlsSource: (source: HtmlVideoControlsSource) => void;
  readonly play: () => void;
  readonly emitPlaybackIssue: (issue: PlaybackDiagnostic) => void;
}

/** Owns live HLS playback plus the shared HLS/MPEG-TS recovery policy. */
export class HtmlVideoLiveController {
  private hls: Hls | null = null;
  private hlsUrl = "";
  private hlsTargetDurationSeconds = FALLBACK_LIVE_TARGET_DURATION_SECONDS;
  private readonly watchdog = new LivePlaybackWatchdog();
  private readonly mpegTsRecovery: LivePlaybackRecovery;
  private readonly hlsRecovery: LivePlaybackRecovery;
  private readonly vodHlsRecovery: VodPlaybackRecovery;
  private pendingHlsIssue: PlaybackDiagnostic | null = null;
  private hlsIssueTimer: ReturnType<typeof setTimeout> | undefined;
  private vodHlsIssue: PlaybackDiagnostic | null = null;
  private vodHlsIssueTimer: ReturnType<typeof setTimeout> | undefined;
  private vodHlsPlayingListener: EventListener | null = null;
  private pendingMpegTsIssue: PlaybackDiagnostic | null = null;
  private mpegTsIssueTimer: ReturnType<typeof setTimeout> | undefined;
  private hlsLevelLoadedListener:
    ((event: unknown, data: LevelLoadedData) => void) | null = null;

  constructor(private readonly config: HtmlVideoLiveControllerConfig) {
    this.mpegTsRecovery = new LivePlaybackRecovery({
      isLive: config.isLive,
      restart: config.restartMpegTs,
      getRecoveryBudgetMs: () => MPEGTS_RECOVERY_BUDGET_MS,
      onExhausted: ({ reason }) => this.emitLiveRecoveryIssue(reason),
      onScheduled: ({ attempt, delayMs, reason }) =>
        debugHtmlPlayer(
          `MPEG-TS reconnect ${attempt} in ${delayMs}ms:`,
          reason,
        ),
    });
    this.hlsRecovery = new LivePlaybackRecovery({
      isLive: config.isLive,
      restart: () => this.restartHls(),
      getRecoveryBudgetMs: () => this.getHlsRecoveryBudgetMs(),
      onExhausted: ({ reason }) => this.handleLiveHlsRecoveryExhausted(reason),
      onScheduled: ({ attempt, delayMs, reason }) =>
        debugHtmlPlayer(`HLS reconnect ${attempt} in ${delayMs}ms:`, reason),
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
  }

  openHls(url: string): void {
    this.hlsUrl = url;
    this.hlsTargetDurationSeconds = FALLBACK_LIVE_TARGET_DURATION_SECONDS;
    const hls = new Hls(
      this.config.isLive()
        ? {
            liveSyncDurationCount: 4,
            liveMaxLatencyDurationCount: 9,
            maxBufferLength: 30,
          }
        : {
            startPosition: -1,
            abrEwmaFastVoD: 3,
            abrEwmaSlowVoD: 9,
          },
    );
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) =>
      this.handleManifestParsed(hls, url, data),
    );
    hls.on(Hls.Events.ERROR, (_, data) => this.handleHlsError(hls, url, data));
    this.hlsLevelLoadedListener = (_, data) => {
      if (this.hls !== hls) {
        return;
      }
      const targetDuration = data.details.targetduration;
      if (Number.isFinite(targetDuration) && targetDuration > 0) {
        this.hlsTargetDurationSeconds = targetDuration;
      }
    };
    hls.on(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
    hls.attachMedia(this.config.getVideo());
    if (!this.config.isLive()) {
      this.vodHlsPlayingListener = () => {
        this.vodHlsRecovery.markProgress();
        this.clearVodHlsIssue();
      };
      this.config
        .getVideo()
        .addEventListener("playing", this.vodHlsPlayingListener);
    }
    this.config.bindControlsSource({ kind: "hls", hls });
    hls.loadSource(url);
    this.config.play();
    this.startWatchdog("hls");
  }

  startMpegTsWatchdog(): void {
    this.startWatchdog("mpegts");
  }

  handleMpegTsError(
    url: string,
    error: { type: string; details: string; info: unknown },
  ): void {
    const issue = classifyMpegTsPlaybackIssue(
      error,
      createPlaybackSourceMetadata({
        url,
        mimeType: "video/mp2t",
        player: InlinePlaybackPlayer.Html5,
      }),
    );
    if (
      !this.config.isLive() ||
      !isRecoverableMpegTsLiveFailure(error.type, error.details, error.info)
    ) {
      this.config.emitPlaybackIssue(issue);
      return;
    }

    this.deferMpegTsIssueUntilUnavailable(issue);
    this.requestMpegTsRecovery(`${error.type}: ${error.details}`);
  }

  requestMpegTsRecovery(reason: string): void {
    this.mpegTsRecovery.request(reason);
  }

  handleLiveEnded(source: HtmlVideoControlsSource["kind"] | undefined): void {
    if (!this.config.isLive()) {
      return;
    }
    if (source === "mpegts") {
      this.requestMpegTsRecovery("Live MPEG-TS connection reached EOF.");
    } else if (source === "hls") {
      this.hlsRecovery.request("Live HLS connection reached EOF.");
    }
  }

  resetMpegTsRecovery(): void {
    this.mpegTsRecovery.reset();
    this.clearMpegTsIssue();
  }

  handlePlaybackIntent(intent: WebVideoPlaybackIntent): void {
    this.watchdog.notifyPlaybackIntent(intent);
    if (intent === "play" && this.config.isLive()) {
      const sourceKind = this.config.getSourceKind();
      if (sourceKind === "mpegts") {
        // Let the shared adapter finish its video.play() call before replacing
        // the old engine with a fresh live connection.
        queueMicrotask(() => this.config.restartMpegTs());
      } else {
        seekVideoToLiveEdge(
          this.config.getVideo(),
          sourceKind === "hls" ? this.hls?.liveSyncPosition : null,
        );
      }
      return;
    }
    if (intent !== "pause") {
      return;
    }

    this.mpegTsRecovery.reset();
    this.hlsRecovery.reset();
    this.vodHlsRecovery.reset();
    this.clearHlsIssue();
    this.clearVodHlsIssue();
    this.clearMpegTsIssue();
  }

  stop(): void {
    this.watchdog.stop();
    this.destroyHlsPlayer();
    this.hlsUrl = "";
    this.mpegTsRecovery.reset();
    this.hlsRecovery.reset();
    this.vodHlsRecovery.reset();
    this.clearHlsIssue();
    this.clearVodHlsIssue();
    this.clearMpegTsIssue();
  }

  destroy(): void {
    this.watchdog.destroy();
    this.destroyHlsPlayer();
    this.mpegTsRecovery.destroy();
    this.hlsRecovery.destroy();
    this.vodHlsRecovery.destroy();
    this.clearHlsIssue();
    this.clearVodHlsIssue();
    this.clearMpegTsIssue();
  }

  private restartHls(): void {
    const url = this.hlsUrl;
    if (!url || !this.config.isLive()) {
      return;
    }
    this.watchdog.stop();
    this.destroyHlsPlayer();
    this.openHls(url);
  }

  private destroyHlsPlayer(): void {
    const hls = this.hls;
    this.hls = null;
    if (hls && this.hlsLevelLoadedListener) {
      hls.off(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
    }
    this.hlsLevelLoadedListener = null;
    if (this.vodHlsPlayingListener) {
      this.config
        .getVideo()
        .removeEventListener("playing", this.vodHlsPlayingListener);
      this.vodHlsPlayingListener = null;
    }
    this.vodHlsRecovery.reset();
    this.clearHlsIssue();
    this.clearVodHlsIssue();
    hls?.destroy();
  }

  private getHlsRecoveryBudgetMs(): number {
    // Three observed target durations provide a bounded live recovery window;
    // use the fallback only until the first media playlist exposes timing.
    return Math.max(10_000, Math.round(this.hlsTargetDurationSeconds * 3_000));
  }

  private startWatchdog(source: "mpegts" | "hls"): void {
    if (!this.config.isLive()) {
      return;
    }
    const recovery =
      source === "mpegts" ? this.mpegTsRecovery : this.hlsRecovery;
    this.watchdog.start(this.config.getVideo(), {
      isLive: this.config.isLive,
      onNoProgress: (reason) => recovery.request(reason),
      onPlaying: () => {
        recovery.markPlaying();
        if (source === "hls") {
          this.clearHlsIssue();
        } else {
          this.clearMpegTsIssue();
        }
      },
      onUnstable: () => recovery.markUnstable(),
    });
  }

  private handleManifestParsed(
    hls: Hls,
    url: string,
    data: ManifestParsedData,
  ): void {
    if (this.hls !== hls) {
      return;
    }
    emitUnsupportedHlsManifestCodecs(url, data, this.config.emitPlaybackIssue);
  }

  private handleHlsError(hls: Hls, url: string, data: ErrorData): void {
    if (this.hls !== hls) {
      return;
    }
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
      createPlaybackSourceMetadata({
        url,
        mimeType: "application/x-mpegURL",
        player: InlinePlaybackPlayer.Html5,
      }),
    );

    if (!this.config.isLive()) {
      this.vodHlsIssue = issue;
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        this.vodHlsRecovery.request("asset", "VOD HLS asset request failed.");
      } else if (data.type === ErrorTypes.MEDIA_ERROR) {
        this.vodHlsRecovery.request(
          "media",
          "VOD HLS media recovery was requested.",
        );
      } else {
        this.clearVodHlsIssue();
        this.config.emitPlaybackIssue(issue);
      }
      return;
    }

    if (
      data.type === ErrorTypes.NETWORK_ERROR ||
      data.type === ErrorTypes.MEDIA_ERROR
    ) {
      this.deferHlsIssueUntilUnavailable(issue);
    } else {
      this.config.emitPlaybackIssue(issue);
    }
    if (data.fatal && this.config.isLive()) {
      if (data.type === ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
      } else if (data.type === ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
      } else {
        this.hlsRecovery.request(`${data.type}: ${data.details}`, {
          cancelOnPlaying: false,
        });
      }
    }
  }

  private handleLiveHlsRecoveryExhausted(reason: string): void {
    const issue =
      this.pendingHlsIssue ??
      classifyHlsPlaybackIssue(
        {
          type: ErrorTypes.NETWORK_ERROR,
          details: reason,
          fatal: true,
        },
        createPlaybackSourceMetadata({
          url: this.hlsUrl || this.config.getSourceUrl() || "",
          mimeType: "application/x-mpegURL",
          player: InlinePlaybackPlayer.Html5,
        }),
      );
    if (this.getBufferAheadSeconds(this.config.getVideo()) > 0.5) {
      this.deferHlsIssueUntilUnavailable(issue);
    } else {
      this.clearHlsIssue();
      this.config.emitPlaybackIssue(issue);
    }
  }

  private emitLiveRecoveryIssue(reason: string): void {
    const url = this.config.getSourceUrl() ?? this.config.getVideo().currentSrc;
    const issue =
      this.pendingMpegTsIssue ??
      classifyMpegTsPlaybackIssue(
        { type: "network", details: reason },
        createPlaybackSourceMetadata({
          url,
          mimeType: "video/mp2t",
          player: InlinePlaybackPlayer.Html5,
        }),
      );
    if (this.getBufferAheadSeconds(this.config.getVideo()) > 0.5) {
      this.deferMpegTsIssueUntilUnavailable(issue);
    } else {
      this.clearMpegTsIssue();
      this.config.emitPlaybackIssue(issue);
    }
  }

  private deferMpegTsIssueUntilUnavailable(issue: PlaybackDiagnostic): void {
    this.clearMpegTsIssue();
    this.pendingMpegTsIssue = issue;
    const check = () => {
      this.mpegTsIssueTimer = undefined;
      if (this.pendingMpegTsIssue !== issue) {
        return;
      }
      const video = this.config.getVideo();
      if (
        !video.ended &&
        !video.error &&
        this.getBufferAheadSeconds(video) > 0.5
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

  private deferHlsIssueUntilUnavailable(issue: PlaybackDiagnostic): void {
    this.clearHlsIssue();
    this.pendingHlsIssue = issue;
    const check = () => {
      this.hlsIssueTimer = undefined;
      if (this.pendingHlsIssue !== issue || !this.hls) {
        return;
      }
      const video = this.config.getVideo();
      if (
        !video.ended &&
        !video.error &&
        this.getBufferAheadSeconds(video) > 0.5
      ) {
        this.hlsIssueTimer = setTimeout(check, 500);
        return;
      }
      this.pendingHlsIssue = null;
      this.config.emitPlaybackIssue(issue);
    };
    this.hlsIssueTimer = setTimeout(check, 500);
  }

  private clearHlsIssue(): void {
    if (this.hlsIssueTimer !== undefined) {
      clearTimeout(this.hlsIssueTimer);
      this.hlsIssueTimer = undefined;
    }
    this.pendingHlsIssue = null;
  }

  private handleVodHlsRecoveryExhausted(): void {
    const issue = this.vodHlsIssue;
    if (!issue) {
      return;
    }
    this.deferVodHlsIssueUntilUnavailable(issue);
  }

  private deferVodHlsIssueUntilUnavailable(issue: PlaybackDiagnostic): void {
    this.clearVodHlsIssue();
    this.vodHlsIssue = issue;
    const check = () => {
      this.vodHlsIssueTimer = undefined;
      if (this.vodHlsIssue !== issue || !this.hls) {
        return;
      }
      const video = this.config.getVideo();
      if (
        !video.ended &&
        !video.error &&
        this.getBufferAheadSeconds(video) > 0.5
      ) {
        this.vodHlsIssueTimer = setTimeout(check, 500);
        return;
      }
      this.vodHlsIssue = null;
      this.config.emitPlaybackIssue(issue);
    };
    this.vodHlsIssueTimer = setTimeout(check, 500);
  }

  private clearVodHlsIssue(): void {
    if (this.vodHlsIssueTimer !== undefined) {
      clearTimeout(this.vodHlsIssueTimer);
      this.vodHlsIssueTimer = undefined;
    }
    this.vodHlsIssue = null;
  }

  private getBufferAheadSeconds(video: HTMLVideoElement): number {
    try {
      for (let index = 0; index < video.buffered.length; index += 1) {
        const start = video.buffered.start(index);
        const end = video.buffered.end(index);
        if (video.currentTime >= start && video.currentTime <= end) {
          return Math.max(0, end - video.currentTime);
        }
      }
    } catch {
      // Media ranges can change while being read.
    }
    return 0;
  }
}
