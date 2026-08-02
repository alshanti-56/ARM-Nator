import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import * as schema from '@arm-nator/database/schema';
import {
    Channel,
    GLOBAL_SEARCH_CONTENT_TYPES,
    GLOBAL_SEARCH_RESULT_SOURCES,
    GlobalSearchContentType,
    GlobalSearchPaginationOptions,
    GlobalSearchResult,
    GlobalSearchResultSource,
    M3uGlobalSearchResult,
    catalogSearchText,
    getXtreamRecentlyAddedMaxEpochSeconds,
    normalizeXtreamContentMetadata,
    toXtreamRecentlyAddedEpochSeconds,
    XtreamGlobalSearchResult,
} from '@arm-nator/shared/interfaces';
import type { AppDatabase } from '../database.types';
import {
    buildContentTitleFtsMatchQuery,
    buildGlobPrefixPatterns,
    buildLikePatterns,
    buildM3uPayloadCompoundPatterns,
    buildM3uPayloadTextFieldPatterns,
    getSearchWordPlans,
    getSqlSearchTokenGroups,
    isShortSearchTokenGroup,
    normalizeSearchMatchText,
    scoreSearchTextMatch,
    shouldUseContentTitleFts,
    shouldUseContentTitlePrefixIndex,
} from './content-search.util';
import {
    checkpointOperation,
    chunkValues,
    type OperationControl,
    reportOperationProgress,
} from './operation-control';

export { scoreSearchTextMatch } from './content-search.util';

const DEFAULT_GLOBAL_SEARCH_LIMIT = 50;
const MAX_GLOBAL_SEARCH_LIMIT = 500;
const MAX_GLOBAL_SEARCH_CANDIDATE_LIMIT = 5000;
const M3U_PLAYLIST_TYPES = ['m3u-file', 'm3u-text', 'm3u-url'] as const;

interface NormalizedGlobalSearchPagination {
    limit: number;
    offset: number;
}

interface ScoredGlobalSearchResult<
    T extends GlobalSearchResult = GlobalSearchResult,
> {
    result: T;
    score: number;
}

interface M3uPlaylistSearchRow {
    id: string;
    name: string;
    payload: string | null;
}

interface XtreamMetadataSearchCandidate {
    title: string;
    rating: string | null;
    genre: string | null;
    releaseDate: string | null;
    country: string | null;
    director: string | null;
    cast: string | null;
    description: string | null;
}

interface XtreamGlobalSearchCandidate extends XtreamMetadataSearchCandidate {
    id: number;
    category_id: number;
    added: string | null;
    poster_url: string | null;
    tv_archive: number | null;
    tv_archive_duration: number | null;
    direct_source: string | null;
    xtream_id: number;
    type: string;
    playlist_id: string;
    playlist_name: string;
}

interface ParsedM3uPlaylistItems {
    items?: unknown;
}

interface ParsedM3uPlaylistPayload {
    hiddenGroupTitles?: unknown;
    playlist?: ParsedM3uPlaylistItems;
    items?: unknown;
}

function normalizeSearchText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeGlobalSearchPagination(
    options?: GlobalSearchPaginationOptions | number
): NormalizedGlobalSearchPagination {
    const limitValue = typeof options === 'number' ? options : options?.limit;
    const offsetValue = typeof options === 'number' ? 0 : options?.offset;
    const limit = Number.isFinite(limitValue)
        ? Math.min(
              Math.max(Math.trunc(Number(limitValue)), 1),
              MAX_GLOBAL_SEARCH_LIMIT
          )
        : DEFAULT_GLOBAL_SEARCH_LIMIT;
    const offset = Number.isFinite(offsetValue)
        ? Math.max(Math.trunc(Number(offsetValue)), 0)
        : 0;

    return { limit, offset };
}

function compareScoredGlobalSearchResults(
    first: ScoredGlobalSearchResult,
    second: ScoredGlobalSearchResult
): number {
    const scoreCompare = first.score - second.score;
    if (scoreCompare !== 0) {
        return scoreCompare;
    }

    const playlistCompare = first.result.playlist_name.localeCompare(
        second.result.playlist_name
    );
    if (playlistCompare !== 0) {
        return playlistCompare;
    }

    const playlistIdCompare = first.result.playlist_id.localeCompare(
        second.result.playlist_id
    );
    if (playlistIdCompare !== 0) {
        return playlistIdCompare;
    }

    const titleCompare = first.result.title.localeCompare(second.result.title);
    if (titleCompare !== 0) {
        return titleCompare;
    }

    return String(first.result.id).localeCompare(String(second.result.id));
}

