import { Injectable, InjectionToken, inject } from "@angular/core";
import {
  SOURCE_PLAYBACK_POLICY as P,
  SourcePlaybackConfirmation,
  type SourcePlaybackReason,
  type ResolvedPortalPlayback,
  type ElectronBridgeApi,
  type AutoPlaybackPreparationResult,
} from "@arm-nator/shared/interfaces";
import type { SilentSessionDriver } from "./silent-media-session";
export type SourceProbeTransport = Pick<
  ElectronBridgeApi,
  | "prepareAutoPlayback"
  | "cancelAutoPlaybackPreparation"
  | "releaseAutoPlaybackSession"
>;
export const SOURCE_PROBE_TRANSPORT =
  new InjectionToken<SourceProbeTransport | null>("Source probe transport", {
    providedIn: "root",
    factory: () =>
      typeof window !== "undefined" &&
      typeof window.electron?.prepareAutoPlayback === "function"
        ? window.electron
        : null,
  });
export const SOURCE_PROBE_SESSION_FACTORY = new InjectionToken<
  () => SilentSessionDriver | null
>("Source probe session factory", {
  providedIn: "root",
  factory: () => () => null,
});
export interface SourceProbeResult {
  outcome: "played" | "failed" | "inconclusive" | "cancelled";
  reason: SourcePlaybackReason | null;
  elapsedMs: number;
  engine: "html5";
  audioOnly: boolean;
  retryAfterMs?: number;
}
@Injectable({ providedIn: "root" })
export class SourcePlaybackProbeService {
  private readonly transport = inject(SOURCE_PROBE_TRANSPORT);
  private factory = inject(SOURCE_PROBE_SESSION_FACTORY);
  private active = false;
  private draining: Promise<void> = Promise.resolve();
  private retryCleanup: (() => Promise<void>) | null = null;
  setSessionFactory(factory: () => SilentSessionDriver | null): void {
    this.factory = factory;
  }
  probe(
    playback: ResolvedPortalPlayback,
    signal: AbortSignal,
  ): Promise<SourceProbeResult> {
    if (this.active)
      return Promise.reject(
        new Error("A source check still owns its connection"),
      );
    const driver = this.factory(),
      bridge = this.transport;
    if (!bridge || !driver)
      return Promise.resolve({
        outcome: "inconclusive",
        reason: "engine-unavailable",
        elapsedMs: 0,
        engine: "html5",
        audioOnly: false,
      });
    this.active = true;
    const task = this.run(bridge, driver, playback, signal);
    this.draining = task.then(() => {
      this.active = false;
    });
    void this.draining.catch(() => undefined);
    return task;
  }
  drain(): Promise<void> {
    return this.retryCleanup?.() ?? this.draining;
  }
  private async run(
    bridge: SourceProbeTransport,
    driver: SilentSessionDriver,
    playback: ResolvedPortalPlayback,
    parent: AbortSignal,
  ): Promise<SourceProbeResult> {
    const started = performance.now(),
      attemptId = `source-check-${crypto.randomUUID()}`;
    let audioOnly = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new AbortController();
    const signal = AbortSignal.any([parent, deadline.signal]);
    const result = (
      outcome: SourceProbeResult["outcome"],
      reason: SourcePlaybackReason | null,
    ): SourceProbeResult => ({
      outcome,
      reason,
      elapsedMs: Math.max(0, performance.now() - started),
      engine: "html5",
      audioOnly,
    });
    let resolveAbort!: (value: SourceProbeResult) => void;
    const aborted = new Promise<SourceProbeResult>(
      (resolve) => (resolveAbort = resolve),
    );
    const abort = () =>
      resolveAbort(
        result(
          parent.aborted ? "cancelled" : "inconclusive",
          parent.aborted ? "cancelled" : "startup-timeout",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    let preparation: Promise<AutoPlaybackPreparationResult> | undefined;
    let prepared: AutoPlaybackPreparationResult | undefined;
    try {
      signal.throwIfAborted();
      timer = setTimeout(() => deadline.abort(), P.sampleMs);
      preparation = bridge.prepareAutoPlayback(
        playback.streamUrl,
        playback.headers ?? playback.recovery?.savedHeaders,
        playback.isLive === true,
        attemptId,
        playback.requestPolicy,
      );
      const first = await Promise.race([preparation, aborted]);
      if ("outcome" in first) return first;
      prepared = first;
      if (!prepared.ok) {
        const status = prepared.error.status;
        const failure = result(
          status === 401 || status === 403 || status === 404 || status === 410
            ? "failed"
            : "inconclusive",
          status === 401 || status === 403
            ? "provider-rejected"
            : status === 404 || status === 410
              ? "item-unavailable"
              : status === 429
                ? "provider-throttled"
                : "network-unknown",
        );
        const delay = prepared.error.retryAfterMs;
        return typeof delay === "number" && Number.isFinite(delay) && delay > 0
          ? { ...failure, retryAfterMs: delay }
          : failure;
      }
      if (signal.aborted)
        return result(
          parent.aborted ? "cancelled" : "inconclusive",
          parent.aborted ? "cancelled" : "startup-timeout",
        );
      const confirmation = new SourcePlaybackConfirmation();
      let resolvePlayed!: (value: SourceProbeResult) => void;
      const played = new Promise<SourceProbeResult>(
        (resolve) => (resolvePlayed = resolve),
      );
      const mounting = driver.start(
        {
          ...playback,
          streamUrl: prepared.session.url,
          preparedProxy: prepared.session,
        },
        signal,
        (sample) => {
          audioOnly = sample.audioOnly === true;
          if (confirmation.observe(sample))
            resolvePlayed(result("played", null));
        },
      );
      const startupFailure = mounting.then(
        () => new Promise<SourceProbeResult>(() => undefined),
        () =>
          result(
            signal.aborted && parent.aborted ? "cancelled" : "inconclusive",
            signal.aborted && parent.aborted
              ? "cancelled"
              : "engine-unavailable",
          ),
      );
      const outcomes = [played, aborted, startupFailure];
      if (driver.failure)
        outcomes.push(driver.failure.then((f) => result(f.outcome, f.reason)));
      return await Promise.race(outcomes);
    } catch {
      return result(
        parent.aborted ? "cancelled" : "inconclusive",
        parent.aborted ? "cancelled" : "network-unknown",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      // Retain only unacknowledged steps: a transient IPC/driver failure must
      // withhold ownership while allowing a later foreground request to retry.
      let steps: (() => Promise<unknown>)[] = [
        () => driver.close(),
        ...(signal.aborted
          ? [() => bridge.cancelAutoPlaybackPreparation(attemptId)]
          : []),
        async () => {
          const final = prepared ?? (await preparation?.catch(() => undefined));
          if (final?.ok)
            await bridge.releaseAutoPlaybackSession(final.session.id);
        },
      ];
      let pending: Promise<void> | null = null;
      const cleanup = (): Promise<void> => {
        if (pending) return pending;
        pending = Promise.allSettled(
          steps.map((step) => Promise.resolve().then(step)),
        )
          .then((results) => {
            const failed = results.flatMap((r, i) =>
              r.status === "rejected"
                ? [{ step: steps[i], reason: r.reason }]
                : [],
            );
            steps = failed.map((f) => f.step);
            if (failed.length)
              throw new AggregateError(
                failed.map((f) => f.reason),
                "Source playback cleanup was not acknowledged",
              );
            this.retryCleanup = null;
            this.draining = Promise.resolve();
            this.active = false;
          })
          .finally(() => {
            pending = null;
          });
        return pending;
      };
      this.retryCleanup = cleanup;
      await cleanup();
    }
  }
}
