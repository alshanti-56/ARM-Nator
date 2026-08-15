import { createDevLogger } from "@arm-nator/shared/interfaces";
import {
  InlinePlaybackPlayer,
  type PlaybackDiagnostic,
  classifyNativePlaybackIssue,
  classifyMpegTsPlaybackIssue,
  createPlaybackSourceMetadata,
} from "../playback-diagnostics/playback-diagnostics.util";
import { VodSeekController } from "../web-video-support/vod-seek-controller";

const debugHtmlPlayer = createDevLogger("HtmlVideoPlayer");

export interface HtmlVideoElementSessionConfig {
  video: HTMLVideoElement;
  getChannelUrl: () => string | undefined;
  getStartTime: () => number;
  emitPlaybackIssue: (issue: PlaybackDiagnostic | null) => void;
  emitTimeUpdate: (value: { currentTime: number; duration: number }) => void;
  emitPlaybackEnded: () => void;
  getSourceKind?: () => string | null;
  getIsLive?: () => boolean;
}

export class HtmlVideoElementSession {
  private attached = false;
  private readonly seekController: VodSeekController;

  private readonly handleNativePlaybackError = (): void => {
    const video = this.config.video;
    const url = this.config.getChannelUrl() ?? video.currentSrc;
    this.config.emitPlaybackIssue(
      classifyNativePlaybackIssue(
        video.error,
        createPlaybackSourceMetadata({
          url,
          player: InlinePlaybackPlayer.Html5,
        }),
      ),
    );
  };

  private readonly clearPlaybackIssue = (): void => {
    this.config.emitPlaybackIssue(null);
  };

  private readonly handleVolumeChange = (): void => {
    const currentVolume = this.config.video.volume;
    debugHtmlPlayer("Volume changed to:", currentVolume);
    localStorage.setItem("volume", currentVolume.toString());
  };

  private readonly handleLoadedMetadata = (): void => {
    this.seekController.requestStartTime();
  };

  private readonly handleTimeUpdate = (): void => {
    const video = this.config.video;
    this.config.emitTimeUpdate({
      currentTime: video.currentTime,
      duration: video.duration,
    });
  };

  private readonly handlePlaybackEnded = (): void => {
    const sourceKind = this.config.getSourceKind?.();
    const liveStreamEnded =
      this.config.getIsLive?.() &&
      (sourceKind === "mpegts" || sourceKind === "hls");
    if (liveStreamEnded) {
      const url = this.config.getChannelUrl() ?? this.config.video.currentSrc;
      this.config.emitPlaybackIssue(
        sourceKind === "mpegts"
          ? classifyMpegTsPlaybackIssue(
              {
                type: "media",
                details: "early eof: live MPEG-TS stream ended unexpectedly",
              },
              createPlaybackSourceMetadata({
                url,
                mimeType: "video/mp2t",
                player: InlinePlaybackPlayer.Html5,
              }),
            )
          : classifyNativePlaybackIssue(
              {
                code: 3,
                message: "Live HLS stream reached EOF unexpectedly.",
              },
              createPlaybackSourceMetadata({
                url,
                mimeType: "application/x-mpegURL",
                player: InlinePlaybackPlayer.Html5,
              }),
            ),
      );
    } else {
      this.config.emitPlaybackEnded();
    }
  };

  private readonly listeners: ReadonlyArray<
    readonly [event: string, listener: EventListener]
  > = [
    ["volumechange", this.handleVolumeChange],
    ["loadedmetadata", this.handleLoadedMetadata],
    ["timeupdate", this.handleTimeUpdate],
    ["error", this.handleNativePlaybackError],
    ["playing", this.clearPlaybackIssue],
    ["ended", this.handlePlaybackEnded],
  ];

  constructor(private readonly config: HtmlVideoElementSessionConfig) {
    this.seekController = new VodSeekController({
      video: config.video,
      getStartTime: config.getStartTime,
      getDuration: () => config.video.duration,
      isVod: () => config.getIsLive?.() !== true,
      seek: (seconds) => {
        config.video.currentTime = seconds;
      },
    });
  }

  attach(): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.seekController.attach();
    for (const [event, listener] of this.listeners) {
      this.config.video.addEventListener(event, listener);
    }
  }

  resetForSourceChange(): void {
    this.seekController.reset();
  }

  play(): void {
    const playPromise = this.config.video.play();
    if (playPromise === undefined) {
      return;
    }

    // Autoplay failures are surfaced by the surrounding player UI. Caption
    // state is owned by WebVideoSourceTracks, which tracks the active
    // source engine instead of guessing once when playback starts.
    void playPromise.catch(() => undefined);
  }

  destroy(): void {
    if (!this.attached) {
      this.seekController.destroy();
      return;
    }
    this.attached = false;
    for (const [event, listener] of this.listeners) {
      this.config.video.removeEventListener(event, listener);
    }
    this.seekController.destroy();
  }
}