function paginateScoredResults<T extends GlobalSearchResult>(
    results: ScoredGlobalSearchResult<T>[],
    pagination: NormalizedGlobalSearchPagination
): T[] {
    return results
        .sort(compareScoredGlobalSearchResults)
        .slice(pagination.offset, pagination.offset + pagination.limit)
        .map((item) => item.result);
}

function getGlobalSearchCandidateLimit(): number {
    return MAX_GLOBAL_SEARCH_CANDIDATE_LIMIT;
}

function buildContentMetadataSearchConditions(searchTerm: string) {
    const columns = [
        schema.content.title,
        schema.content.genre,
        schema.content.releaseDate,
        schema.content.country,
        schema.content.director,
        schema.content.cast,
        schema.content.description,
    ];

    return getSqlSearchTokenGroups(searchTerm)
        .map((tokens, index) => {
            const mode =
                index === 0 && isShortSearchTokenGroup(tokens)
                    ? 'prefix'
                    : 'contains';
            const conditions = tokens.flatMap((token) =>
                buildLikePatterns(token, mode).flatMap((pattern) =>
                    columns.map(
                        (column) => sql`${column} LIKE ${pattern} ESCAPE '\\'`
                    )
                )
            );
            return conditions.length > 0 ? or(...conditions) : undefined;
        })
        .filter((condition) => condition !== undefined);
}

function scoreXtreamMetadataMatch(
    item: XtreamMetadataSearchCandidate,
    searchTerm: string
): number | null {
    const titleScore = scoreSearchTextMatch(item.title ?? '', searchTerm);
    if (titleScore !== null) {
        return titleScore;
    }

    const metadataScore = scoreSearchTextMatch(
        catalogSearchText(item as unknown as Record<string, unknown>),
        searchTerm
    );
    return metadataScore === null ? null : metadataScore + 100;
}

function buildRawContentTitleSearchSql(searchTerm: string): SQL[] {
    return getSqlSearchTokenGroups(searchTerm).map((tokens, index) => {
        if (index === 0 && isShortSearchTokenGroup(tokens)) {
            return sql`(${sql.join(
                tokens.flatMap((token) =>
                    buildGlobPrefixPatterns(token).map(
                        (pattern) => sql`c.title GLOB ${pattern}`
                    )
                ),
                sql` OR `
            )})`;
        }

        return sql`(${sql.join(
            tokens.flatMap((token) =>
                buildLikePatterns(token).map(
                    (pattern) => sql`c.title LIKE ${pattern} ESCAPE '\\'`
                )
            ),
            sql` OR `
        )})`;
    });
}

function dedupeXtreamCandidatesById(
    candidates: XtreamGlobalSearchCandidate[]
): XtreamGlobalSearchCandidate[] {
    const seenIds = new Set<number>();

    return candidates.filter((candidate) => {
        if (seenIds.has(candidate.id)) {
            return false;
        }
        seenIds.add(candidate.id);
        return true;
    });
}

async function selectXtreamGlobalSearchCandidatesWithTitleIndex(
    db: AppDatabase,
    searchTerm: string,
    types: string[],
    excludeHidden: boolean,
    candidateLimit: number
): Promise<XtreamGlobalSearchCandidate[]> {
    const titleConditions = buildRawContentTitleSearchSql(searchTerm);
    if (titleConditions.length === 0 || types.length === 0) {
        return [];
    }

    return (await db.all(sql`
        SELECT
            c.id AS id,
            c.category_id AS category_id,
            c.title AS title,
            c.rating AS rating,
            c.genre AS genre,
            c.release_date AS releaseDate,
            c.country AS country,
            c.director AS director,
            c.cast AS cast,
            c.description AS description,
            c.added AS added,
            c.poster_url AS poster_url,
            c.tv_archive AS tv_archive,
            c.tv_archive_duration AS tv_archive_duration,
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type,
            cat.playlist_id AS playlist_id,
            p.name AS playlist_name
        FROM content AS c INDEXED BY idx_content_title
        INNER JOIN categories AS cat ON c.category_id = cat.id
        INNER JOIN playlists AS p ON cat.playlist_id = p.id
        WHERE c.type IN (${sql.join(
            types.map((type) => sql`${type}`),
            sql`, `
        )})
        AND ${sql.join(titleConditions, sql` AND `)}
        ${excludeHidden ? sql`AND cat.hidden = 0` : sql``}
        ORDER BY c.title
        LIMIT ${candidateLimit}
    `)) as XtreamGlobalSearchCandidate[];
}

