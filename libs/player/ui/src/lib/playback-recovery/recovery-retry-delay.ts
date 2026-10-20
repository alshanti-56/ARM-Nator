/** One cancellable retry delay, including Retry-After dates beyond the timer limit. */
export function waitForRecoveryRetry(
  delayMs: number,
  signal: AbortSignal,
  onRemaining: (seconds: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + Math.max(0, delayMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Recovery cancelled"));
    };
    const tick = () => {
      if (signal.aborted) {
        abort();
        return;
      }
      const remaining = Math.max(0, deadline - Date.now());
      onRemaining(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        cleanup();
        resolve();
      } else timer = setTimeout(tick, Math.min(remaining, 1000));
    };
    signal.addEventListener("abort", abort, { once: true });
    tick();
  });
}
