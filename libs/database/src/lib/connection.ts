/* eslint-disable max-lines */
/**
 * Database connection and initialization for ARM-Nator
 * Uses Drizzle ORM with better-sqlite3
 * Stores database file under ~/.arm-nator/databases/ by default.
 * E2E tests can override the root with ARM_NATOR_E2E_DATA_DIR.
 *
 * Provides two connection modes:
 * - Full access (for electron-backend): creates tables, read-write
 * - Read-only access (for agent-backend): no table creation, read-only queries
 */

import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { getArmNatorDatabasePath } from './path-utils';

export type DatabaseInstance = BetterSQLite3Database<typeof schema>;

const TRACE_ENV_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

let db: DatabaseInstance | null = null;
let sqlite: Database.Database | null = null;
let initPromise: Promise<DatabaseInstance> | null = null;

const XTREAM_ADDED_EPOCH_MILLISECONDS_THRESHOLD = 10_000_000_000;
const XTREAM_ADDED_EPOCH_SECONDS_MIGRATION_KEY =
    'migration:xtream-content-added-epoch-seconds:v1';
const CONTENT_TITLE_FTS_MIGRATION_KEY =
    'migration:content-title-fts-trigram:v1';
const CONTENT_SEARCH_FTS_MIGRATION_KEY =
    'migration:content-search-fts-trigram:v1';
const CONTENT_METADATA_FTS_RETIREMENT_MIGRATION_KEY =
    'migration:content-metadata-fts-retired:v1';
const TMDB_SEARCH_LOOKUP_V2_CACHE_CLEANUP_MIGRATION_KEY =
    'migration:tmdb-search-lookup-v2-cache-cleanup:v1';

function readTraceFlag(name: string): boolean {
    const value = process.env[name]?.trim().toLowerCase();
    return value ? TRACE_ENV_TRUE_VALUES.has(value) : false;
}

function isSqlTraceEnabled(): boolean {
    return (
        readTraceFlag('ARM_NATOR_TRACE_STARTUP') ||
        readTraceFlag('ARM_NATOR_TRACE_DB') ||
        readTraceFlag('ARM_NATOR_TRACE_SQL')
    );
}

function compactSqlForTrace(sql: string): string {
    const compactSql = sql.replace(/\s+/g, ' ').trim();
    return compactSql.length <= 180
        ? compactSql
        : `${compactSql.slice(0, 177)}...`;
}

function traceSql(scope: string, message: string, payload?: unknown): void {
    if (payload === undefined) {
        console.log(`[ARM-Nator Trace][${scope}] ${message}`);
        return;
    }

    console.log(
        `[ARM-Nator Trace][${scope}] ${message} ${JSON.stringify(payload)}`
    );
}

/**
 * Get the database file path
 */
export function getDatabasePath(): string {
    return getArmNatorDatabasePath();
}

/**
 * SQL statements for creating all tables
 */
