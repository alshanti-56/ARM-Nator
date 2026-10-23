import { and, desc, eq, inArray, or, sql, type SQL, type GetColumnData } from 'drizzle-orm';
import * as schema from '@arm-nator/database/schema';
import {
    GLOBAL_SEARCH_CONTENT_TYPES,
    GLOBAL_SEARCH_RESULT_SOURCES,
    GlobalSearchContentType,
    GlobalSearchPaginationOptions,
    GlobalSearchResult,
    catalogSearchText,
    hasCompleteXtreamSearchMetadata,
    getXtreamRecentlyAddedMaxEpochSeconds,
    normalizeXtreamContentMetadata,
    toXtreamRecentlyAddedEpochSeconds,
    XtreamGlobalSearchResult,
} from '@arm-nator/shared/interfaces';
import type { AppDatabase } from '../database.types';
import {
    buildContentSearchFtsMatchQuery,
    buildGlobPrefixPatterns,
    buildLikePatterns,
    getSearchWordPlans,
    getSqlSearchTokenGroups,
    isShortSearchTokenGroup,
    normalizeSearchMatchText,
    scoreSearchTextMatch,
    createSearchTextScorer,
    shouldUseContentSearchFts,
    shouldUseContentTitlePrefixIndex,
} from './content-search.util';
import {
    checkpointOperation,
    chunkValues,
    type OperationControl,
    reportOperationProgress,
} from './operation-control';

export { scoreSearchTextMatch } from './content-search.util';
export { replaceXtreamCatalogue } from './catalogue-refresh.operations';

const DEFAULT_GLOBAL_SEARCH_LIMIT = 50;
const MAX_GLOBAL_SEARCH_LIMIT = 500;
const MAX_GLOBAL_SEARCH_CANDIDATE_LIMIT = 5000;
const DEFAULT_PLAYLIST_SEARCH_LIMIT = 50;
const MAX_PLAYLIST_SEARCH_LIMIT = 500;
const MAX_PLAYLIST_SEARCH_CANDIDATE_LIMIT = 5000;

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
    category_name: string | null;
    added: string | null;
    poster_url: string | null;
    direct_source: string | null;
    xtream_id: number;
    type: string;
    playlist_id: string;
    playlist_name: string;
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

