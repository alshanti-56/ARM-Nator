/** Safe, serializable source-check evidence. Never add resolved URLs or credentials. */
export type SourcePlaybackCategory = "live" | "movies" | "series";
export type SourcePlaybackResult =
  "untested" | "verified" | "mixed" | "failed" | "unstable";
export type SourcePlaybackOrigin = "background" | "manual" | "viewing";
export type SourcePlaybackReason =
  | "provider-rejected"
  | "item-unavailable"
  | "startup-timeout"
  | "stalled"
  | "unsupported-media"
  | "engine-unavailable"
  | "local-access"
  | "offline"
  | "network-unknown"
  | "provider-busy"
  | "provider-throttled"
  | "no-samples"
  | "cancelled"
  | "teardown-pending"
  | "save-failed"
  | "unsupported-category";
export interface SourceEvidenceKey {
  sourceId: string;
  revision: string;
  category: SourcePlaybackCategory;
}
export function sourceEvidenceKey(key: SourceEvidenceKey): string {
  return JSON.stringify([key.sourceId, key.revision, key.category]);
}
export interface SourceSampleEvidence {
  itemId: string;
  title: string;
  outcome: "played" | "failed" | "inconclusive" | "cancelled";
  reason: SourcePlaybackReason | null;
  elapsedMs: number;
  engine: string;
  audioOnly: boolean;
}
export interface SourceCheckAttempt {
  checkId: string;
  key: SourceEvidenceKey;
  origin: SourcePlaybackOrigin;
  startedAt: number;
  completedAt: number;
  samples: readonly SourceSampleEvidence[];
  reason: SourcePlaybackReason | null;
}
export interface SourcePlaybackObservation extends Omit<
  SourceCheckAttempt,
  "reason"
> {
  successfulAt: number | null;
  result: "verified" | "mixed" | "failed";
}
export interface SourcePlaybackSummary {
  key: SourceEvidenceKey;
  result: SourcePlaybackResult;
  latest: SourcePlaybackObservation | null;
  lastSuccessfulAt: number | null;
  stale: boolean;
  latestAttempt: SourceCheckAttempt | null;
}
export interface SourcePlaybackFilter {
  category: SourcePlaybackCategory | "all";
  result: SourcePlaybackResult | "any" | "working-recently";
}
export interface SourceAccountSnapshot {
  checkedAt: number;
  expiresAt: number | null;
  expiryKind: "date" | "none" | "unknown";
  activeConnections: number | null;
  maxConnections: number | null;
}
export interface SourceEvidenceSnapshot {
  sourceId: string;
  revision: string;
  observations: readonly SourcePlaybackObservation[];
  latest: readonly SourcePlaybackObservation[];
  lastSuccessfulAt: Partial<Record<SourcePlaybackCategory, number>>;
  attempts: readonly SourceCheckAttempt[];
  account: SourceAccountSnapshot | null;
  cursor: Partial<Record<SourcePlaybackCategory, string>>;
  nextEligibleAt: Partial<Record<SourcePlaybackCategory, number>>;
  inconclusiveCounts: Partial<Record<SourcePlaybackCategory, number>>;
}
export interface SourceEvidenceWrite {
  observation?: SourcePlaybackObservation;
  attempt: SourceCheckAttempt;
  cursor?: string;
  nextEligibleAt?: number;
  inconclusiveCount?: number;
}
export interface SourcePlaybackCandidate {
  cursor?: string;
  itemId: string;
  title: string;
  category: SourcePlaybackCategory;
  categoryId: string;
  episodeId?: string;
}
export const SOURCE_PLAYBACK_POLICY = Object.freeze({
  confirmationMs: 6000,
  confirmationSeconds: 6,
  progressGapMs: 3000,
  freshMs: 86400000,
  unstableWindowMs: 7 * 86400000,
  historyMs: 30 * 86400000,
  historyLimit: 20,
  sampleLimit: 3,
  discoveryMs: 10000,
  sampleMs: 20000,
  categoryMs: 70000,
  cleanupMs: 2000,
  idleMs: 10000,
  backoffMs: 900000,
  maxBackoffMs: 6 * 3600000,
  accountMs: 5000,
});
export interface SourceCandidateQuery {
  sourceId: string;
  category: SourcePlaybackCategory;
  limit?: number;
  cursor?: string;
  preferredItemId?: string;
}
export interface SourcePlaybackSampler {
  select(
    sourceId: string,
    category: SourcePlaybackCategory,
    signal: AbortSignal,
  ): Promise<readonly SourcePlaybackCandidate[]>;
  resolve(
    sourceId: string,
    candidate: SourcePlaybackCandidate,
    signal: AbortSignal,
  ): Promise<import("./portal-playback.interface").ResolvedPortalPlayback>;
}