const TMDB_METADATA_TABLE_SQL = `CREATE TABLE IF NOT EXISTS tmdb_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv', 'person')),
      lookup_key TEXT NOT NULL,
      language TEXT NOT NULL,
      tmdb_id INTEGER,
      payload TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
)`;
const TMDB_METADATA_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS tmdb_metadata_lookup_unique ON tmdb_metadata(media_type, lookup_key, language)`;

const CREATE_TABLE_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      serverUrl TEXT,
      username TEXT,
      password TEXT,
      date_created TEXT DEFAULT (datetime('now')),
      last_updated TEXT,
      type TEXT NOT NULL CHECK (type IN ('xtream')),
      userAgent TEXT,
      origin TEXT,
      referrer TEXT,
      filePath TEXT,
      autoRefresh INTEGER DEFAULT 0,
      macAddress TEXT,
      url TEXT,
      portal_url TEXT,
      count INTEGER,
      import_date TEXT,
      update_date INTEGER,
      position INTEGER,
      favorites TEXT,
      recently_viewed TEXT,
      payload TEXT,
      last_usage TEXT
  )`,
    `CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
  )`,
    `CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('live', 'movies', 'series')),
      xtream_id INTEGER NOT NULL,
      hidden INTEGER DEFAULT 0,
      UNIQUE(playlist_id, type, xtream_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
  )`,
    `CREATE TABLE IF NOT EXISTS content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      rating TEXT,
      genre TEXT,
      release_date TEXT,
      country TEXT,
      director TEXT,
      cast TEXT,
      description TEXT,
      metadata_status TEXT CHECK (metadata_status IN ('complete', 'failed')),
      metadata_attempted_at TEXT,
      metadata_retry_after TEXT,
      added TEXT,
      poster_url TEXT,
      backdrop_url TEXT,
      tv_archive INTEGER,
      tv_archive_duration INTEGER,
      direct_source TEXT,
      xtream_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('live', 'movie', 'series')),
      UNIQUE(category_id, type, xtream_id),
      FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE CASCADE
  )`,
    `CREATE TABLE IF NOT EXISTS recently_viewed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      playlist_id TEXT NOT NULL,
      viewed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (content_id) REFERENCES content (id) ON DELETE CASCADE,
      FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
  )`,
    `CREATE TABLE IF NOT EXISTS favorites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      playlist_id TEXT NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      position INTEGER DEFAULT 0,
      FOREIGN KEY (content_id) REFERENCES content(id) ON DELETE CASCADE,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
  )`,
    `CREATE INDEX IF NOT EXISTS idx_content_type ON content(type)`,
    `CREATE INDEX IF NOT EXISTS idx_content_category ON content(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_categories_playlist ON categories(playlist_id)`,
    `CREATE INDEX IF NOT EXISTS idx_content_title ON content(title)`,
    `CREATE INDEX IF NOT EXISTS idx_content_xtream ON content(xtream_id)`,
    `CREATE INDEX IF NOT EXISTS idx_content_type_added ON content(type, added)`,
    `CREATE INDEX IF NOT EXISTS idx_categories_type ON categories(type)`,
    // Partial covering index for visible categories — supports the dashboard's
    // getGlobalRecentlyAdded plus searchContent/globalSearch when excludeHidden
    // is set. SQLite can satisfy the join (category_id PK lookup) plus the
    // hidden = 0 filter directly from this index without touching the
    // categories row, and hidden categories are absent so they're skipped
    // before any row lookup.
    `CREATE INDEX IF NOT EXISTS idx_categories_visible ON categories(id, playlist_id, type) WHERE hidden = 0`,
    // Trigram FTS index for global Xtream title search. It supports fast
    // contains matches such as "max" -> "beIN MAX" and "Cinemax" without
    // scanning the full content table.
    `CREATE VIRTUAL TABLE IF NOT EXISTS content_title_fts USING fts5(
      title,
      content='content',
      content_rowid='id',
      tokenize='trigram'
  )`,
    `CREATE TRIGGER IF NOT EXISTS content_title_fts_ai AFTER INSERT ON content BEGIN
      INSERT INTO content_title_fts(rowid, title)
      VALUES (new.id, new.title);
  END`,
    `CREATE TRIGGER IF NOT EXISTS content_title_fts_ad AFTER DELETE ON content BEGIN
      INSERT INTO content_title_fts(content_title_fts, rowid, title)
      VALUES ('delete', old.id, old.title);
  END`,
    `CREATE TRIGGER IF NOT EXISTS content_title_fts_au AFTER UPDATE ON content BEGIN
      INSERT INTO content_title_fts(content_title_fts, rowid, title)
      VALUES ('delete', old.id, old.title);
      INSERT INTO content_title_fts(rowid, title)
      VALUES (new.id, new.title);
  END`,
    // Lean trigram FTS index for the supported catalog search fields. Full
    // cast/director/description indexing is intentionally excluded because it
    // adds substantial storage for a feature that is not required by the
    // title/genre/year search path.
    `CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
      title,
      genre,
      release_date,
      content='content',
      content_rowid='id',
      tokenize='trigram'
  )`,
    `CREATE TRIGGER IF NOT EXISTS content_search_fts_ai AFTER INSERT ON content BEGIN
      INSERT INTO content_search_fts(rowid, title, genre, release_date)
      VALUES (new.id, new.title, new.genre, new.release_date);
  END`,
    `CREATE TRIGGER IF NOT EXISTS content_search_fts_ad AFTER DELETE ON content BEGIN
      INSERT INTO content_search_fts(
        content_search_fts, rowid, title, genre, release_date
      ) VALUES (
        'delete', old.id, old.title, old.genre, old.release_date
      );
  END`,
    `CREATE TRIGGER IF NOT EXISTS content_search_fts_au AFTER UPDATE ON content BEGIN
      INSERT INTO content_search_fts(
        content_search_fts, rowid, title, genre, release_date
      ) VALUES (
        'delete', old.id, old.title, old.genre, old.release_date
      );
      INSERT INTO content_search_fts(rowid, title, genre, release_date)
      VALUES (new.id, new.title, new.genre, new.release_date);
  END`,
    `CREATE UNIQUE INDEX IF NOT EXISTS favorites_content_playlist_unique ON favorites(content_id, playlist_id)`,
    `CREATE INDEX IF NOT EXISTS favorites_playlist_idx ON favorites(playlist_id)`,
    `CREATE INDEX IF NOT EXISTS favorites_content_idx ON favorites(content_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS recently_viewed_content_playlist_unique ON recently_viewed(content_id, playlist_id)`,
    `CREATE INDEX IF NOT EXISTS recently_viewed_playlist_idx ON recently_viewed(playlist_id)`,
    `CREATE INDEX IF NOT EXISTS recently_viewed_viewed_at_idx ON recently_viewed(viewed_at)`,
    `CREATE INDEX IF NOT EXISTS recently_viewed_playlist_viewed_idx ON recently_viewed(playlist_id, viewed_at DESC)`,
    // Playback Positions table
    `CREATE TABLE IF NOT EXISTS playback_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      content_xtream_id INTEGER NOT NULL,
      content_type TEXT NOT NULL CHECK (content_type IN ('vod', 'episode')),
      series_xtream_id INTEGER,
      season_number INTEGER,
      episode_number INTEGER,
      position_seconds INTEGER NOT NULL DEFAULT 0,
      duration_seconds INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE
  )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS playback_positions_content_playlist_unique ON playback_positions(content_xtream_id, playlist_id, content_type)`,
    `CREATE INDEX IF NOT EXISTS playback_positions_playlist_idx ON playback_positions(playlist_id)`,
    `CREATE INDEX IF NOT EXISTS playback_positions_series_idx ON playback_positions(series_xtream_id)`,
    `CREATE INDEX IF NOT EXISTS playback_positions_updated_idx ON playback_positions(updated_at)`,
    `CREATE INDEX IF NOT EXISTS playback_positions_playlist_updated_idx ON playback_positions(playlist_id, updated_at DESC)`,
    // TMDB metadata cache (details payloads + search match resolutions)
    TMDB_METADATA_TABLE_SQL,
    TMDB_METADATA_INDEX_SQL,
];

