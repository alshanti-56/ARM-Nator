import {
  catalogueIdentityKey,
  trustedWorkIds,
  worksMatch,
  workTitleYearKey,
} from "./viewing-continuity";
import type {
  CatalogueItemIdentity,
  WorkDescriptor,
} from "./viewing-continuity";
import { normalizeTrackLanguage } from "./title-track-preferences";
import { normalizeTitleKeys } from "./title-normalization.util";

/** Provider-neutral discovery data; resolving a version is a separate, user-selected operation. */
export interface DiscoveryVersion {
  identity: CatalogueItemIdentity;
  providerName: string;
  categoryId: string;
  originalTitle: string;
  contentType: "movie" | "series" | "live";
  posterUrl?: string;
  backdropUrl?: string;
  description?: string;
  genre?: string;
  work?: WorkDescriptor;
  /** UI-only catalogue year; never use this for work identity or grouping. */
  displayYear?: number;
  resolution?: number;
  languages?: string[];
  navigation: string[];
  navigationState?: Record<string, unknown>;
}
export interface GroupedGlobalSearchResult {
  key: string;
  versions: DiscoveryVersion[];
}
export interface PortalSearchContinuation {
  contentType: "movie" | "series" | "live";
  page: number;
}
export interface PortalSearchSourceStatus {
  playlistId: string;
  providerName: string;
  state: "idle" | "searching" | "partial" | "complete" | "error" | "cancelled";
  resultCount: number;
  error?: string;
  continuation: PortalSearchContinuation[];
}
export interface PortalSearchPage {
  versions: DiscoveryVersion[];
  continuation?: PortalSearchContinuation;
}
export interface DiscoveryRanking {
  successfulAt?: Readonly<Record<string, number>>;
  language?: string;
  sourceOrder?: readonly string[];
}

function discoveryWorkTitleKey(work: WorkDescriptor): string | null {
  const keys = normalizeTitleKeys(work.title);
  const hasKnownYear =
    Number.isSafeInteger(work.releaseYear) &&
    (work.releaseYear ?? 0) >= 1800 &&
    (work.releaseYear ?? 0) <= 3000;
  const title =
    hasKnownYear && keys.trailingYear === work.releaseYear
      ? keys.base
      : keys.exact;
  return title ? JSON.stringify([work.kind, title]) : null;
}

function knownReleaseYear(work: WorkDescriptor): number | null {
  return Number.isSafeInteger(work.releaseYear) &&
    (work.releaseYear ?? 0) >= 1800 &&
    (work.releaseYear ?? 0) <= 3000
    ? work.releaseYear!
    : null;
}

function discoveryWorksMatch(
  left: WorkDescriptor,
  right: WorkDescriptor,
  knownYears: Set<number> | undefined,
): boolean {
  if (worksMatch(left, right)) return true;
  const titleKey = discoveryWorkTitleKey(left);
  const leftYear = knownReleaseYear(left);
  const rightYear = knownReleaseYear(right);
  const bothYearless = leftYear === null && rightYear === null;
  if (
    !titleKey ||
    titleKey !== discoveryWorkTitleKey(right) ||
    (!bothYearless && (leftYear === null) === (rightYear === null))
  )
    return false;
  const knownYear = leftYear ?? rightYear;
  if (
    knownYears?.size !== 1 ||
    (knownYear !== null && !knownYears.has(knownYear))
  )
    return false;
  const leftIds = trustedWorkIds(left);
  const rightIds = trustedWorkIds(right);
  return !(["tmdb", "imdb"] as const).some(
    (id) => leftIds[id] && rightIds[id] && leftIds[id] !== rightIds[id],
  );
}