async function selectXtreamGlobalSearchCandidatesWithFts(
    db: AppDatabase,
    matchQuery: string,
    types: string[],
    excludeHidden: boolean,
    candidateLimit: number,
    residualTitleConditions: SQL[] = []
): Promise<XtreamGlobalSearchCandidate[]> {
    if (!matchQuery || types.length === 0) {
        return [];
    }

    return (await db.all(sql`
        SELECT
            c.id AS id,
            c.category_id AS category_id,
            c.title AS title,
            c.rating AS rating,
            c.genre AS genre,
            c.release_date AS releaseDate,
            c.country AS country,
            c.director AS director,
            c.cast AS cast,
            c.description AS description,
            c.added AS added,
            c.poster_url AS poster_url,
            c.tv_archive AS tv_archive,
            c.tv_archive_duration AS tv_archive_duration,
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type,
            cat.playlist_id AS playlist_id,
            p.name AS playlist_name
        FROM content_metadata_fts
        INNER JOIN content AS c ON c.id = content_metadata_fts.rowid
        INNER JOIN categories AS cat ON c.category_id = cat.id
        INNER JOIN playlists AS p ON cat.playlist_id = p.id
        WHERE content_metadata_fts MATCH ${matchQuery}
        AND c.type IN (${sql.join(
            types.map((type) => sql`${type}`),
            sql`, `
        )})
        ${
            residualTitleConditions.length > 0
                ? sql`AND ${sql.join(residualTitleConditions, sql` AND `)}`
                : sql``
        }
        ${excludeHidden ? sql`AND cat.hidden = 0` : sql``}
        ORDER BY rank, c.title
        LIMIT ${candidateLimit}
    `)) as XtreamGlobalSearchCandidate[];
}

async function selectXtreamPlaylistSearchCandidatesWithFts(
    db: AppDatabase,
    playlistId: string,
    matchQuery: string,
    types: string[],
    excludeHidden: boolean
): Promise<XtreamMetadataSearchCandidate[]> {
    if (!matchQuery || types.length === 0) {
        return [];
    }

    return (await db.all(sql`
        SELECT
            c.id AS id,
            c.category_id AS category_id,
            c.title AS title,
            c.rating AS rating,
            c.genre AS genre,
            c.release_date AS releaseDate,
            c.country AS country,
            c.director AS director,
            c.cast AS cast,
            c.description AS description,
            c.added AS added,
            c.poster_url AS poster_url,
            c.backdrop_url AS backdrop_url,
            c.tv_archive AS tv_archive,
            c.tv_archive_duration AS tv_archive_duration,
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type
        FROM content_metadata_fts
        INNER JOIN content AS c ON c.id = content_metadata_fts.rowid
        INNER JOIN categories AS cat ON c.category_id = cat.id
        WHERE content_metadata_fts MATCH ${matchQuery}
        AND cat.playlist_id = ${playlistId}
        AND c.type IN (${sql.join(
            types.map((type) => sql`${type}`),
            sql`, `
        )})
        ${excludeHidden ? sql`AND cat.hidden = 0` : sql``}
        ORDER BY rank, c.title
        LIMIT 200
    `)) as XtreamMetadataSearchCandidate[];
}

async function selectXtreamGlobalSearchCandidatesWithContentScan(
    db: AppDatabase,
    searchTerm: string,
    types: string[],
    excludeHidden: boolean,
    candidateLimit: number
): Promise<XtreamGlobalSearchCandidate[]> {
    const conditions = [
        inArray(
            schema.content.type,
            types as Array<'live' | 'movie' | 'series'>
        ),
        ...buildContentMetadataSearchConditions(searchTerm),
    ];

    if (excludeHidden) {
        conditions.push(eq(schema.categories.hidden, false));
    }

    return db
        .select({
            ...selectContentFields(),
            playlist_id: schema.categories.playlistId,
            playlist_name: schema.playlists.name,
        })
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .innerJoin(
            schema.playlists,
            eq(schema.categories.playlistId, schema.playlists.id)
        )
        .where(and(...conditions))
        .orderBy(schema.content.title)
        .limit(candidateLimit);
}

/**
 * Per-word M3U payload prefilter conditions, AND-ed by the caller — the same
 * compound-word composition as `buildContentTitleSearchConditions`: "A&E"
 * must reach channel names like "US: A&E" (issue #1161), while the other
 * words of the query keep constraining the candidate playlists.
 */
