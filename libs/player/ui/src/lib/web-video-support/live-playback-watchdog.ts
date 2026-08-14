const WATCHDOG_INTERVAL_MS = 1_000;
const NO_PROGRESS_TIMEOUT_MS = 8_000;
const UNSTABLE_TIMEOUT_MS = 4_000;
const MINIMUM_PROGRESS_SECONDS = 0.05;

export interface LivePlaybackWatchdogConfig {
  readonly isLive: () => boolean;
  readonly onNoProgress: (reason: string) => void;
  readonly onPlaying?: () => void;
  readonly onUnstable?: () => void;
  readonly onUserPause?: () => void;
}

/**
 * Detects live playback that remains unpaused but stops advancing. Media-engine
 * errors do not cover every dead connection, so this supplies the missing
 * no-progress recovery signal without reacting to short rebuffering events.
 */
export class LivePlaybackWatchdog {
  private video: HTMLVideoElement | null = null;
  private config: LivePlaybackWatchdogConfig | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCurrentTime = 0;
  private lastProgressAt = 0;
  private unstableSince = 0;
  private userPausedIntent = false;

  private readonly handlePlaying = (): void => {
    this.unstableSince = 0;
    this.markProgress();
    this.config?.onPlaying?.();
  };

  private readonly handleTimeUpdate = (): void => {
    this.observeProgress();
  };

  private readonly handleUnstable = (): void => {
    if (!this.unstableSince) {
      this.unstableSince = Date.now();
    }
    this.config?.onUnstable?.();
  };

  private readonly handleEnded = (): void => {
    if (this.config?.isLive() && !this.userPausedIntent) {
      this.config.onNoProgress('Live playback ended unexpectedly.');
    }
  };

  notifyPlaybackIntent(intent: 'play' | 'pause'): void {
    this.userPausedIntent = intent === 'pause';
    if (this.userPausedIntent) {
      this.config?.onUserPause?.();
    }
  }

  start(video: HTMLVideoElement, config: LivePlaybackWatchdogConfig): void {
    this.stop();
    this.video = video;
    this.config = config;
    this.lastCurrentTime = video.currentTime;
    this.lastProgressAt = Date.now();
    video.addEventListener("playing", this.handlePlaying);
    video.addEventListener("timeupdate", this.handleTimeUpdate);
    video.addEventListener("waiting", this.handleUnstable);
    video.addEventListener("stalled", this.handleUnstable);
    video.addEventListener("ended", this.handleEnded);
    this.timer = setInterval(() => this.checkProgress(), WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    const video = this.video;
    if (video) {
      video.removeEventListener("playing", this.handlePlaying);
      video.removeEventListener("timeupdate", this.handleTimeUpdate);
      video.removeEventListener("waiting", this.handleUnstable);
      video.removeEventListener("stalled", this.handleUnstable);
      video.removeEventListener("ended", this.handleEnded);
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.video = null;
    this.config = null;
    this.lastCurrentTime = 0;
    this.lastProgressAt = 0;
    this.unstableSince = 0;
  }

  destroy(): void {
    this.stop();
  }

  private checkProgress(): void {
    const video = this.video;
    const config = this.config;
    if (!video || !config) {
      return;
    }

    if (!config.isLive() || video.ended) {
      this.markProgress();
      return;
    }

    if (this.userPausedIntent) {
      return;
    }

    if (this.observeProgress()) {
      return;
    }

    if (
      this.unstableSince &&
      Date.now() - this.unstableSince >= UNSTABLE_TIMEOUT_MS
    ) {
      this.unstableSince = Date.now();
      config.onNoProgress(
        `Live playback remained unstable for ${Math.round(
          UNSTABLE_TIMEOUT_MS / 1_000,
        )} seconds.`,
      );
      return;
    }

    // A pause without a preceding waiting/stalled signal is normally a user
    // action and must not restart the channel behind their back.
    if (video.paused) {
      return;
    }

    const stalledForMs = Date.now() - this.lastProgressAt;
    if (stalledForMs < NO_PROGRESS_TIMEOUT_MS) {
      return;
    }

    // Re-arm before invoking recovery so one dead engine cannot cause a
    // reconnect storm while its scheduled restart is pending.
    this.lastProgressAt = Date.now();
    config.onNoProgress(
      `Live playback made no progress for ${Math.round(
        stalledForMs / 1_000,
      )} seconds.`,
    );
  }

  private observeProgress(): boolean {
    const video = this.video;
    if (!video) {
      return false;
    }
    if (video.currentTime - this.lastCurrentTime >= MINIMUM_PROGRESS_SECONDS) {
      this.markProgress();
      return true;
    }
    return false;
  }

  private markProgress(): void {
    this.unstableSince = 0;
    if (this.video) {
      this.lastCurrentTime = this.video.currentTime;
    }
    this.lastProgressAt = Date.now();
  }
}
