const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const STABLE_PLAYBACK_MS = 15_000;

export interface LiveRecoveryScheduled {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface LiveRecoveryExhausted {
  readonly attempts: number;
  readonly reason: string;
}

export interface LiveRecoveryRequestOptions {
  /** Keep a fatal-engine reconnect pending even if buffered media is still playing. */
  readonly cancelOnPlaying?: boolean;
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
  private recoveryStartedAt = 0;
  private cancelReconnectOnPlaying = true;

  constructor(
    private readonly config: {
      readonly isLive: () => boolean;
      readonly restart: () => void;
      readonly onScheduled?: (event: LiveRecoveryScheduled) => void;
      /** Return the current source's recovery budget in milliseconds. */
      readonly getRecoveryBudgetMs?: () => number;
      readonly onExhausted?: (event: LiveRecoveryExhausted) => void;
    },
  ) {}

  request(
    reason: string,
    options: LiveRecoveryRequestOptions = {},
  ): boolean {
    if (
      this.destroyed ||
      !this.config.isLive() ||
      this.reconnectTimer !== undefined
    ) {
      if (options.cancelOnPlaying === false) {
        this.cancelReconnectOnPlaying = false;
      }
      return false;
    }

    this.markUnstable();
    const now = Date.now();
    if (!this.recoveryStartedAt) {
      this.recoveryStartedAt = now;
    }
    const budgetMs = this.getRecoveryBudgetMs();
    if (budgetMs !== Infinity && now - this.recoveryStartedAt >= budgetMs) {
      this.finishExhausted(reason);
      return false;
    }

    const nextAttempt = this.attempt + 1;
    this.cancelReconnectOnPlaying = options.cancelOnPlaying !== false;
    this.attempt = nextAttempt;
    const delayMs =
      RETRY_DELAYS_MS[Math.min(this.attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const remainingMs =
      budgetMs === Infinity
        ? Infinity
        : Math.max(0, budgetMs - (now - this.recoveryStartedAt));
    const scheduledDelayMs =
      remainingMs === Infinity ? delayMs : Math.min(delayMs, remainingMs);
    this.config.onScheduled?.({
      attempt: this.attempt,
      delayMs: scheduledDelayMs,
      reason,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.destroyed || !this.config.isLive()) {
        return;
      }
      if (
        budgetMs !== Infinity &&
        Date.now() - this.recoveryStartedAt >= budgetMs
      ) {
        this.finishExhausted(reason);
        return;
      }
      this.config.restart();
    }, scheduledDelayMs);
    return true;
  }

  markPlaying(): void {
    if (this.destroyed || !this.config.isLive()) {
      return;
    }
    if (this.cancelReconnectOnPlaying) {
      this.clearReconnectTimer();
    }
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.attempt = 0;
      this.recoveryStartedAt = 0;
    }, STABLE_PLAYBACK_MS);
  }

  markUnstable(): void {
    this.clearStableTimer();
  }

  reset(): void {
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.attempt = 0;
    this.recoveryStartedAt = 0;
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
    this.cancelReconnectOnPlaying = true;
  }

  private getRecoveryBudgetMs(): number {
    const value = this.config.getRecoveryBudgetMs?.() ?? Infinity;
    return Number.isFinite(value) && value > 0 ? value : Infinity;
  }

  private finishExhausted(reason: string): void {
    const attempts = this.attempt;
    this.attempt = 0;
    this.recoveryStartedAt = 0;
    this.cancelReconnectOnPlaying = true;
    this.config.onExhausted?.({ attempts, reason });
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }
}
