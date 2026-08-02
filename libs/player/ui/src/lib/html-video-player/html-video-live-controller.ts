import Hls, { type ErrorData, type ManifestParsedData } from "hls.js";
import { createDevLogger } from "@arm-nator/shared/interfaces";
import type { HtmlVideoControlsSource } from "./html-video-player-controls.bridge";
import {
  emitFatalHlsPlaybackError,
  emitUnsupportedHlsManifestCodecs,
} from "./html-video-player-diagnostics";
import type { PlaybackDiagnostic } from "../playback-diagnostics/playback-diagnostics.util";
import { LivePlaybackRecovery } from "../web-video-support/live-playback-recovery";
import { LivePlaybackWatchdog } from "../web-video-support/live-playback-watchdog";

const debugHtmlPlayer = createDevLogger("HtmlVideoPlayer");

export interface HtmlVideoLiveControllerConfig {
  readonly getVideo: () => HTMLVideoElement;
  readonly isLive: () => boolean;
  readonly restartMpegTs: () => void;
  readonly bindControlsSource: (source: HtmlVideoControlsSource) => void;
  readonly play: () => void;
  readonly emitPlaybackIssue: (issue: PlaybackDiagnostic) => void;
}

/** Owns live HLS playback plus the shared HLS/MPEG-TS recovery policy. */
export class HtmlVideoLiveController {
  private hls: Hls | null = null;
  private hlsUrl = "";
  private readonly watchdog = new LivePlaybackWatchdog();
  private readonly mpegTsRecovery: LivePlaybackRecovery;
  private readonly hlsRecovery: LivePlaybackRecovery;

  constructor(private readonly config: HtmlVideoLiveControllerConfig) {
    this.mpegTsRecovery = new LivePlaybackRecovery({
      isLive: config.isLive,
      restart: config.restartMpegTs,
      onScheduled: ({ attempt, delayMs, reason }) =>
        debugHtmlPlayer(
          `MPEG-TS reconnect ${attempt} in ${delayMs}ms:`,
          reason,
        ),
    });
    this.hlsRecovery = new LivePlaybackRecovery({
      isLive: config.isLive,
      restart: () => this.restartHls(),
      onScheduled: ({ attempt, delayMs, reason }) =>
        debugHtmlPlayer(`HLS reconnect ${attempt} in ${delayMs}ms:`, reason),
    });
  }

  openHls(url: string): void {
    this.hlsUrl = url;
    const hls = new Hls();
    this.hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) =>
      this.handleManifestParsed(hls, url, data),
    );
    hls.on(Hls.Events.ERROR, (_, data) => this.handleHlsError(hls, url, data));
    hls.attachMedia(this.config.getVideo());
    this.config.bindControlsSource({ kind: "hls", hls });
    hls.loadSource(url);
    this.config.play();
    this.startWatchdog("hls");
  }

  startMpegTsWatchdog(): void {
    this.startWatchdog("mpegts");
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
  }

  stop(): void {
    this.watchdog.stop();
    this.destroyHlsPlayer();
    this.hlsUrl = "";
    this.mpegTsRecovery.reset();
    this.hlsRecovery.reset();
  }

  destroy(): void {
    this.watchdog.destroy();
    this.destroyHlsPlayer();
    this.mpegTsRecovery.destroy();
    this.hlsRecovery.destroy();
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
    hls?.destroy();
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
      onPlaying: () => recovery.markPlaying(),
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
    emitFatalHlsPlaybackError(url, data, this.config.emitPlaybackIssue);
    if (data.fatal && this.config.isLive()) {
      this.hlsRecovery.request(`${data.type}: ${data.details}`);
    }
  }
}