/**
 * Migration statements that may fail if already applied
 * These are run with try-catch to handle existing columns
 */
const COLUMN_MIGRATION_STATEMENTS = [
    // v1.0.0 -> v1.1.0: Add hidden column to categories for category management
    `ALTER TABLE categories ADD COLUMN hidden INTEGER DEFAULT 0`,
    `ALTER TABLE playlists ADD COLUMN portal_url TEXT`,
    `ALTER TABLE playlists ADD COLUMN count INTEGER`,
    `ALTER TABLE playlists ADD COLUMN import_date TEXT`,
    `ALTER TABLE playlists ADD COLUMN update_date INTEGER`,
    `ALTER TABLE playlists ADD COLUMN position INTEGER`,
    `ALTER TABLE playlists ADD COLUMN favorites TEXT`,
    `ALTER TABLE playlists ADD COLUMN recently_viewed TEXT`,
    `ALTER TABLE playlists ADD COLUMN payload TEXT`,
    // v1.2.0 -> v1.3.0: Add position column to favorites for global favorites ordering
    `ALTER TABLE favorites ADD COLUMN position INTEGER DEFAULT 0`,
    // v1.4.0 -> v1.5.0: Preserve Xtream live archive metadata
    `ALTER TABLE content ADD COLUMN tv_archive INTEGER`,
    `ALTER TABLE content ADD COLUMN tv_archive_duration INTEGER`,
    `ALTER TABLE content ADD COLUMN direct_source TEXT`,
    // v1.5.0 -> v1.6.0: Cinematic backdrop persisted on first detail fetch
    `ALTER TABLE content ADD COLUMN backdrop_url TEXT`,
    // v1.7.0: Preserve searchable movie/series metadata from Xtream lists
    `ALTER TABLE content ADD COLUMN genre TEXT`,
    `ALTER TABLE content ADD COLUMN release_date TEXT`,
    `ALTER TABLE content ADD COLUMN country TEXT`,
    `ALTER TABLE content ADD COLUMN director TEXT`,
    `ALTER TABLE content ADD COLUMN cast TEXT`,
    `ALTER TABLE content ADD COLUMN description TEXT`,
    `ALTER TABLE content ADD COLUMN metadata_status TEXT CHECK (metadata_status IN ('complete', 'failed'))`,
    `ALTER TABLE content ADD COLUMN metadata_attempted_at TEXT`,
    `ALTER TABLE content ADD COLUMN metadata_retry_after TEXT`,
];

