const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const STABLE_PLAYBACK_MS = 15_000;

export interface LiveRecoveryScheduled {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

/**
 * Serializes live-engine reconnects and backs repeated failures off. A pending
 * reconnect is cancelled when playback genuinely resumes.
 */
export class LivePlaybackRecovery {
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(
    private readonly config: {
      readonly isLive: () => boolean;
      readonly restart: () => void;
      readonly onScheduled?: (event: LiveRecoveryScheduled) => void;
    },
  ) {}

  request(reason: string): boolean {
    if (
      this.destroyed ||
      !this.config.isLive() ||
      this.reconnectTimer !== undefined
    ) {
      return false;
    }

    this.markUnstable();
    this.attempt += 1;
    const delayMs =
      RETRY_DELAYS_MS[Math.min(this.attempt - 1, RETRY_DELAYS_MS.length - 1)];
    this.config.onScheduled?.({
      attempt: this.attempt,
      delayMs,
      reason,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.destroyed && this.config.isLive()) {
        this.config.restart();
      }
    }, delayMs);
    return true;
  }

  markPlaying(): void {
    if (this.destroyed || !this.config.isLive()) {
      return;
    }
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.attempt = 0;
    }, STABLE_PLAYBACK_MS);
  }

  markUnstable(): void {
    this.clearStableTimer();
  }

  reset(): void {
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.attempt = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.reset();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }
}