function buildM3uPayloadSearchConditions(searchTerm: string) {
    let groupIndex = 0;

    return getSearchWordPlans(searchTerm)
        .map((plan) => {
            const tokenConditions = plan.tokenGroups
                .map((tokens) => {
                    const mode =
                        groupIndex === 0 && isShortSearchTokenGroup(tokens)
                            ? 'prefix'
                            : 'contains';
                    groupIndex += 1;
                    const patterns = tokens.flatMap((token) =>
                        buildM3uPayloadTextFieldPatterns(token, mode)
                    );
                    const likeConditions = patterns.map(
                        (pattern) =>
                            sql`${schema.playlists.payload} LIKE ${pattern} ESCAPE '\\'`
                    );
                    return or(...likeConditions);
                })
                .filter((condition) => condition !== undefined);

            const tokenArm =
                tokenConditions.length > 0
                    ? and(...tokenConditions)
                    : undefined;
            if (plan.compound === null) {
                return tokenArm;
            }

            const compoundConditions = buildM3uPayloadCompoundPatterns(
                plan.compound
            ).map(
                (pattern) =>
                    sql`${schema.playlists.payload} LIKE ${pattern} ESCAPE '\\'`
            );
            return tokenArm === undefined
                ? or(...compoundConditions)
                : or(tokenArm, ...compoundConditions);
        })
        .filter((condition) => condition !== undefined);
}

function asStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => normalizeSearchText(item))
        .filter((item) => item.length > 0);
}

function hasGlobalSearchSource(
    sources: readonly GlobalSearchResultSource[] | undefined,
    source: GlobalSearchResultSource
): boolean {
    return !sources || sources.length === 0 || sources.includes(source);
}

function parseM3uPlaylistPayload(
    payload: string | null
): ParsedM3uPlaylistPayload | null {
    if (!payload) {
        return null;
    }

    try {
        const parsed = JSON.parse(payload) as unknown;
        return parsed && typeof parsed === 'object'
            ? (parsed as ParsedM3uPlaylistPayload)
            : null;
    } catch {
        return null;
    }
}

function normalizeM3uChannel(value: unknown): Channel | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const source = value as Partial<Channel>;
    const url = normalizeSearchText(source.url);
    const name = normalizeSearchText(source.name);
    if (!url || !name) {
        return null;
    }

    return {
        id: normalizeSearchText(source.id) || url,
        url,
        name,
        group: {
            title: normalizeSearchText(source.group?.title),
        },
        tvg: {
            id: normalizeSearchText(source.tvg?.id),
            name: normalizeSearchText(source.tvg?.name),
            url: normalizeSearchText(source.tvg?.url),
            logo: normalizeSearchText(source.tvg?.logo),
            rec: normalizeSearchText(source.tvg?.rec),
        },
        timeshift: source.timeshift,
        catchup: source.catchup,
        http: {
            referrer: normalizeSearchText(source.http?.referrer),
            'user-agent': normalizeSearchText(source.http?.['user-agent']),
            origin: normalizeSearchText(source.http?.origin),
        },
        radio: normalizeSearchText(source.radio),
    };
}

function getM3uPayloadChannels(payload: ParsedM3uPlaylistPayload): Channel[] {
    const items = Array.isArray(payload.playlist?.items)
        ? payload.playlist?.items
        : Array.isArray(payload.items)
          ? payload.items
          : [];

    return items
        .map((item) => normalizeM3uChannel(item))
        .filter((item): item is Channel => item !== null);
}

function scoreM3uChannel(channel: Channel, searchTerm: string): number | null {
    const scores = [
        scoreSearchTextMatch(channel.name, searchTerm),
        scoreSearchTextMatch(channel.tvg.name, searchTerm),
        scoreSearchTextMatch(channel.group.title, searchTerm),
    ].filter((score): score is number => score !== null);

    return scores.length > 0 ? Math.min(...scores) : null;
}

function toM3uGlobalSearchResult(
    row: M3uPlaylistSearchRow,
    channel: Channel
): M3uGlobalSearchResult {
    return {
        source_type: GLOBAL_SEARCH_RESULT_SOURCES.M3u,
        content_type: GLOBAL_SEARCH_CONTENT_TYPES.Live,
        playlist_id: row.id,
        playlist_name: row.name,
        channel_id: channel.id,
        stream_url: channel.url,
        group_title: channel.group.title,
        radio: channel.radio,
        poster_url: channel.tvg.logo || null,
        channel,
        id: `${row.id}::${channel.id || channel.url}`,
        category_id: 'm3u',
        title: channel.name || channel.tvg.name || channel.url,
        rating: null,
        added: null,
        xtream_id: -1,
        type: GLOBAL_SEARCH_CONTENT_TYPES.Live,
    };
}

