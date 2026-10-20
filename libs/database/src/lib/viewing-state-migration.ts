import type Database from 'better-sqlite3';

/** Additive and transactional: existing provider positions remain authoritative raw history. */
export function migrateViewingState(sqlite: Database.Database): void {
    sqlite.transaction(() => { sqlite.exec(`
        CREATE TABLE IF NOT EXISTS matched_works (
            id TEXT PRIMARY KEY, kind TEXT NOT NULL, title_key TEXT, tmdb_id TEXT, imdb_id TEXT, descriptor TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS matched_works_title_idx ON matched_works(title_key);
        CREATE INDEX IF NOT EXISTS matched_works_tmdb_idx ON matched_works(kind, tmdb_id);
        CREATE INDEX IF NOT EXISTS matched_works_imdb_idx ON matched_works(kind, imdb_id);
        CREATE TABLE IF NOT EXISTS source_aliases (
            identity_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, playlist_id TEXT NOT NULL,
            content_kind TEXT NOT NULL, provider_item_id TEXT NOT NULL, work_id TEXT REFERENCES matched_works(id) ON DELETE SET NULL,
            descriptor TEXT, shared_allowed INTEGER NOT NULL DEFAULT 1, version_metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS source_aliases_work_idx ON source_aliases(work_id);
        CREATE INDEX IF NOT EXISTS source_aliases_source_idx ON source_aliases(source_type, playlist_id);
        CREATE TABLE IF NOT EXISTS version_viewing_state (
            identity_key TEXT PRIMARY KEY REFERENCES source_aliases(identity_key) ON DELETE CASCADE,
            position_seconds REAL NOT NULL, duration_seconds REAL, confirmed_at INTEGER NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('progress', 'finished', 'reset'))
        );
        CREATE TABLE IF NOT EXISTS shared_viewing_state (
            work_id TEXT PRIMARY KEY REFERENCES matched_works(id) ON DELETE CASCADE,
            identity_key TEXT NOT NULL REFERENCES source_aliases(identity_key),
            position_seconds REAL NOT NULL, duration_seconds REAL, confirmed_at INTEGER NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('progress', 'finished', 'reset'))
        );
        CREATE TABLE IF NOT EXISTS title_preferences (
            work_id TEXT PRIMARY KEY REFERENCES matched_works(id) ON DELETE CASCADE,
            preferences TEXT NOT NULL, updated_at INTEGER NOT NULL
        );
    `);
        const columns = sqlite.pragma('table_info(version_viewing_state)') as { name: string }[];
        if (!columns.some(column => column.name === 'successful_at')) sqlite.exec('ALTER TABLE version_viewing_state ADD COLUMN successful_at INTEGER');
    })();
}