const INDEX_MIGRATION_STATEMENTS = [
    // v1.3.0 -> v1.4.0: Prevent duplicate Xtream categories/content rows
    `CREATE UNIQUE INDEX IF NOT EXISTS categories_playlist_type_xtream_unique ON categories(playlist_id, type, xtream_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS content_category_type_xtream_unique ON content(category_id, type, xtream_id)`,
    // v1.6.0 -> v1.7.0: Query global favorites in stable display order
    `CREATE INDEX IF NOT EXISTS favorites_playlist_position_idx ON favorites(playlist_id, position, added_at DESC)`,
];

export const __databaseConnectionTestHooks = {
    createTables,
    createTableStatements: CREATE_TABLE_STATEMENTS,
    columnMigrationStatements: COLUMN_MIGRATION_STATEMENTS,
    indexMigrationStatements: INDEX_MIGRATION_STATEMENTS,
    removeLegacyStalkerAndDownloads,
    normalizeXtreamContentAddedEpochs,
    ensureContentTitleFts,
    ensureContentSearchFts,
    retireContentMetadataFts,
    cleanupLegacyTmdbSearchCache,
    runMigrations,
} as const;

/**
 * Create tables if they don't exist
 */
function createTables(sqliteDb: Database.Database): void {
    for (const stmt of CREATE_TABLE_STATEMENTS) {
        sqliteDb.exec(stmt);
    }
}

function isDuplicateColumnError(error: unknown): boolean {
    const message =
        typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message?: unknown }).message ?? '')
            : '';

    return message.toLowerCase().includes('duplicate column name');
}

type XtreamCategoryDuplicateGroup = {
    playlistId: string;
    type: 'live' | 'movies' | 'series';
    xtreamId: number;
};

type XtreamCategoryCandidate = {
    id: number;
    hidden: number;
    contentCount: number;
};

type XtreamContentDuplicateGroup = {
    categoryId: number;
    type: 'live' | 'movie' | 'series';
    xtreamId: number;
};

type XtreamContentCandidate = {
    id: number;
};