function buildScoredM3uGlobalSearchResults(
    rows: readonly M3uPlaylistSearchRow[],
    searchTerm: string,
    excludeHidden = false,
    maxResults = MAX_GLOBAL_SEARCH_CANDIDATE_LIMIT
): ScoredGlobalSearchResult<M3uGlobalSearchResult>[] {
    const results: ScoredGlobalSearchResult<M3uGlobalSearchResult>[] = [];

    for (const row of rows) {
        const payload = parseM3uPlaylistPayload(row.payload);
        if (!payload) {
            continue;
        }

        const hiddenGroups = new Set(asStringArray(payload.hiddenGroupTitles));
        for (const channel of getM3uPayloadChannels(payload)) {
            if (excludeHidden && hiddenGroups.has(channel.group.title)) {
                continue;
            }

            const score = scoreM3uChannel(channel, searchTerm);
            if (score === null) {
                continue;
            }

            results.push({
                result: toM3uGlobalSearchResult(row, channel),
                score,
            });

            if (results.length >= maxResults) {
                return results;
            }
        }
    }

    return results;
}

export function buildM3uGlobalSearchResults(
    rows: readonly M3uPlaylistSearchRow[],
    searchTerm: string,
    excludeHidden = false,
    options?: GlobalSearchPaginationOptions | number
): M3uGlobalSearchResult[] {
    return paginateScoredResults(
        buildScoredM3uGlobalSearchResults(rows, searchTerm, excludeHidden),
        normalizeGlobalSearchPagination(options)
    );
}

export type GlobalRecentlyAddedKind = 'all' | 'vod' | 'series';

function getRecentlyAddedContentTypes(
    kind: GlobalRecentlyAddedKind
): Array<'movie' | 'series'> {
    if (kind === 'vod') {
        return ['movie'];
    }

    if (kind === 'series') {
        return ['series'];
    }

    return ['movie', 'series'];
}

function selectContentFields() {
    return {
        id: schema.content.id,
        category_id: schema.content.categoryId,
        title: schema.content.title,
        rating: schema.content.rating,
        genre: schema.content.genre,
        releaseDate: schema.content.releaseDate,
        country: schema.content.country,
        director: schema.content.director,
        cast: schema.content.cast,
        description: schema.content.description,
        metadata_status: schema.content.metadataStatus,
        metadata_attempted_at: schema.content.metadataAttemptedAt,
        metadata_retry_after: schema.content.metadataRetryAfter,
        added: schema.content.added,
        poster_url: schema.content.posterUrl,
        tv_archive: schema.content.tvArchive,
        tv_archive_duration: schema.content.tvArchiveDuration,
        direct_source: schema.content.directSource,
        xtream_id: schema.content.xtreamId,
        type: schema.content.type,
    };
}

export async function hasContent(
    db: AppDatabase,
    playlistId: string,
    type: 'live' | 'movie' | 'series'
): Promise<boolean> {
    const result = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .where(
            and(
                eq(schema.categories.playlistId, playlistId),
                eq(schema.content.type, type)
            )
        );

    return result[0].count > 0;
}

export async function getContent(
    db: AppDatabase,
    playlistId: string,
    type: 'live' | 'movie' | 'series'
) {
    const baseQuery = db
        .select(selectContentFields())
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .where(
            and(
                eq(schema.categories.playlistId, playlistId),
                eq(schema.content.type, type)
            )
        );

    return type === 'live'
        ? baseQuery.orderBy(asc(schema.content.id))
        : baseQuery.orderBy(desc(schema.content.added));
}

export type RecentlyAddedPlaylistType =
    | 'xtream'
    | 'm3u-file'
    | 'm3u-text'
    | 'm3u-url';

export async function getGlobalRecentlyAdded(
    db: AppDatabase,
    kind: GlobalRecentlyAddedKind = 'all',
    limit = 200,
    playlistType?: RecentlyAddedPlaylistType
) {
    const normalizedLimit = Number.isFinite(limit)
        ? Math.min(Math.max(Math.trunc(limit), 1), 200)
        : 200;

    const contentTypes = getRecentlyAddedContentTypes(kind);

    if (contentTypes.length > 1) {
        const rows = await Promise.all(
            contentTypes.map((type) =>
                getGlobalRecentlyAddedByType(
                    db,
                    type,
                    normalizedLimit,
                    playlistType
                )
            )
        );

        return rows
            .flat()
            .sort(
                (left, right) =>
                    getRecentlyAddedSortValue(right) -
                    getRecentlyAddedSortValue(left)
            )
            .slice(0, normalizedLimit);
    }

    return getGlobalRecentlyAddedByType(
        db,
        contentTypes[0],
        normalizedLimit,
        playlistType
    );
}

function getRecentlyAddedSortValue(item: {
    added?: string | null;
    added_at?: string | null;
}): number {
    const value = Number(item.added_at || item.added || 0);

    return Number.isFinite(value) ? value : 0;
}

