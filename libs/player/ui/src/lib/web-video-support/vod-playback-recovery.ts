export type VodRecoveryKind = 'asset' | 'media';
export type VodRecoveryState =
  | 'idle'
  | 'recovering-asset'
  | 'recovering-media'
  | 'failed'
  | 'destroyed';

export interface VodRecoveryExhausted {
  readonly attempts: number;
  readonly kind: VodRecoveryKind;
  readonly reason: string;
}

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;
const DEFAULT_RECOVERY_BUDGET_MS = 10_000;
const STABLE_PLAYBACK_MS = 8_000;

/**
 * Bounded, single-flight recovery for finite assets. It deliberately has no
 * playlist polling or live-edge policy: VOD recovery only retries the active
 * asset operation and becomes terminal after a finite deadline.
 */
export class VodPlaybackRecovery {
  private stateValue: VodRecoveryState = 'idle';
  private attempt = 0;
  private startedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private retryKind: VodRecoveryKind = 'asset';

  constructor(
    private readonly config: {
      readonly retry: (kind: VodRecoveryKind) => void;
      readonly onExhausted: (event: VodRecoveryExhausted) => void;
      readonly getRecoveryBudgetMs?: () => number;
    },
  ) {}

  get state(): VodRecoveryState {
    return this.stateValue;
  }

  request(kind: VodRecoveryKind, reason: string): boolean {
    if (this.stateValue === 'destroyed' || this.stateValue === 'failed') {
      return false;
    }
    if (this.retryTimer !== undefined) {
      return false;
    }

    const now = Date.now();
    if (!this.startedAt) {
      this.startedAt = now;
    }
    const budgetMs = this.getRecoveryBudgetMs();
    if (now - this.startedAt >= budgetMs) {
      this.finish(kind, reason);
      return false;
    }

    this.clearStableTimer();
    this.retryKind = kind;
    this.stateValue =
      kind === 'media' ? 'recovering-media' : 'recovering-asset';
    this.attempt += 1;

    const delayMs = RETRY_DELAYS_MS[
      Math.min(this.attempt - 1, RETRY_DELAYS_MS.length - 1)
    ];
    const remainingMs = Math.max(0, budgetMs - (now - this.startedAt));
    const scheduledDelayMs = Math.min(delayMs, remainingMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stateValue === 'destroyed') {
        return;
      }
      if (Date.now() - this.startedAt >= budgetMs) {
        this.finish(kind, reason);
        return;
      }
      this.config.retry(this.retryKind);
    }, scheduledDelayMs);
    return true;
  }

  markProgress(): void {
    if (this.stateValue === 'failed') {
      this.reset();
      return;
    }
    if (
      this.stateValue !== 'recovering-asset' &&
      this.stateValue !== 'recovering-media'
    ) {
      return;
    }

    this.clearRetryTimer();
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.reset();
    }, STABLE_PLAYBACK_MS);
  }

  reset(): void {
    if (this.stateValue === 'destroyed') {
      return;
    }
    this.clearRetryTimer();
    this.clearStableTimer();
    this.stateValue = 'idle';
    this.attempt = 0;
    this.startedAt = 0;
    this.retryKind = 'asset';
  }

  destroy(): void {
    this.clearRetryTimer();
    this.clearStableTimer();
    this.stateValue = 'destroyed';
    this.attempt = 0;
    this.startedAt = 0;
  }

  private finish(kind: VodRecoveryKind, reason: string): void {
    this.clearRetryTimer();
    this.clearStableTimer();
    const attempts = this.attempt;
    this.stateValue = 'failed';
    this.attempt = 0;
    this.startedAt = 0;
    this.config.onExhausted({ attempts, kind, reason });
  }

  private getRecoveryBudgetMs(): number {
    const value = this.config.getRecoveryBudgetMs?.() ?? DEFAULT_RECOVERY_BUDGET_MS;
    return Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_RECOVERY_BUDGET_MS;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }
}
