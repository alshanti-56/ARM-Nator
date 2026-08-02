export type BulkTestSourceType = "xtream" | "m3u";

export type BulkTestStatus =
  | "pending"
  | "testing"
  | "working"
  | "expired"
  | "disabled"
  | "invalid-credentials"
  | "invalid-url"
  | "timeout"
  | "server-offline"
  | "server-error"
  | "unknown-error"
  | "cancelled";

export interface BulkTestCandidate {
  readonly id: string;
  readonly type: BulkTestSourceType;
  readonly originalText: string;
  readonly serverUrl: string;
  readonly playlistUrl: string;
  readonly username: string;
  readonly password: string;
  readonly normalizedKey: string;
}

export interface BulkInvalidEntry {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
}

export interface BulkParseResult {
  readonly candidates: readonly BulkTestCandidate[];
  readonly duplicates: readonly BulkTestCandidate[];
  readonly invalidEntries: readonly BulkInvalidEntry[];
}

export interface BulkTestResult {
  readonly id: string;
  readonly candidate: BulkTestCandidate;
  status: BulkTestStatus;
  message: string;
  selected: boolean;
  responseTimeMs?: number;
  httpStatus?: number;
  accountStatus?: string;
  expiresAt?: string;
  activeConnections?: string;
  maxConnections?: string;
  liveCategoriesCount?: number;
  moviesCount?: number;
  seriesCount?: number;
  playlistChannelCount?: number;
  lastCheckedAt?: number;
}

export type BulkResultFilter =
  "all" | "working" | "failed" | "expired" | "invalid";

export const BULK_TEST_FAILURE_STATUSES: ReadonlySet<BulkTestStatus> = new Set([
  "expired",
  "disabled",
  "invalid-credentials",
  "invalid-url",
  "timeout",
  "server-offline",
  "server-error",
  "unknown-error",
  "cancelled",
]);