function getGlobalRecentlyAddedByType(
    db: AppDatabase,
    type: 'movie' | 'series',
    limit: number,
    playlistType?: RecentlyAddedPlaylistType
) {
    const whereConditions = [
        eq(schema.content.type, type),
        eq(schema.categories.hidden, false),
        sql`${schema.content.added} <> ''`,
        sql`${schema.content.added} <= ${getXtreamRecentlyAddedMaxEpochSeconds()}`,
    ];

    if (playlistType) {
        whereConditions.push(eq(schema.playlists.type, playlistType));
    }

    // Sort by `added` directly. Xtream import and DB startup migrations
    // normalize recently-added epochs to 10-digit seconds strings, so
    // lexicographic sort is equivalent to numeric sort. Wrapping the column in
    // CAST(... AS INTEGER) blocks SQLite from using idx_content_type_added and
    // forces a full table scan + sort on the entire content table (often 100k+
    // rows) on every dashboard load.
    return db
        .select({
            ...selectContentFields(),
            added_at: schema.content.added,
            playlist_id: schema.playlists.id,
            playlist_name: schema.playlists.name,
        })
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .innerJoin(
            schema.playlists,
            eq(schema.categories.playlistId, schema.playlists.id)
        )
        .where(and(...whereConditions))
        .orderBy(desc(schema.content.added))
        .limit(limit);
}

type XtreamContentValue = {
    categoryId: number;
    title: string;
    rating: string;
    genre?: string;
    releaseDate?: string;
    country?: string;
    director?: string;
    cast?: string;
    description?: string;
    added: string;
    posterUrl: string;
    tvArchive?: number | null;
    tvArchiveDuration?: number | null;
    directSource?: string | null;
    xtreamId: number;
    type: 'live' | 'movie' | 'series';
};

type XtreamContentSource = Record<string, unknown> & {
    category_id?: string | number;
    rating?: string | number;
    rating_imdb?: string;
    genre?: string;
    releaseDate?: string;
    releasedate?: string;
    country?: string;
    director?: string;
    actors?: string;
    cast?: string;
    plot?: string;
    description?: string;
    last_modified?: string;
    added?: string;
    stream_icon?: string;
    poster?: string;
    cover?: string;
    name?: string;
    title?: string;
    tv_archive?: string | number;
    tv_archive_duration?: string | number;
    direct_source?: string;
    series_id?: string | number;
    stream_id?: string | number;
};

function toXtreamContentValue(
    stream: Record<string, unknown>,
    type: 'live' | 'movie' | 'series',
    categoryMap: Map<number, number>
): XtreamContentValue | null {
    const source = stream as XtreamContentSource;
    const streamCategoryId =
        type === 'series'
            ? parseInt(String(source.category_id || '0'))
            : parseInt(String(source.category_id));

    const categoryId = categoryMap.get(streamCategoryId);
    if (!categoryId) {
        return null;
    }

    const title =
        type === 'series'
            ? source.title ||
              source.name ||
              `Unknown Series ${source.series_id ?? ''}`.trim()
            : source.name ||
              source.title ||
              `Unknown Stream ${source.stream_id ?? ''}`.trim();
    const metadata = normalizeXtreamContentMetadata(source);

    return {
        categoryId,
        title,
        rating: metadata.rating ?? '',
        genre: metadata.genre,
        releaseDate: metadata.releaseDate,
        country: metadata.country,
        director: metadata.director,
        cast: metadata.cast,
        description: metadata.description,
        added: toXtreamRecentlyAddedEpochSeconds(
            type === 'series'
                ? source.last_modified || source.added
                : source.added || source.last_modified
        ),
        posterUrl: metadata.posterUrl ?? '',
        tvArchive:
            type === 'live'
                ? Number.parseInt(String(source.tv_archive ?? '0'), 10) || 0
                : null,
        tvArchiveDuration:
            type === 'live'
                ? Number.parseInt(
                      String(source.tv_archive_duration ?? '0'),
                      10
                  ) || 0
                : null,
        directSource:
            type === 'live'
                ? String(source.direct_source ?? '').trim() || null
                : null,
        xtreamId:
            type === 'series'
                ? parseInt(String(source.series_id || '0'))
                : parseInt(String(source.stream_id || '0')),
        type,
    };
}

