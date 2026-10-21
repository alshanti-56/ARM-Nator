export interface BackgroundPlaybackLease {
  signal: AbortSignal;
  release(): Promise<void>;
}
/** An abort requests cancellation; only fulfilled cleanup releases ownership. */
export class PlaybackResourceCoordinator {
  private occupied = false;
  private readonly foreground = new Set<symbol>();
  private background: {
    abort: AbortController;
    close: () => Promise<void>;
    pending?: Promise<void>;
  } | null = null;
  private readonly cleanupTimeoutMs: number;
  constructor(options: { now?: () => number; cleanupTimeoutMs?: number } = {}) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 2000;
  }
  setOccupied(value: boolean): void {
    this.occupied = value;
  }
  isBlocked(): boolean {
    return (
      this.occupied || this.foreground.size > 0 || this.background !== null
    );
  }
  tryAcquireBackground(
    close: () => Promise<void>,
  ): BackgroundPlaybackLease | null {
    if (this.isBlocked()) return null;
    const slot = {
      abort: new AbortController(),
      close,
      pending: undefined as Promise<void> | undefined,
    };
    this.background = slot;
    return { signal: slot.abort.signal, release: () => this.release(slot) };
  }
  private release(
    slot: NonNullable<PlaybackResourceCoordinator["background"]>,
  ): Promise<void> {
    slot.abort.abort();
    if (slot.pending) return slot.pending;
    // Promise boundary also captures synchronous driver cleanup failures.
    slot.pending = Promise.resolve()
      .then(slot.close)
      .then(
        () => {
          if (this.background === slot) this.background = null;
        },
        (error) => {
          slot.pending = undefined;
          throw error;
        },
      );
    return slot.pending;
  }
  reserveForeground(): { ready: Promise<void> | null; finish(): void } {
    const token = Symbol();
    this.foreground.add(token);
    const finish = () => {
      this.foreground.delete(token);
    };
    if (!this.background) return { ready: null, finish };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const closing = this.release(this.background);
    const ready = Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Source check cleanup is still pending")),
          this.cleanupTimeoutMs,
        );
      }),
    ])
      .catch((error) => {
        finish();
        throw error;
      })
      .finally(() => {
        if (timeout !== undefined) clearTimeout(timeout);
      });
    return { ready, finish };
  }
  async beginForeground(): Promise<{ finish(): void }> {
    const reservation = this.reserveForeground();
    if (reservation.ready) await reservation.ready;
    return { finish: reservation.finish };
  }
}
