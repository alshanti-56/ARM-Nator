import { sourceCheckBackoff } from "@arm-nator/player/core";
import type { SourcePlaybackActivity } from "@arm-nator/services";
import {
  SOURCE_PLAYBACK_POLICY as P,
  classifySourceCheck,
  type SourceCheckAttempt,
  type SourceEvidenceKey,
  type SourceEvidenceWrite,
  type SourcePlaybackOrigin,
  type SourcePlaybackCandidate,
  type ResolvedPortalPlayback,
  type SourcePlaybackReason,
  type SourceSampleEvidence,
} from "@arm-nator/shared/interfaces";
export interface SourceSampleDependencies {
  onProgress?(progress: Pick<SourcePlaybackActivity, "phase" | "sampleIndex" | "sampleCount" | "sampleTitle">): void;
  selectionCursor?(): string | undefined;
  prepare?(signal: AbortSignal): Promise<SourcePlaybackReason | null>;
  select(signal: AbortSignal): Promise<readonly SourcePlaybackCandidate[]>;
  resolve(
    candidate: SourcePlaybackCandidate,
    signal: AbortSignal,
  ): Promise<ResolvedPortalPlayback>;
  probe(
    playback: ResolvedPortalPlayback,
    signal: AbortSignal,
  ): Promise<{
    outcome: SourceSampleEvidence["outcome"];
    reason: SourcePlaybackReason | null;
    elapsedMs: number;
    engine: string;
    audioOnly: boolean;
    retryAfterMs?: number;
  }>;
  drain(): Promise<void>;
}
export function sourceDeadline(
  parent: AbortSignal,
  ms: number,
): { signal: AbortSignal; clear(): void } {
  const deadline = new AbortController(),
    timer = setTimeout(() => deadline.abort(), ms);
  return {
    signal: AbortSignal.any([parent, deadline.signal]),
    clear: () => clearTimeout(timer),
  };
}
export function sourceCheckFailure(error: unknown): {
  outcome: "failed" | "inconclusive";
  reason: SourcePlaybackReason;
} {
  const reason = (error as { reason?: unknown } | null)?.reason;
  if (reason === "unsupported-media" || reason === "provider-busy")
    return { outcome: "inconclusive", reason };
  const status = (error as { status?: number } | null)?.status;
  return {
    outcome:
      status === 401 || status === 403 || status === 404 || status === 410
        ? "failed"
        : "inconclusive",
    reason:
      status === 401 || status === 403
        ? "provider-rejected"
        : status === 404 || status === 410
          ? "item-unavailable"
          : status === 429
            ? "provider-throttled"
            : "network-unknown",
  };
}
export async function runSourceSampleCheck(
  key: SourceEvidenceKey,
  origin: SourcePlaybackOrigin,
  parent: AbortSignal,
  deps: SourceSampleDependencies,
): Promise<SourceEvidenceWrite> {
  const startedAt = Date.now(),
    category = sourceDeadline(parent, P.categoryMs);
  const samples: SourceSampleEvidence[] = [];
  let retryAfterMs = 0;
  const rememberDelay = (error: unknown) => {
    const delay = (error as { retryAfterMs?: number } | null)?.retryAfterMs;
    if (typeof delay === "number" && Number.isFinite(delay) && delay > 0)
      retryAfterMs = Math.max(retryAfterMs, delay);
  };
  let reason: SourcePlaybackReason | null = null,
    items: readonly SourcePlaybackCandidate[] = [];
  try {
    deps.onProgress?.({ phase: "discovering" });
    const deferred = await deps.prepare?.(category.signal);
    category.signal.throwIfAborted();
    if (deferred)
      throw Object.assign(Error("Source is busy"), { reason: deferred });
    const discovery = sourceDeadline(category.signal, P.discoveryMs);
    try {
      items = await deps.select(discovery.signal);
      discovery.signal.throwIfAborted();
      items = [
        ...new Map(items.map((c) => [c.episodeId ?? c.itemId, c])).values(),
      ].slice(0, P.sampleLimit);
    } finally {
      discovery.clear();
    }
    if (!items.length) reason = "no-samples";
    for (const candidate of items) {
      category.signal.throwIfAborted();
      deps.onProgress?.({
        phase: "sample",
        sampleIndex: samples.length + 1,
        sampleCount: items.length,
        sampleTitle: candidate.title,
      });
      const sample = sourceDeadline(category.signal, P.sampleMs),
        sampleStart = Date.now();
      let result: SourceSampleEvidence;
      try {
        const playback = await deps.resolve(candidate, sample.signal);
        sample.signal.throwIfAborted();
        const outcome = await deps.probe(playback, sample.signal);
        rememberDelay(outcome);
        const { retryAfterMs: _transportDelay, ...evidence } = outcome;
        result = {
          ...evidence,
          itemId: candidate.episodeId ?? candidate.itemId,
          title: candidate.title,
          elapsedMs: Math.max(outcome.elapsedMs, Date.now() - sampleStart),
        };
      } catch (error) {
        rememberDelay(error);
        result = {
          ...sourceCheckFailure(error),
          itemId: candidate.episodeId ?? candidate.itemId,
          title: candidate.title,
          elapsedMs: Math.max(0, Date.now() - sampleStart),
          engine: "html5",
          audioOnly: false,
        };
      } finally {
        await deps.drain();
        sample.clear();
      }
      if (category.signal.aborted)
        result = {
          ...result,
          outcome: "cancelled",
          reason: parent.aborted ? "cancelled" : "startup-timeout",
        };
      else if (sample.signal.aborted)
        result = {
          ...result,
          outcome: "inconclusive",
          reason: "startup-timeout",
        };
      samples.push(result);
      if (
        result.outcome === "played" ||
        result.reason === "provider-throttled" ||
        result.reason === "provider-busy" ||
        result.reason === "offline"
      )
        break;
    }
  } catch (error) {
    rememberDelay(error);
    reason = parent.aborted
      ? "cancelled"
      : category.signal.aborted
        ? "startup-timeout"
        : sourceCheckFailure(error).reason;
  } finally {
    category.clear();
  }
  if (parent.aborted) reason = "cancelled";
  const attempt: SourceCheckAttempt = {
    checkId: crypto.randomUUID(),
    key,
    origin,
    startedAt,
    completedAt: Date.now(),
    samples,
    reason,
  };
  const observation =
    reason === "cancelled"
      ? null
      : classifySourceCheck(
          attempt,
          items.length,
          samples.length === items.length && !category.signal.aborted,
        );
  return {
    attempt,
    ...(retryAfterMs ? { nextEligibleAt: Date.now() + retryAfterMs } : {}),
    ...(observation ? { observation } : {}),
    ...(items.length
      ? {
          cursor:
            items[Math.min(samples.length, items.length) - 1]?.cursor ??
            items[Math.min(samples.length, items.length) - 1]?.itemId,
        }
      : deps.selectionCursor?.()
        ? { cursor: deps.selectionCursor() }
        : {}),
  };
}
export interface SourceCheckPersistence {
  read(
    sourceIds: readonly string[],
  ): Promise<
    readonly import("@arm-nator/shared/interfaces").SourceEvidenceSnapshot[]
  >;
  write(input: SourceEvidenceWrite): Promise<"saved" | "obsolete">;
}
export async function runPersistedSourceCheck(
  key: SourceEvidenceKey,
  origin: SourcePlaybackOrigin,
  signal: AbortSignal,
  deps: SourceSampleDependencies,
  persistence: SourceCheckPersistence,
): Promise<"saved" | "obsolete"> {
  const current = (await persistence.read([key.sourceId]))[0];
  if (current?.revision !== key.revision) return "obsolete";
  const write = await runSourceSampleCheck(key, origin, signal, {
    ...deps,
    resolve: async (candidate, attemptSignal) => {
      const current = (await persistence.read([key.sourceId]))[0];
      if (current?.revision !== key.revision)
        throw Error("Source identity changed");
      return deps.resolve(candidate, attemptSignal);
    },
  });
  const count = write.observation
    ? 0
    : (current.inconclusiveCounts[key.category] ?? 0) + 1;
  return persistence.write({
    ...write,
    inconclusiveCount: count,
    nextEligibleAt: write.observation
      ? write.attempt.completedAt + P.freshMs
      : sourceCheckBackoff(
          {
            inconclusiveCount: count,
            retryAfterMs: Math.max(
              0,
              (write.nextEligibleAt ?? 0) - write.attempt.completedAt,
            ),
          },
          write.attempt.completedAt,
        ),
  });
}