export async function saveContent(
    db: AppDatabase,
    playlistId: string,
    streams: Array<Record<string, unknown>>,
    type: 'live' | 'movie' | 'series',
    control?: OperationControl
): Promise<{ success: boolean; count: number }> {
    const dbType =
        type === 'series' ? 'series' : type === 'movie' ? 'movies' : 'live';

    const existingContent = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .where(
            and(
                eq(schema.categories.playlistId, playlistId),
                eq(schema.categories.type, dbType),
                eq(schema.content.type, type)
            )
        );

    if ((existingContent[0]?.count ?? 0) > 0) {
        return { success: true, count: existingContent[0].count };
    }

    const categories = await db
        .select({
            id: schema.categories.id,
            xtreamId: schema.categories.xtreamId,
        })
        .from(schema.categories)
        .where(
            and(
                eq(schema.categories.playlistId, playlistId),
                eq(schema.categories.type, dbType)
            )
        );

    const categoryMap = new Map(
        categories.map((category) => [category.xtreamId, category.id])
    );

    const values = streams
        .map((stream) => toXtreamContentValue(stream, type, categoryMap))
        .filter((value): value is XtreamContentValue => value !== null);

    const total = values.length;
    const chunkSize = 100;
    let totalInserted = 0;

    for (let index = 0; index < values.length; index += chunkSize) {
        await checkpointOperation(control);
        const chunk = values.slice(index, index + chunkSize);
        await db.transaction((tx) => {
            tx.insert(schema.content)
                .values(chunk)
                .onConflictDoNothing({
                    target: [
                        schema.content.categoryId,
                        schema.content.type,
                        schema.content.xtreamId,
                    ],
                })
                .run();
        });
        totalInserted += chunk.length;
        await reportOperationProgress(control, {
            phase: 'saving-content',
            current: totalInserted,
            total,
            increment: chunk.length,
        });
    }

    return { success: true, count: totalInserted };
}

export async function clearXtreamImportCache(
    db: AppDatabase,
    playlistId: string,
    type: 'live' | 'movie' | 'series'
): Promise<{ success: boolean }> {
    const dbType =
        type === 'series' ? 'series' : type === 'movie' ? 'movies' : 'live';

    const categoryRows = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(
            and(
                eq(schema.categories.playlistId, playlistId),
                eq(schema.categories.type, dbType)
            )
        );

    const categoryIds = categoryRows.map((category) => category.id);
    if (categoryIds.length === 0) {
        return { success: true };
    }

    const contentRows = await db
        .select({ id: schema.content.id })
        .from(schema.content)
        .where(inArray(schema.content.categoryId, categoryIds));

    for (const chunk of chunkValues(
        contentRows.map((row) => row.id),
        100
    )) {
        await db.transaction((tx) => {
            tx.delete(schema.content)
                .where(inArray(schema.content.id, chunk))
                .run();
        });
    }

    for (const chunk of chunkValues(categoryIds, 100)) {
        await db.transaction((tx) => {
            tx.delete(schema.categories)
                .where(inArray(schema.categories.id, chunk))
                .run();
        });
    }

    return { success: true };
}

export async function getContentByXtreamId(
    db: AppDatabase,
    xtreamId: number,
    playlistId: string,
    contentType?: 'live' | 'movie' | 'series'
) {
    const conditions = [
        eq(schema.content.xtreamId, xtreamId),
        eq(schema.categories.playlistId, playlistId),
    ];

    if (contentType) {
        conditions.push(eq(schema.content.type, contentType));
    }

    const result = await db
        .select(selectContentFields())
        .from(schema.content)
        .innerJoin(
            schema.categories,
            eq(schema.content.categoryId, schema.categories.id)
        )
        .where(and(...conditions))
        .limit(1);

    return result[0] || null;
}

export async function searchContent(
    db: AppDatabase,
    playlistId: string,
    searchTerm: string,
    types: string[],
    excludeHidden = false
) {
    if (!types || types.length === 0 || !normalizeSearchMatchText(searchTerm)) {
        return [];
    }

    const conditions = [
        eq(schema.categories.playlistId, playlistId),
        inArray(
            schema.content.type,
            types as Array<'live' | 'movie' | 'series'>
        ),
        ...buildContentMetadataSearchConditions(searchTerm),
    ];

    if (excludeHidden) {
        conditions.push(eq(schema.categories.hidden, false));
    }

    let candidates: XtreamMetadataSearchCandidate[];
    if (shouldUseContentTitleFts(searchTerm)) {
        try {
            candidates = await selectXtreamPlaylistSearchCandidatesWithFts(
                db,
                playlistId,
                buildContentTitleFtsMatchQuery(searchTerm),
                types,
                excludeHidden
            );
        } catch {
            candidates = await db
                .select(selectContentFields())
                .from(schema.content)
                .innerJoin(
                    schema.categories,
                    eq(schema.content.categoryId, schema.categories.id)
                )
                .where(and(...conditions))
                .limit(200);
        }
    } else {
        candidates = await db
            .select(selectContentFields())
            .from(schema.content)
            .innerJoin(
                schema.categories,
                eq(schema.content.categoryId, schema.categories.id)
            )
            .where(and(...conditions))
            .limit(200);
    }

    return candidates
        .filter(
            (item) =>
                scoreXtreamMetadataMatch(item, searchTerm) !== null
        )
        .sort(
            (left, right) =>
                (scoreXtreamMetadataMatch(left, searchTerm) ?? Infinity) -
                (scoreXtreamMetadataMatch(right, searchTerm) ?? Infinity)
        )
        .slice(0, 50);
}

