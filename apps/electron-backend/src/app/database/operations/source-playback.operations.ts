import type {
  SourceCandidateQuery,
  SourcePlaybackCandidate,
} from "@arm-nator/shared/interfaces";
import { sql } from "drizzle-orm";
import type { AppDatabase } from "../database.types";
import {
  SOURCE_PLAYBACK_POLICY as P,
  type SourceAccountSnapshot,
  type SourceCheckAttempt,
  type SourceEvidenceSnapshot,
  type SourceEvidenceWrite,
  type SourcePlaybackCategory,
  type SourcePlaybackObservation,
} from "@arm-nator/shared/interfaces";
const categories = ["live", "movies", "series"];
const reasons = [
  "provider-rejected",
  "item-unavailable",
  "startup-timeout",
  "stalled",
  "unsupported-media",
  "engine-unavailable",
  "local-access",
  "offline",
  "network-unknown",
  "provider-busy",
  "provider-throttled",
  "no-samples",
  "cancelled",
  "teardown-pending",
  "save-failed",
  "unsupported-category",
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid evidence object");
  return value as Record<string, unknown>;
}
function only(o: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw new Error("Unknown evidence field");
}
function string(v: unknown, max = 256): string {
  if (
    typeof v !== "string" ||
    !v.length ||
    v.length > max ||
    [...v].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("Invalid evidence string");
  return v;
}
function identifier(v: unknown, max = 256): string {
  const value = string(v, max);
  if (
    /https?:\/\/|[?&](?:token|username|password|mac|authorization)=|bearer\s/i.test(
      value,
    )
  )
    throw new Error("Unsafe evidence identifier");
  return value;
}
function time(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error("Invalid evidence time");
  return v;
}
export function validateSourceIds(ids: unknown): string[] {
  if (!Array.isArray(ids) || ids.length > 1000)
    throw new Error("Invalid source IDs");
  return [...new Set(ids.map((id) => identifier(id)))];
}
export function validateSourceEvidenceWrite(
  value: unknown,
): SourceEvidenceWrite {
  const w = object(value);
  only(w, [
    "attempt",
    "observation",
    "cursor",
    "nextEligibleAt",
    "inconclusiveCount",
  ]);
  const validate = (v: unknown, observation = false) => {
    const a = object(v);
    only(a, [
      "checkId",
      "key",
      "origin",
      "startedAt",
      "completedAt",
      "samples",
      ...(observation ? ["successfulAt", "result"] : ["reason"]),
    ]);
    const k = object(a.key);
    only(k, ["sourceId", "revision", "category"]);
    identifier(k.sourceId);
    identifier(k.revision);
    if (!categories.includes(String(k.category)))
      throw new Error("Invalid category");
    identifier(a.checkId);
    if (!["manual", "background", "viewing"].includes(String(a.origin)))
      throw new Error("Invalid origin");
    time(a.startedAt);
    time(a.completedAt);
    if (Number(a.startedAt) > Number(a.completedAt))
      throw new Error("Invalid observation order");
    if (!Array.isArray(a.samples) || a.samples.length > 3)
      throw new Error("Invalid sample count");
    for (const entry of a.samples) {
      const s = object(entry);
      only(s, [
        "itemId",
        "title",
        "outcome",
        "reason",
        "elapsedMs",
        "engine",
        "audioOnly",
      ]);
      identifier(s.itemId);
      string(s.title, 500);
      string(s.engine, 30);
      time(s.elapsedMs);
      if (
        typeof s.audioOnly !== "boolean" ||
        !["played", "failed", "inconclusive", "cancelled"].includes(
          String(s.outcome),
        )
      )
        throw new Error("Invalid sample");
      if (s.reason !== null && !reasons.includes(String(s.reason)))
        throw new Error("Invalid sample reason");
      s.title = String(s.title).replace(/https?:\/\/\S+/gi, "[redacted]");
    }
    if (observation) {
      if (!["verified", "mixed", "failed"].includes(String(a.result)))
        throw new Error("Invalid result");
      if (a.successfulAt !== null) time(a.successfulAt);
    } else if (a.reason !== null && !reasons.includes(String(a.reason)))
      throw new Error("Invalid attempt reason");
  };
  // Copy before sanitization; callers retain their own immutable evidence.
  const clean = JSON.parse(JSON.stringify(w));
  validate(clean.attempt);
  if (clean.observation) {
    validate(clean.observation, true);
    if (
      JSON.stringify(clean.observation.key) !==
        JSON.stringify(clean.attempt.key) ||
      clean.observation.checkId !== clean.attempt.checkId
    )
      throw new Error("Evidence identity mismatch");
  }
  if (clean.cursor !== undefined) identifier(clean.cursor);
  if (clean.nextEligibleAt !== undefined) time(clean.nextEligibleAt);
  if (
    clean.inconclusiveCount !== undefined &&
    (!Number.isSafeInteger(clean.inconclusiveCount) ||
      clean.inconclusiveCount < 0)
  )
    throw new Error("Invalid backoff");
  return clean as SourceEvidenceWrite;
}
export function readSourcePlaybackEvidence(
  db: AppDatabase,
  ids: unknown,
): SourceEvidenceSnapshot[] {
  const sourceIds = validateSourceIds(ids);
  if (!sourceIds.length) return [];
  const rows = db.all<{ source_id: string; revision: string }>(
    sql`SELECT source_id,revision FROM source_playback_sources WHERE source_id IN (${sql.join(
      sourceIds.map((id) => sql`${id}`),
      sql`,`,
    )})`,
  );
  return rows.map((row) => {
    const data: SourceEvidenceSnapshot = {
      sourceId: row.source_id,
      revision: row.revision,
      observations: [],
      latest: [],
      lastSuccessfulAt: {},
      attempts: [],
      account: null,
      cursor: {},
      nextEligibleAt: {},
      inconclusiveCounts: {},
    };
    const cats = db.all<{
      category: SourcePlaybackCategory;
      latest: string | null;
      successful_at: number | null;
      attempt: string | null;
      cursor: string | null;
      next_eligible_at: number | null;
      inconclusive_count: number;
    }>(
      sql`SELECT * FROM source_playback_categories WHERE source_id=${row.source_id}`,
    );
    for (const c of cats) {
      if (c.latest)
        (data.latest as SourcePlaybackObservation[]).push(JSON.parse(c.latest));
      if (c.attempt)
        (data.attempts as SourceCheckAttempt[]).push(JSON.parse(c.attempt));
      if (c.successful_at !== null)
        data.lastSuccessfulAt[c.category] = c.successful_at;
      if (c.cursor) data.cursor[c.category] = c.cursor;
      if (c.next_eligible_at !== null)
        data.nextEligibleAt[c.category] = c.next_eligible_at;
      data.inconclusiveCounts[c.category] = c.inconclusive_count;
    }
    data.observations = db
      .all<{ observation: string }>(
        sql`SELECT observation FROM source_playback_observations WHERE source_id=${row.source_id} ORDER BY completed_at`,
      )
      .map((o) => JSON.parse(o.observation));
    const account = db.get<{ snapshot: string }>(
      sql`SELECT snapshot FROM source_playback_accounts WHERE source_id=${row.source_id}`,
    );
    if (account) data.account = JSON.parse(account.snapshot);
    return data;
  });
}
export function saveSourcePlaybackEvidence(
  db: AppDatabase,
  input: unknown,
): "saved" | "obsolete" {
  const w = validateSourceEvidenceWrite(input),
    a = w.attempt,
    k = a.key;
  return db.transaction((tx) => {
    const current = tx.get<{ revision: string }>(
      sql`SELECT revision FROM source_playback_sources WHERE source_id=${k.sourceId}`,
    );
    if (current?.revision !== k.revision) return "obsolete" as const;
    const old = tx.get<{
      latest: string | null;
      attempt: string | null;
      successful_at: number | null;
    }>(
      sql`SELECT latest,attempt,successful_at FROM source_playback_categories WHERE source_id=${k.sourceId} AND category=${k.category}`,
    );
    const previous = old?.latest
      ? (JSON.parse(old.latest) as SourcePlaybackObservation)
      : null;
    const previousAttempt = old?.attempt
      ? (JSON.parse(old.attempt) as SourceCheckAttempt)
      : null;
    const newer = (
      candidate: SourceCheckAttempt | SourcePlaybackObservation,
      previous: SourceCheckAttempt | SourcePlaybackObservation | null,
    ) =>
      !previous ||
      candidate.startedAt > previous.startedAt ||
      (candidate.startedAt === previous.startedAt &&
        candidate.completedAt >= previous.completedAt);
    const latest =
      w.observation && newer(w.observation, previous)
        ? w.observation
        : previous;
    const attempt = newer(a, previousAttempt) ? a : previousAttempt;
    const successful =
      Math.max(old?.successful_at ?? 0, w.observation?.successfulAt ?? 0) ||
      null;
    tx.run(
      sql`INSERT INTO source_playback_categories(source_id,category,latest,successful_at,attempt,cursor,next_eligible_at,inconclusive_count) VALUES(${k.sourceId},${k.category},${latest ? JSON.stringify(latest) : null},${successful},${JSON.stringify(attempt)},${w.cursor ?? null},${w.nextEligibleAt ?? null},${w.inconclusiveCount ?? 0}) ON CONFLICT(source_id,category) DO UPDATE SET latest=excluded.latest,successful_at=excluded.successful_at,attempt=excluded.attempt,cursor=COALESCE(excluded.cursor,cursor),next_eligible_at=COALESCE(excluded.next_eligible_at,next_eligible_at),inconclusive_count=${w.inconclusiveCount ?? sql`inconclusive_count`}`,
    );
    if (w.observation)
      tx.run(
        sql`INSERT INTO source_playback_observations VALUES(${k.sourceId},${k.category},${a.checkId},${w.observation.completedAt},${JSON.stringify(w.observation)}) ON CONFLICT(source_id,category,check_id) DO UPDATE SET completed_at=excluded.completed_at,observation=excluded.observation WHERE excluded.completed_at>=completed_at`,
      );
    tx.run(
      sql`DELETE FROM source_playback_observations WHERE source_id=${k.sourceId} AND category=${k.category} AND (completed_at<${Date.now() - P.historyMs} OR check_id NOT IN (SELECT check_id FROM source_playback_observations WHERE source_id=${k.sourceId} AND category=${k.category} ORDER BY completed_at DESC,check_id DESC LIMIT ${P.historyLimit}))`,
    );
    return "saved" as const;
  });
}
export function saveSourcePlaybackAccount(
  db: AppDatabase,
  sourceId: string,
  revision: string,
  input: SourceAccountSnapshot,
): "saved" | "obsolete" {
  string(sourceId);
  string(revision);
  const account = object(input);
  only(account, [
    "checkedAt",
    "expiresAt",
    "expiryKind",
    "activeConnections",
    "maxConnections",
  ]);
  time(account.checkedAt);
  if (!["date", "none", "unknown"].includes(String(account.expiryKind)))
    throw new Error("Invalid expiry");
  for (const field of ["expiresAt", "activeConnections", "maxConnections"])
    if (account[field] !== null) time(account[field]);
  return db.transaction((tx) => {
    const source = tx.get<{ revision: string }>(
      sql`SELECT revision FROM source_playback_sources WHERE source_id=${sourceId}`,
    );
    if (source?.revision !== revision) return "obsolete" as const;
    const old = tx.get<{ snapshot: string }>(
      sql`SELECT snapshot FROM source_playback_accounts WHERE source_id=${sourceId}`,
    );
    if (old && JSON.parse(old.snapshot).checkedAt > input.checkedAt)
      return "obsolete" as const;
    tx.run(
      sql`INSERT INTO source_playback_accounts VALUES(${sourceId},${JSON.stringify(input)}) ON CONFLICT(source_id) DO UPDATE SET snapshot=excluded.snapshot`,
    );
    return "saved" as const;
  });
}

export function getSourcePlaybackCandidates(
  db: AppDatabase,
  input: SourceCandidateQuery,
): SourcePlaybackCandidate[] {
  const args = object(input);
  only(args, ["sourceId", "category", "limit", "cursor", "preferredItemId"]);
  string(input.sourceId);
  if (!categories.includes(input.category)) throw new Error("Invalid category");
  const limit = input.limit ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3)
    throw new Error("Invalid sample limit");
  const type = input.category === "movies" ? "movie" : input.category;
  const selected: SourcePlaybackCandidate[] = [];
  const query = (extra: ReturnType<typeof sql>, count: number) =>
    db
      .all<{
        id: number;
        category_id: number;
        xtream_id: number;
        title: string;
        provider_category: number;
      }>(
        sql`SELECT c.id,c.category_id,c.xtream_id,c.title,cat.xtream_id AS provider_category FROM content c JOIN categories cat ON cat.id=c.category_id WHERE cat.playlist_id=${input.sourceId} AND cat.type=${input.category} AND c.type=${type} AND cat.hidden=0 AND cat.available=1 AND c.available=1 AND ${extra} ORDER BY cat.id,c.id LIMIT ${count}`,
      )
      .map((row) => ({
        itemId: String(row.xtream_id),
        title: row.title,
        category: input.category,
        categoryId: String(row.provider_category),
        cursor: row.category_id + ":" + row.id,
      }));
  if (input.preferredItemId)
    selected.push(...query(sql`c.xtream_id=${input.preferredItemId}`, 1));
  const cursor = /^(\d+):(\d+)$/.exec(input.cursor ?? "");
  const after = cursor
    ? sql`(cat.id>${Number(cursor[1])} OR (cat.id=${Number(cursor[1])} AND c.id>${Number(cursor[2])}))`
    : sql`1=1`;
  const add = (items: SourcePlaybackCandidate[]) => {
    for (const item of items)
      if (
        selected.length < limit &&
        !selected.some((s) => s.itemId === item.itemId)
      )
        selected.push(item);
  };
  add(query(after, limit));
  if (selected.length < limit) add(query(sql`1=1`, limit));
  return selected;
}
