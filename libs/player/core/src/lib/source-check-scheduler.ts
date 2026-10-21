import {
  SOURCE_PLAYBACK_POLICY as P,
  sourceEvidenceKey,
  type SourceEvidenceKey,
  type SourcePlaybackCategory,
} from "@arm-nator/shared/interfaces";
export interface SourceCheckScheduleInput {
  keys: readonly SourceEvidenceKey[];
  supported: readonly SourcePlaybackCategory[];
  due: ReadonlyMap<string, number>;
  busySourceIds: ReadonlySet<string>;
  occupied: boolean;
  idleSince: number | null;
  lastServedKey: string | null;
}
export function nextSourceCheck(
  input: SourceCheckScheduleInput,
  now: number,
): SourceEvidenceKey | null {
  if (
    input.occupied ||
    input.idleSince === null ||
    now - input.idleSince < P.idleMs
  )
    return null;
  const sourceIds = [...new Set(input.keys.map((key) => key.sourceId))];
  const previous = input.keys.find(
    (k) => sourceEvidenceKey(k) === input.lastServedKey,
  );
  const lastSource = previous ? sourceIds.indexOf(previous.sourceId) : -1;
  for (let offset = 1; offset <= sourceIds.length; offset++) {
    const sourceId = sourceIds[(lastSource + offset) % sourceIds.length];
    if (input.busySourceIds.has(sourceId)) continue;
    const key = input.keys.find(
      (key) =>
        key.sourceId === sourceId &&
        input.supported.includes(key.category) &&
        (input.due.get(sourceEvidenceKey(key)) ?? 0) <= now,
    );
    if (key) return key;
  }
  return null;
}
export function sourceCheckBackoff(
  input: { inconclusiveCount: number; retryAfterMs?: number },
  now: number,
): number {
  return (
    now +
    Math.max(
      Math.min(
        P.backoffMs *
          2 ** Math.max(0, Math.min(30, input.inconclusiveCount - 1)),
        P.maxBackoffMs,
      ),
      Number.isFinite(input.retryAfterMs)
        ? Math.max(0, input.retryAfterMs ?? 0)
        : 0,
    )
  );
}