export async function globalSearch(
    db: AppDatabase,
    searchTerm: string,
    types: string[],
    excludeHidden = false,
    sources?: GlobalSearchResultSource[],
    options?: GlobalSearchPaginationOptions
): Promise<GlobalSearchResult[]> {
    if (!types || types.length === 0 || !normalizeSearchMatchText(searchTerm)) {
        return [];
    }

    const pagination = normalizeGlobalSearchPagination(options);
    const candidateLimit = getGlobalSearchCandidateLimit();
    const results: ScoredGlobalSearchResult[] = [];

    if (hasGlobalSearchSource(sources, GLOBAL_SEARCH_RESULT_SOURCES.Xtream)) {
        let candidates: XtreamGlobalSearchCandidate[];

        if (shouldUseContentTitlePrefixIndex(searchTerm)) {
            const [titleCandidates, metadataCandidates] = await Promise.all([
                selectXtreamGlobalSearchCandidatesWithTitleIndex(
                    db,
                    searchTerm,
                    types,
                    excludeHidden,
                    candidateLimit
                ),
                selectXtreamGlobalSearchCandidatesWithContentScan(
                    db,
                    searchTerm,
                    types,
                    excludeHidden,
                    candidateLimit
                ),
            ]);
            candidates = dedupeXtreamCandidatesById([
                ...titleCandidates,
                ...metadataCandidates,
            ]).slice(0, candidateLimit);
        } else if (shouldUseContentTitleFts(searchTerm)) {
            try {
                candidates = await selectXtreamGlobalSearchCandidatesWithFts(
                    db,
                    buildContentTitleFtsMatchQuery(searchTerm),
                    types,
                    excludeHidden,
                    candidateLimit
                );
            } catch {
                candidates =
                    await selectXtreamGlobalSearchCandidatesWithContentScan(
                        db,
                        searchTerm,
                        types,
                        excludeHidden,
                        candidateLimit
                    );
            }
        } else {
            candidates =
                await selectXtreamGlobalSearchCandidatesWithContentScan(
                    db,
                    searchTerm,
                    types,
                    excludeHidden,
                    candidateLimit
                );
        }

        results.push(
            ...candidates
                .map(
                    (
                        item
                    ): ScoredGlobalSearchResult<XtreamGlobalSearchResult> | null => {
                        const score = scoreXtreamMetadataMatch(
                            item,
                            searchTerm
                        );
                        if (score === null) {
                            return null;
                        }

                        return {
                            score,
                            result: {
                                ...item,
                                source_type:
                                    GLOBAL_SEARCH_RESULT_SOURCES.Xtream,
                                content_type:
                                    item.type as GlobalSearchContentType,
                                type: item.type as GlobalSearchContentType,
                            },
                        };
                    }
                )
                .filter(
                    (
                        item
                    ): item is ScoredGlobalSearchResult<XtreamGlobalSearchResult> =>
                        item !== null
                )
        );
    }

    if (
        types.includes(GLOBAL_SEARCH_CONTENT_TYPES.Live) &&
        hasGlobalSearchSource(sources, GLOBAL_SEARCH_RESULT_SOURCES.M3u)
    ) {
        const rows = await db
            .select({
                id: schema.playlists.id,
                name: schema.playlists.name,
                payload: schema.playlists.payload,
            })
            .from(schema.playlists)
            .where(
                and(
                    inArray(schema.playlists.type, [...M3U_PLAYLIST_TYPES]),
                    sql`${schema.playlists.payload} IS NOT NULL`,
                    ...buildM3uPayloadSearchConditions(searchTerm)
                )
            )
            .orderBy(schema.playlists.name)
            .limit(candidateLimit);

        results.push(
            ...buildScoredM3uGlobalSearchResults(
                rows,
                searchTerm,
                excludeHidden,
                candidateLimit
            )
        );
    }

    return paginateScoredResults(results, pagination);
}