function deduplicateXtreamCache(sqliteDb: Database.Database): void {
    const executeCleanup = sqliteDb.transaction(() => {
        const duplicateCategoryGroups = sqliteDb
            .prepare(
                `SELECT
                    playlist_id AS playlistId,
                    type,
                    xtream_id AS xtreamId
                 FROM categories
                 GROUP BY playlist_id, type, xtream_id
                 HAVING COUNT(*) > 1`
            )
            .all() as XtreamCategoryDuplicateGroup[];

        const selectCategoryCandidates = sqliteDb.prepare(
            `SELECT
                categories.id AS id,
                COALESCE(categories.hidden, 0) AS hidden,
                COUNT(content.id) AS contentCount
             FROM categories
             LEFT JOIN content ON content.category_id = categories.id
             WHERE categories.playlist_id = ?
               AND categories.type = ?
               AND categories.xtream_id = ?
             GROUP BY categories.id, categories.hidden
             ORDER BY COUNT(content.id) DESC, COALESCE(categories.hidden, 0) ASC, categories.id ASC`
        );
        const updateContentCategory = sqliteDb.prepare(
            `UPDATE content SET category_id = ? WHERE category_id = ?`
        );
        const deleteCategory = sqliteDb.prepare(
            `DELETE FROM categories WHERE id = ?`
        );

        for (const group of duplicateCategoryGroups) {
            const candidates = selectCategoryCandidates.all(
                group.playlistId,
                group.type,
                group.xtreamId
            ) as XtreamCategoryCandidate[];
            const canonicalCategoryId = candidates[0]?.id;

            if (!canonicalCategoryId) {
                continue;
            }

            for (const candidate of candidates.slice(1)) {
                updateContentCategory.run(canonicalCategoryId, candidate.id);
                deleteCategory.run(candidate.id);
            }
        }

        const duplicateContentGroups = sqliteDb
            .prepare(
                `SELECT
                    category_id AS categoryId,
                    type,
                    xtream_id AS xtreamId
                 FROM content
                 GROUP BY category_id, type, xtream_id
                 HAVING COUNT(*) > 1`
            )
            .all() as XtreamContentDuplicateGroup[];

        const selectContentCandidates = sqliteDb.prepare(
            `SELECT id
             FROM content
             WHERE category_id = ?
               AND type = ?
               AND xtream_id = ?
             ORDER BY id ASC`
        );
        const moveFavorites = sqliteDb.prepare(
            `INSERT INTO favorites (content_id, playlist_id, added_at, position)
             SELECT ?, playlist_id, added_at, COALESCE(position, 0)
             FROM favorites
             WHERE content_id = ?
             ON CONFLICT(content_id, playlist_id) DO NOTHING`
        );
        const deleteFavorites = sqliteDb.prepare(
            `DELETE FROM favorites WHERE content_id = ?`
        );
        const moveRecentlyViewed = sqliteDb.prepare(
            `INSERT INTO recently_viewed (content_id, playlist_id, viewed_at)
             SELECT ?, playlist_id, viewed_at
             FROM recently_viewed
             WHERE content_id = ?
             ON CONFLICT(content_id, playlist_id) DO UPDATE SET
                viewed_at = CASE
                    WHEN excluded.viewed_at > recently_viewed.viewed_at
                        THEN excluded.viewed_at
                    ELSE recently_viewed.viewed_at
                END`
        );
        const deleteRecentlyViewed = sqliteDb.prepare(
            `DELETE FROM recently_viewed WHERE content_id = ?`
        );
        const deleteContent = sqliteDb.prepare(
            `DELETE FROM content WHERE id = ?`
        );

        for (const group of duplicateContentGroups) {
            const candidates = selectContentCandidates.all(
                group.categoryId,
                group.type,
                group.xtreamId
            ) as XtreamContentCandidate[];
            const canonicalContentId = candidates[0]?.id;

            if (!canonicalContentId) {
                continue;
            }

            for (const candidate of candidates.slice(1)) {
                moveFavorites.run(canonicalContentId, candidate.id);
                deleteFavorites.run(candidate.id);
                moveRecentlyViewed.run(canonicalContentId, candidate.id);
                deleteRecentlyViewed.run(candidate.id);
                deleteContent.run(candidate.id);
            }
        }
    });

    executeCleanup();
}

function normalizeXtreamContentAddedEpochs(sqliteDb: Database.Database): void {
    try {
        const migrationState = sqliteDb
            .prepare(`SELECT value FROM app_state WHERE key = ?`)
            .get(XTREAM_ADDED_EPOCH_SECONDS_MIGRATION_KEY) as
            | { value?: unknown }
            | undefined;

        if (migrationState?.value === 'done') {
            return;
        }

        const executeMigration = sqliteDb.transaction(() => {
            sqliteDb
                .prepare(
                    `UPDATE content
                     SET added = CAST(CAST(added AS INTEGER) / 1000 AS TEXT)
                     WHERE added IS NOT NULL
                       AND added <> ''
                       AND added NOT GLOB '*[^0-9]*'
                       AND CAST(added AS INTEGER) >= ?
                       AND CAST(added AS INTEGER) / 1000 < ?`
                )
                .run(
                    XTREAM_ADDED_EPOCH_MILLISECONDS_THRESHOLD,
                    XTREAM_ADDED_EPOCH_MILLISECONDS_THRESHOLD
                );

            sqliteDb
                .prepare(
                    `INSERT INTO app_state (key, value, updated_at)
                     VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at`
                )
                .run(XTREAM_ADDED_EPOCH_SECONDS_MIGRATION_KEY);
        });

        executeMigration();
    } catch (error) {
        const message =
            typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: unknown }).message ?? error)
                : String(error);

        console.warn(
            `Xtream added timestamp normalization failed (continuing): ${message}`
        );
    }
}

