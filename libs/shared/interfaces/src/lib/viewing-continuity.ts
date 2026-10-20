import type { ResolvedPortalPlayback } from "./portal-playback.interface";
import { normalizeTitleKeys } from "./title-normalization.util";

export interface CatalogueItemIdentity {
  sourceType: "xtream" | "stalker";
  playlistId: string;
  contentKind: "vod" | "series" | "episode" | "live";
  providerItemId: string;
}

export interface WorkDescriptor {
  kind: "movie" | "series" | "episode";
  title: string;
  releaseYear?: number | null;
  trustedIds?: { tmdb?: string; imdb?: string };
  series?: Omit<WorkDescriptor, "series" | "seasonNumber" | "episodeNumber">;
  seasonNumber?: number;
  episodeNumber?: number;
}

export function catalogueIdentityKey(identity: CatalogueItemIdentity): string {
  if (
    !["xtream", "stalker"].includes(identity.sourceType) ||
    !["vod", "series", "episode", "live"].includes(identity.contentKind) ||
    typeof identity.playlistId !== "string" ||
    !identity.playlistId.trim() ||
    typeof identity.providerItemId !== "string" ||
    !identity.providerItemId.trim()
  ) {
    throw new Error("Invalid catalogue item identity");
  }
  // Tuple serialization preserves opaque IDs, including leading zeros and separators.
  return JSON.stringify([
    identity.sourceType,
    identity.playlistId,
    identity.contentKind,
    identity.providerItemId,
  ]);
}

export function xtreamItemIdentity(
  playlistId: string,
  contentKind: CatalogueItemIdentity["contentKind"],
  id: number,
): CatalogueItemIdentity {
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error("Invalid Xtream item ID");
  const identity: CatalogueItemIdentity = {
    sourceType: "xtream",
    playlistId,
    contentKind,
    providerItemId: String(id),
  };
  catalogueIdentityKey(identity);
  return identity;
}

export function trustedWorkIds(work: WorkDescriptor): {
  tmdb?: string;
  imdb?: string;
} {
  const tmdb = work.trustedIds?.tmdb;
  const imdb = work.trustedIds?.imdb;
  return {
    ...(tmdb && /^[1-9]\d*$/.test(tmdb) ? { tmdb } : {}),
    ...(imdb && /^tt\d+$/.test(imdb) ? { imdb } : {}),
  };
}

/** Exact titles retain title years (Blade Runner 2049) unless the known release year equals the tag. */
export function workTitleYearKey(work: WorkDescriptor): string | null {
  if (
    !Number.isSafeInteger(work.releaseYear) ||
    (work.releaseYear ?? 0) < 1800 ||
    (work.releaseYear ?? 0) > 3000
  )
    return null;
  const keys = normalizeTitleKeys(work.title);
  const title = keys.trailingYear === work.releaseYear ? keys.base : keys.exact;
  return title ? JSON.stringify([work.kind, title, work.releaseYear]) : null;
}

export function worksMatch(
  left: WorkDescriptor,
  right: WorkDescriptor,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "episode") {
    if (
      !Number.isSafeInteger(left.seasonNumber) ||
      (left.seasonNumber ?? -1) < 0 ||
      !Number.isSafeInteger(left.episodeNumber) ||
      (left.episodeNumber ?? 0) < 1 ||
      left.seasonNumber !== right.seasonNumber ||
      left.episodeNumber !== right.episodeNumber ||
      left.series?.kind !== "series" ||
      right.series?.kind !== "series"
    )
      return false;
    return worksMatch(left.series, right.series);
  }
  const a = trustedWorkIds(left),
    b = trustedWorkIds(right);
  for (const key of ["tmdb", "imdb"] as const) {
    if (a[key] && b[key] && a[key] !== b[key]) return false;
  }
  if ((a.tmdb && a.tmdb === b.tmdb) || (a.imdb && a.imdb === b.imdb))
    return true;
  const key = workTitleYearKey(left);
  return key !== null && key === workTitleYearKey(right);
}