function createXtreamMetadataScorer(searchTerm: string) {
    const scoreText = createSearchTextScorer(searchTerm);
    // Per-query only: repeated provider versions share title scoring work.
    const titles = new Map<string, number | null>();
    return (item: XtreamMetadataSearchCandidate): number | null => {
        const title = item.title ?? '';
        if (!titles.has(title)) titles.set(title, scoreText(title));
        const titleScore = titles.get(title) ?? null;
        if (titleScore !== null) return titleScore;
        const metadataScore = scoreText(catalogSearchText(item as unknown as Record<string, unknown>));
        return metadataScore === null ? null : metadataScore + 100;
    };
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
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type,
            cat.name AS category_name,
            cat.playlist_id AS playlist_id,
            p.name AS playlist_name
        FROM content AS c INDEXED BY idx_content_title
        INNER JOIN categories AS cat ON c.category_id = cat.id
        INNER JOIN playlists AS p ON cat.playlist_id = p.id
        WHERE c.available = 1 AND cat.available = 1 AND c.type IN (${sql.join(
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
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type,
            cat.name AS category_name,
            cat.playlist_id AS playlist_id,
            p.name AS playlist_name
        FROM content_search_fts
        INNER JOIN content AS c ON c.id = content_search_fts.rowid
        INNER JOIN categories AS cat ON c.category_id = cat.id
        INNER JOIN playlists AS p ON cat.playlist_id = p.id
        WHERE content_search_fts MATCH ${matchQuery}
        AND c.available = 1 AND cat.available = 1
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
    excludeHidden: boolean,
    candidateLimit: number
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
            c.direct_source AS direct_source,
            c.xtream_id AS xtream_id,
            c.type AS type
        FROM content_search_fts
        INNER JOIN content AS c ON c.id = content_search_fts.rowid
        INNER JOIN categories AS cat ON c.category_id = cat.id
        WHERE content_search_fts MATCH ${matchQuery}
        AND c.available = 1 AND cat.available = 1
        AND cat.playlist_id = ${playlistId}
        AND c.type IN (${sql.join(
            types.map((type) => sql`${type}`),
            sql`, `
        )})
        ${excludeHidden ? sql`AND cat.hidden = 0` : sql``}
        ORDER BY rank, c.title
        LIMIT ${candidateLimit}
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
        eq(schema.content.available, true),
        eq(schema.categories.available, true),
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
            category_name: schema.categories.name,
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
        direct_source: schema.content.directSource,
        xtream_id: schema.content.xtreamId,
        type: schema.content.type,
    };
}

type ContentFields = ReturnType<typeof selectContentFields>;
type CatalogueContentRow = { [K in keyof ContentFields]: GetColumnData<ContentFields[K]> };

export async function hasContent(
    db: AppDatabase,
    playlistId: string,
    type: 'live' | 'movie' | 'series'
): Promise<boolean> {
    // Start from this source's categories and stop at its first active item.
    // Counting all matches caused a full type-index scan across other sources.
    const row = db.get(sql`SELECT 1 AS found FROM categories AS cat
        CROSS JOIN content AS c INDEXED BY idx_content_category
        WHERE cat.playlist_id=${playlistId} AND cat.available=1
        AND c.category_id=cat.id AND c.type=${type} AND c.available=1 LIMIT 1`);
    return !!row;
}

export async function getContent(
    db: AppDatabase,
    playlistId: string,
    type: 'live' | 'movie' | 'series'
) {
    const fields = Object.entries(selectContentFields()).map(([name, column]) =>
        sql`${column} AS ${sql.identifier(name)}`);
    // Read this source through its category index, then sort its own rows.
    // The global (type, added) index otherwise scans every source to preserve order.
    return db.all<CatalogueContentRow>(sql`SELECT ${sql.join(fields, sql`, `)}
        FROM content INDEXED BY idx_content_category
        WHERE category_id IN(SELECT id FROM categories WHERE playlist_id=${playlistId} AND available=1)
        AND type=${type} AND available=1
        ORDER BY ${type === 'live' ? sql`id ASC` : sql`added DESC`}`);
}

export type RecentlyAddedPlaylistType = 'xtream';

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
        eq(schema.content.available, true),
        eq(schema.categories.available, true),
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
  metadataStatus?: 'complete';
    added: string;
    posterUrl: string;
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
    direct_source?: string;
    series_id?: string | number;
    stream_id?: string | number;
};

export function toXtreamContentValue(
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
        metadataStatus:
            type !== 'live' && hasCompleteXtreamSearchMetadata(source)
                ? 'complete'
                : undefined,
        added: toXtreamRecentlyAddedEpochSeconds(
            type === 'series'
                ? source.last_modified || source.added
                : source.added || source.last_modified
        ),
        posterUrl: metadata.posterUrl ?? '',
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
    excludeHidden = false,
    options?: GlobalSearchPaginationOptions
) {
    if (!types || types.length === 0 || !normalizeSearchMatchText(searchTerm)) {
        return [];
    }

    const conditions = [
        eq(schema.content.available, true),
        eq(schema.categories.available, true),
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

    const requestedLimit = Number.isFinite(options?.limit)
        ? Math.min(
              Math.max(Math.trunc(options?.limit ?? 0), 1),
              MAX_PLAYLIST_SEARCH_LIMIT
          )
        : DEFAULT_PLAYLIST_SEARCH_LIMIT;
    const offset = Number.isFinite(options?.offset)
        ? Math.max(Math.trunc(options?.offset ?? 0), 0)
        : 0;
    // Relevance is scored in JavaScript after the FTS/content query. For a
    // paginated request, collect the bounded candidate window before slicing;
    // otherwise page 2 can overlap page 1 when FTS rank differs from the
    // metadata relevance score.
    const candidateLimit = options
        ? MAX_PLAYLIST_SEARCH_CANDIDATE_LIMIT
        : DEFAULT_PLAYLIST_SEARCH_LIMIT;

    let candidates: XtreamMetadataSearchCandidate[];
    if (shouldUseContentSearchFts(searchTerm)) {
        try {
            candidates = await selectXtreamPlaylistSearchCandidatesWithFts(
                db,
                playlistId,
                buildContentSearchFtsMatchQuery(searchTerm),
                types,
                excludeHidden,
                candidateLimit
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
                .limit(candidateLimit);
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
            .limit(candidateLimit);
    }

    const scoreCandidate = createXtreamMetadataScorer(searchTerm);
    return candidates
        .map(item => ({ item, score: scoreCandidate(item) }))
        .filter((value): value is typeof value & { score: number } => value.score !== null)
        .sort((left, right) => left.score - right.score)
        .slice(offset, offset + requestedLimit)
        .map(value => value.item);
}

export async function globalSearch(
    db: AppDatabase,
    searchTerm: string,
    types: string[],
    excludeHidden = false,
    _sources?: readonly string[],
    options?: GlobalSearchPaginationOptions
): Promise<GlobalSearchResult[]> {
    if (!types || types.length === 0 || !normalizeSearchMatchText(searchTerm)) {
        return [];
    }

    const pagination = normalizeGlobalSearchPagination(options);
    const candidateLimit = getGlobalSearchCandidateLimit();
    const results: ScoredGlobalSearchResult[] = [];
    const scoreCandidate = createXtreamMetadataScorer(searchTerm);

    {
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
        } else if (shouldUseContentSearchFts(searchTerm)) {
            try {
                candidates = await selectXtreamGlobalSearchCandidatesWithFts(
                    db,
                    buildContentSearchFtsMatchQuery(searchTerm),
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
                        const score = scoreCandidate(item);
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

    return paginateScoredResults(results, pagination);
}