function ensureContentTitleFts(sqliteDb: Database.Database): void {
    try {
        const migrationState = sqliteDb
            .prepare(`SELECT value FROM app_state WHERE key = ?`)
            .get(CONTENT_TITLE_FTS_MIGRATION_KEY) as
            | { value?: unknown }
            | undefined;

        if (migrationState?.value === 'done') {
            return;
        }

        const executeMigration = sqliteDb.transaction(() => {
            sqliteDb
                .prepare(
                    `INSERT INTO content_title_fts(content_title_fts)
                     VALUES ('rebuild')`
                )
                .run();

            sqliteDb
                .prepare(
                    `INSERT INTO app_state (key, value, updated_at)
                     VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at`
                )
                .run(CONTENT_TITLE_FTS_MIGRATION_KEY);
        });

        executeMigration();
    } catch (error) {
        const message =
            typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: unknown }).message ?? error)
                : String(error);

        console.warn(
            `Content title FTS rebuild failed (continuing): ${message}`
        );
    }
}

function ensureContentSearchFts(sqliteDb: Database.Database): boolean {
    try {
        sqliteDb.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS content_search_fts USING fts5(
                title,
                genre,
                release_date,
                content='content',
                content_rowid='id',
                tokenize='trigram'
            );
            CREATE TRIGGER IF NOT EXISTS content_search_fts_ai
            AFTER INSERT ON content BEGIN
                INSERT INTO content_search_fts(rowid, title, genre, release_date)
                VALUES (new.id, new.title, new.genre, new.release_date);
            END;
            CREATE TRIGGER IF NOT EXISTS content_search_fts_ad
            AFTER DELETE ON content BEGIN
                INSERT INTO content_search_fts(
                    content_search_fts, rowid, title, genre, release_date
                ) VALUES (
                    'delete', old.id, old.title, old.genre, old.release_date
                );
            END;
            CREATE TRIGGER IF NOT EXISTS content_search_fts_au
            AFTER UPDATE ON content BEGIN
                INSERT INTO content_search_fts(
                    content_search_fts, rowid, title, genre, release_date
                ) VALUES (
                    'delete', old.id, old.title, old.genre, old.release_date
                );
                INSERT INTO content_search_fts(rowid, title, genre, release_date)
                VALUES (new.id, new.title, new.genre, new.release_date);
            END;
        `);

        const migrationState = sqliteDb
            .prepare(`SELECT value FROM app_state WHERE key = ?`)
            .get(CONTENT_SEARCH_FTS_MIGRATION_KEY) as
            | { value?: unknown }
            | undefined;
        if (migrationState?.value === 'done') {
            return true;
        }

        const executeMigration = sqliteDb.transaction(() => {
            sqliteDb
                .prepare(
                    `INSERT INTO content_search_fts(content_search_fts)
                     VALUES ('rebuild')`
                )
                .run();
            sqliteDb
                .prepare(
                    `INSERT INTO app_state (key, value, updated_at)
                     VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at`
                )
                .run(CONTENT_SEARCH_FTS_MIGRATION_KEY);
        });
        executeMigration();
        return true;
    } catch (error) {
        const message =
            typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: unknown }).message ?? error)
                : String(error);
        console.warn(
            `Content search FTS rebuild failed (continuing): ${message}`
        );
        return false;
    }
}

function retireContentMetadataFts(sqliteDb: Database.Database): void {
    try {
        const migrationState = sqliteDb
            .prepare(`SELECT value FROM app_state WHERE key = ?`)
            .get(CONTENT_METADATA_FTS_RETIREMENT_MIGRATION_KEY) as
            | { value?: unknown }
            | undefined;

        if (migrationState?.value === 'done') {
            return;
        }

        sqliteDb.exec(`
            DROP TRIGGER IF EXISTS content_metadata_fts_ai;
            DROP TRIGGER IF EXISTS content_metadata_fts_ad;
            DROP TRIGGER IF EXISTS content_metadata_fts_au;
            DROP TABLE IF EXISTS content_metadata_fts;
        `);

        // Dropping an FTS table returns pages to SQLite's freelist. Compact
        // this one-time migration so users actually recover the disk space.
        sqliteDb.exec('VACUUM');
        sqliteDb
            .prepare(
                `INSERT INTO app_state (key, value, updated_at)
                 VALUES (?, 'done', datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at`
            )
            .run(CONTENT_METADATA_FTS_RETIREMENT_MIGRATION_KEY);
    } catch (error) {
        const message =
            typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: unknown }).message ?? error)
                : String(error);

        console.warn(
            `Retiring legacy content metadata FTS failed (continuing): ${message}`
        );
    }
}

function runMigrationStatements(
    sqliteDb: Database.Database,
    statements: string[]
): void {
    for (const stmt of statements) {
        try {
            sqliteDb.exec(stmt);
        } catch (error) {
            // Ignore idempotent ALTER TABLE errors on existing columns.
            if (isDuplicateColumnError(error)) {
                continue;
            }

            const compactStmt = stmt.replace(/\s+/g, ' ').trim();
            const message =
                typeof error === 'object' &&
                error !== null &&
                'message' in error
                    ? String((error as { message?: unknown }).message ?? error)
                    : String(error);

            console.warn(
                `Migration failed (continuing): ${compactStmt} :: ${message}`
            );
        }
    }
}

/**
 * Pre-release installs created tmdb_metadata with a CHECK that only
 * allowed 'movie'/'tv'; person rows need 'person'. The table is a pure
 * cache, so the cheapest "migration" is a drop-and-recreate with the
 * widened constraint. Self-healing via sqlite_master — no app_state key.
 */
function widenTmdbMetadataMediaTypeCheck(sqliteDb: Database.Database): void {
    try {
        const row = sqliteDb
            .prepare(
                `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tmdb_metadata'`
            )
            .get() as { sql?: string } | undefined;
        if (!row?.sql || row.sql.includes(`'person'`)) {
            return;
        }
        const rebuild = sqliteDb.transaction(() => {
            sqliteDb.prepare(`DROP TABLE IF EXISTS tmdb_metadata`).run();
            sqliteDb.prepare(TMDB_METADATA_TABLE_SQL).run();
            sqliteDb.prepare(TMDB_METADATA_INDEX_SQL).run();
        });
        rebuild();
        console.log(
            '[DB] Rebuilt tmdb_metadata cache with widened media_type CHECK'
        );
    } catch (error) {
        console.warn('[DB] tmdb_metadata CHECK widening failed:', error);
    }
}