export function isPlaybackFinished(
  positionSeconds: number,
  durationSeconds: number | undefined | null,
): boolean {
  return (
    Number.isFinite(positionSeconds) &&
    positionSeconds >= 0 &&
    Number.isFinite(durationSeconds) &&
    (durationSeconds ?? 0) > 0 &&
    positionSeconds / (durationSeconds as number) >= 0.95
  );
}

export function transferablePosition(
  positionSeconds: number,
  fromDuration: number,
  toDuration: number,
): number | null {
  if (
    !Number.isFinite(positionSeconds) ||
    positionSeconds < 0 ||
    !Number.isFinite(fromDuration) ||
    fromDuration <= 0 ||
    !Number.isFinite(toDuration) ||
    toDuration <= 0 ||
    Math.abs(fromDuration - toDuration) >
      Math.max(30, 0.01 * Math.max(fromDuration, toDuration))
  )
    return null;
  return Math.min(1, positionSeconds / fromDuration) * toDuration;
}

export interface ViewingItem {
  activity?: {
    title: string;
    contentKind: "movie" | "series";
    providerItemId: string;
    categoryId: string;
    posterUrl?: string;
  };
  seriesIdentity?: CatalogueItemIdentity;
  identity: CatalogueItemIdentity;
  work: WorkDescriptor;
  legacyContentInfo?: {
    playlistId: string;
    contentXtreamId: number;
    contentType: "vod" | "episode";
    seriesXtreamId?: number;
    seasonNumber?: number;
    episodeNumber?: number;
  };
}
export interface ViewingStateUpdate {
  successfulAt?: number;
  item: ViewingItem;
  positionSeconds: number;
  durationSeconds?: number;
  confirmedAt: number;
  action?: "progress" | "finished" | "reset";
}
export interface ViewingResume {
  successfulAt?: number;
  positionSeconds: number;
  durationSeconds: number | null;
  confirmedAt: number;
  action: "progress" | "finished" | "reset";
  finished: boolean;
}

export function describeMovieWork(
  title: string,
  metadata: object | null | undefined,
): WorkDescriptor {
  const record = metadata as Record<string, unknown> | null | undefined;
  const yearValue =
    record?.["releaseDate"] ??
    record?.["release_date"] ??
    record?.["releasedate"] ??
    record?.["year"];
  const year = String(yearValue ?? "").match(/^(\d{4})(?:$|-)/)?.[1];
  return {
    kind: "movie",
    title,
    releaseYear: year ? Number(year) : undefined,
    trustedIds: {
      tmdb: record?.["tmdb_id"] == null ? undefined : String(record["tmdb_id"]),
      imdb: record?.["imdb_id"] == null ? undefined : String(record["imdb_id"]),
    },
  };
}

export function isViewingPositionFinished(
  position:
    | {
        positionSeconds: number;
        durationSeconds?: number | null;
        action?: "progress" | "finished" | "reset";
      }
    | null
    | undefined,
): boolean {
  return (
    !!position &&
    (position.action === "finished" ||
      (position.action !== "reset" &&
        isPlaybackFinished(position.positionSeconds, position.durationSeconds)))
  );
}

/** Raw provider history and its compatible shared resume; raw history is never replaced. */
export interface ViewingHistoryEntry {
  item: ViewingItem;
  workId: string | null;
  sharedAllowed: boolean;
  raw: ViewingResume;
  resume: ViewingResume | null;
}

export function viewingItemFromPlayback(
  playback: ResolvedPortalPlayback,
): ViewingItem {
  if (!playback.itemIdentity) throw new Error("Missing viewing identity");
  const identity = playback.itemIdentity;
  const legacy = playback.contentInfo;
  return {
    identity,
    work: playback.work ?? {
      kind: identity.contentKind === "episode" ? "episode" : "movie",
      title: playback.title,
    },
    legacyContentInfo:
      identity.sourceType === "stalker" &&
      legacy?.contentXtreamId === 0 &&
      identity.providerItemId !== "0"
        ? undefined
        : legacy,
    seriesIdentity: playback.seriesIdentity,
    activity: playback.historyContext,
  };
}
