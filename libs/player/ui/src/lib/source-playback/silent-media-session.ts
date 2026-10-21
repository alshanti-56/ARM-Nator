import type {
  ResolvedPortalPlayback,
  SourceConfirmationInput,
  SourcePlaybackReason,
} from "@arm-nator/shared/interfaces";
import { readBrowserPlaybackEvidence } from "../playback-diagnostics/playback-evidence";
export interface SilentMediaFailure {
  outcome: "failed" | "inconclusive";
  reason: SourcePlaybackReason;
}
export interface SilentSessionDriver {
  readonly failure?: Promise<SilentMediaFailure>;
  start(
    playback: ResolvedPortalPlayback,
    signal: AbortSignal,
    observe: (sample: SourceConfirmationInput) => void,
  ): Promise<void>;
  close(): Promise<void>;
}
interface SilentMediaOptions {
  video: HTMLVideoElement;
  now?: () => number;
  every?: (tick: () => void) => () => void;
}
/** No settings, resume, history, foreground player, or native/external driver dependencies. */
export class SilentMediaSession implements SilentSessionDriver {
  readonly failure: Promise<SilentMediaFailure>;
  private fail!: (failure: SilentMediaFailure) => void;
  private readonly video: HTMLVideoElement;
  private readonly now: () => number;
  private readonly every: (tick: () => void) => () => void;
  private cleanup: (() => void)[] = [];
  private destroyDriver: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  constructor(options: SilentMediaOptions) {
    this.video = options.video;
    this.now = options.now ?? (() => performance.now());
    this.every =
      options.every ??
      ((tick) => {
        const timer = setInterval(tick, 250);
        return () => clearInterval(timer);
      });
    this.failure = new Promise((resolve) => (this.fail = resolve));
  }
  async start(
    playback: ResolvedPortalPlayback,
    signal: AbortSignal,
    observe: (sample: SourceConfirmationInput) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const video = this.video,
      generation = crypto.randomUUID();
    let stalled = false;
    video.muted = true;
    video.playsInline = true;
    video.tabIndex = -1;
    video.setAttribute("aria-hidden", "true");
    const listen = (event: string, callback: () => void) => {
      video.addEventListener(event, callback);
      this.cleanup.push(() => video.removeEventListener(event, callback));
    };
    listen("waiting", () => (stalled = true));
    listen("stalled", () => (stalled = true));
    listen("playing", () => (stalled = false));
    listen("canplay", () => (stalled = false));
    listen("error", () =>
      this.fail({ outcome: "failed", reason: "unsupported-media" }),
    );
    listen("ended", () =>
      this.fail({
        outcome: "inconclusive",
        reason: playback.isLive ? "stalled" : "network-unknown",
      }),
    );
    const abort = () => {
      void this.close().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    this.cleanup.push(() => signal.removeEventListener("abort", abort));
    const url = playback.streamUrl,
      format = playback.preparedProxy?.format;
    if (
      (format === "hls" || /\.m3u8(?:[?#]|$)/i.test(url)) &&
      !video.canPlayType("application/vnd.apple.mpegurl")
    ) {
      const { default: Hls } = await import("hls.js");
      signal.throwIfAborted();
      if (this.closed) throw new Error("Session closed");
      if (!Hls.isSupported()) throw new Error("HLS test engine unavailable");
      const driver = new Hls({ enableWorker: false });
      this.destroyDriver = () => driver.destroy();
      driver.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal)
          this.fail({
            outcome: data.type === "networkError" ? "inconclusive" : "failed",
            reason:
              data.type === "networkError"
                ? "network-unknown"
                : "unsupported-media",
          });
      });
      driver.loadSource(url);
      driver.attachMedia(video);
    } else if (format === "mpegts" || /\.ts(?:[?#]|$)/i.test(url)) {
      const { default: mpegts } = await import("mpegts.js");
      signal.throwIfAborted();
      if (this.closed) throw new Error("Session closed");
      if (!mpegts.isSupported())
        throw new Error("MPEG-TS test engine unavailable");
      const driver = mpegts.createPlayer(
        { type: "mpegts", isLive: playback.isLive === true, url },
        { enableWorker: false },
      );
      this.destroyDriver = () => {
        driver.pause();
        driver.unload();
        driver.detachMediaElement();
        driver.destroy();
      };
      driver.on(mpegts.Events.ERROR, () =>
        this.fail({ outcome: "inconclusive", reason: "network-unknown" }),
      );
      driver.attachMediaElement(video);
      driver.load();
    } else if (format === "dash" || /\.mpd(?:[?#]|$)/i.test(url)) {
      throw new Error("DASH test engine unavailable");
    } else {
      video.src = url;
      video.load();
    }
    signal.throwIfAborted();
    this.cleanup.push(
      this.every(() => {
        const media = readBrowserPlaybackEvidence(video);
        const audioBytes = (
          video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }
        ).webkitAudioDecodedByteCount;
        observe({
          generation,
          atMs: this.now(),
          positionSeconds: video.currentTime,
          playing: !video.paused && !video.ended && video.readyState >= 2,
          stalled,
          seeking: video.seeking,
          presentedFrames: media.presentedFrames,
          audioOnly:
            playback.preparedProxy?.audioOnly === true ||
            media.audioOnly === true,
          audioReady: typeof audioBytes === "number" && audioBytes > 0,
        });
      }),
    );
    await video.play();
    signal.throwIfAborted();
  }
  close(): Promise<void> {
    return (this.closing ??= Promise.resolve().then(() => {
      this.closed = true;
      for (const dispose of this.cleanup.splice(0)) dispose();
      this.video.pause();
      this.destroyDriver?.();
      this.destroyDriver = null;
      this.video.removeAttribute("src");
      this.video.load();
    }));
  }
}