/**
 * Search-match cache keys gained a v2 suffix when title normalization changed.
 * Remove the now-unreachable unversioned rows once rather than leaving negative
 * resolutions and other legacy search matches in long-lived installations.
 */
function cleanupLegacyTmdbSearchCache(sqliteDb: Database.Database): void {
    try {
        const migrationState = sqliteDb
            .prepare(`SELECT value FROM app_state WHERE key = ?`)
            .get(TMDB_SEARCH_LOOKUP_V2_CACHE_CLEANUP_MIGRATION_KEY) as
            | { value?: unknown }
            | undefined;

        if (migrationState?.value === 'done') {
            return;
        }

        const executeCleanup = sqliteDb.transaction(() => {
            sqliteDb
                .prepare(
                    `DELETE FROM tmdb_metadata
                     WHERE lookup_key LIKE 'title:%|year:%'
                       AND lookup_key NOT LIKE 'title:%|year:%|v%'`
                )
                .run();
            sqliteDb
                .prepare(
                    `INSERT INTO app_state (key, value, updated_at)
                     VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at`
                )
                .run(TMDB_SEARCH_LOOKUP_V2_CACHE_CLEANUP_MIGRATION_KEY);
        });

        executeCleanup();
    } catch (error) {
        const message =
            typeof error === 'object' && error !== null && 'message' in error
                ? String((error as { message?: unknown }).message ?? error)
                : String(error);

        console.warn(
            `Legacy TMDB search cache cleanup failed (continuing): ${message}`
        );
    }
}

const LEGACY_STALKER_DOWNLOADS_CLEANUP_KEY =
    'migration:remove-stalker-downloads:v1';