/** Complete-link grouping prevents a weak alias from bridging conflicting trusted IDs. */
export function groupDiscoveryVersions(
  input: readonly DiscoveryVersion[],
): GroupedGlobalSearchResult[] {
  const unique = [
    ...new Map(
      input.map((v) => [catalogueIdentityKey(v.identity), v]),
    ).values(),
  ];
  interface Candidate {
    version: DiscoveryVersion;
    key: string;
    order: number;
    keys: string[];
    trusted: boolean;
    titleKey: string | null;
    year: number | null;
  }
  interface Group {
    rows: Candidate[];
    descriptors: Map<string, WorkDescriptor>;
    type: DiscoveryVersion["contentType"];
  }
  const candidates: Candidate[] = unique.map((version, order) => {
    const ids = version.work ? trustedWorkIds(version.work) : {};
    const title = version.work ? workTitleYearKey(version.work) : null;
    const titleKey = version.work
      ? discoveryWorkTitleKey(version.work)
      : null;
    return {
      version,
      key: catalogueIdentityKey(version.identity),
      order,
      trusted: !!(ids.tmdb || ids.imdb),
      titleKey,
      year: version.work ? knownReleaseYear(version.work) : null,
      keys: [
        ...(ids.tmdb ? [`${version.contentType}:tmdb:${ids.tmdb}`] : []),
        ...(ids.imdb ? [`${version.contentType}:imdb:${ids.imdb}`] : []),
        ...(title ? [`title:${title}`] : []),
        ...(titleKey
          ? [`work-title:${version.contentType}:${titleKey}`]
          : []),
      ],
    };
  });
  const knownYearsByTitle = new Map<string, Set<number>>();
  for (const candidate of candidates) {
    if (!candidate.titleKey || candidate.year === null) continue;
    const key = `${candidate.version.contentType}:${candidate.titleKey}`;
    const years = knownYearsByTitle.get(key) ?? new Set<number>();
    years.add(candidate.year);
    knownYearsByTitle.set(key, years);
  }
  const groups: Group[] = [];
  const index = new Map<string, Set<Group>>();
  for (const candidate of [...candidates].sort(
    (a, b) =>
      Number(b.trusted) - Number(a.trusted) || a.key.localeCompare(b.key),
  )) {
    const possible = new Set<Group>();
    if (candidate.version.contentType !== "live")
      for (const key of candidate.keys)
        for (const group of index.get(key) ?? []) possible.add(group);
    const work = candidate.version.work;
    const titleKey = candidate.titleKey
      ? `${candidate.version.contentType}:${candidate.titleKey}`
      : null;
    const knownYears = titleKey
      ? knownYearsByTitle.get(titleKey)
      : undefined;
    const compatibleDescriptor = work
      ? (other: WorkDescriptor) => discoveryWorksMatch(work, other, knownYears)
      : () => false;
    const matches = work
      ? [...possible].filter(
          (group) =>
            group.type === candidate.version.contentType &&
            [...group.descriptors.values()].every(compatibleDescriptor),
        )
      : [];
    let group: Group;
    if (matches.length === 1) group = matches[0];
    else {
      group = {
        rows: [],
        descriptors: new Map(),
        type: candidate.version.contentType,
      };
      groups.push(group);
    }
    group.rows.push(candidate);
    if (work) group.descriptors.set(JSON.stringify(work), work);
    if (candidate.version.contentType !== "live")
      for (const key of candidate.keys) {
        const entries = index.get(key) ?? new Set<Group>();
        entries.add(group);
        index.set(key, entries);
      }
  }
  return groups
    .map((group) => ({
      key: group.rows.reduce(
        (key, row) => (row.key < key ? row.key : key),
        group.rows[0].key,
      ),
      rows: group.rows.sort((a, b) => a.order - b.order),
    }))
    .sort((a, b) => a.rows[0].order - b.rows[0].order)
    .map((group) => ({
      key: group.key,
      versions: group.rows.map((row) => row.version),
    }));
}

/** Only recorded successful playback qualifies; a seek position is never evidence of success. */
export function rankDiscoveryVersions(
  versions: readonly DiscoveryVersion[],
  ranking: DiscoveryRanking,
): DiscoveryVersion[] {
  const language = normalizeTrackLanguage(ranking.language);
  const compatible = (v: DiscoveryVersion) =>
    language !== null &&
    language !== undefined &&
    !!v.languages?.some((l) => normalizeTrackLanguage(l) === language);
  const sourceRank = (v: DiscoveryVersion) => {
    const index = ranking.sourceOrder?.indexOf(v.identity.playlistId) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const success = (v: DiscoveryVersion) =>
    ranking.successfulAt?.[catalogueIdentityKey(v.identity)] ?? 0;
  return [...versions].sort(
    (a, b) =>
      success(b) - success(a) ||
      Number(compatible(b)) - Number(compatible(a)) ||
      (b.resolution ?? 0) - (a.resolution ?? 0) ||
      sourceRank(a) - sourceRank(b) ||
      catalogueIdentityKey(a.identity).localeCompare(
        catalogueIdentityKey(b.identity),
      ),
  );
}