/** Remove retired product data once, after foreign-key cascades are enabled. */
function removeLegacyStalkerAndDownloads(sqliteDb: Database.Database): void {
    try {
        const alreadyDone = sqliteDb
            .prepare(
                `SELECT value FROM app_state WHERE key = ? LIMIT 1`
            )
            .get(LEGACY_STALKER_DOWNLOADS_CLEANUP_KEY) as
            | { value?: string }
            | undefined;
        if (alreadyDone?.value === 'done') {
            return;
        }

        const cleanup = sqliteDb.transaction(() => {
            sqliteDb
                .prepare(`DELETE FROM playlists WHERE type = 'stalker'`)
                .run();
            sqliteDb.prepare(`DROP TABLE IF EXISTS downloads`).run();
            sqliteDb
                .prepare(
                    `INSERT INTO app_state (key, value, updated_at)
                     VALUES (?, 'done', datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET
                        value = excluded.value,
                        updated_at = excluded.updated_at`
                )
                .run(LEGACY_STALKER_DOWNLOADS_CLEANUP_KEY);
        });

        cleanup();
        console.log('[DB] Removed retired Stalker playlists and downloads');
    } catch (error) {
        console.warn('[DB] retired Stalker/download cleanup failed:', error);
    }
}

/**
 * Run migrations that may fail if already applied
 */
function runMigrations(sqliteDb: Database.Database): void {
    widenTmdbMetadataMediaTypeCheck(sqliteDb);
    cleanupLegacyTmdbSearchCache(sqliteDb);
    removeLegacyStalkerAndDownloads(sqliteDb);
    runMigrationStatements(sqliteDb, COLUMN_MIGRATION_STATEMENTS);
    ensureContentTitleFts(sqliteDb);
    if (ensureContentSearchFts(sqliteDb)) {
        retireContentMetadataFts(sqliteDb);
    }
    deduplicateXtreamCache(sqliteDb);
    normalizeXtreamContentAddedEpochs(sqliteDb);
    runMigrationStatements(sqliteDb, INDEX_MIGRATION_STATEMENTS);
}

export interface DatabaseOptions {
    /** Open database in read-only mode (for agent-backend) */
    readonly?: boolean;
    /** Skip table creation (useful for read-only connections) */
    skipTableCreation?: boolean;
}

/**
 * Initialize the database connection with full access (read-write)
 * Creates tables if they don't exist
 * Used by electron-backend
 */
export async function initDatabase(
    options: DatabaseOptions = {}
): Promise<DatabaseInstance> {
    const { readonly = false, skipTableCreation = false } = options;

    if (db) return db;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        const filePath = getDatabasePath();
        sqlite = new Database(filePath, {
            readonly,
            verbose: isSqlTraceEnabled()
                ? (message?: unknown) => {
                      traceSql('sql-main', 'query', {
                          sql: compactSqlForTrace(String(message ?? '')),
                      });
                  }
                : undefined,
        });

        if (isSqlTraceEnabled()) {
            traceSql('sql-main', 'open', {
                filePath,
                readonly,
            });
        }

        // Enable foreign keys
        sqlite.pragma('foreign_keys = ON');
        sqlite.pragma('busy_timeout = 5000');

        if (!readonly) {
            sqlite.pragma('journal_mode = WAL');
            sqlite.pragma('synchronous = NORMAL');
        }

        sqlite.pragma('cache_size = -64000');
        sqlite.pragma('temp_store = MEMORY');
        sqlite.pragma('mmap_size = 268435456');

        // Create tables only for read-write connections
        if (!readonly && !skipTableCreation) {
            createTables(sqlite);
            runMigrations(sqlite);
        }

        const database = drizzle(sqlite, { schema });
        db = database;
        return database;
    })();

    return initPromise;
}

/**
 * Get the database instance
 * Initializes the database if not already initialized (with defaults for full access)
 * Used by electron-backend
 */
export async function getDatabase(
    options?: DatabaseOptions
): Promise<DatabaseInstance> {
    if (db) return db;
    return initDatabase(options);
}

/**
 * Get a read-only database connection
 * Used by agent-backend for safe read-only queries
 */
export async function getReadOnlyDatabase(): Promise<DatabaseInstance> {
    return getDatabase({ readonly: true, skipTableCreation: true });
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
    if (sqlite) {
        try {
            sqlite.pragma('optimize');
        } catch {
            // Optimize is advisory; never block close on it.
        }

        sqlite.close();

        if (isSqlTraceEnabled()) {
            traceSql('sql-main', 'close');
        }

        sqlite = null;
        db = null;
        initPromise = null;
    }
}
