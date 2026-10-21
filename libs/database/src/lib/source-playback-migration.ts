import type Database from "better-sqlite3";
/** Triggers keep every playlist write path and evidence invalidation in one transaction. */
export function migrateSourcePlayback(sqlite: Database.Database): void {
  const columns = [
    "serverUrl",
    "username",
    "password",
    "userAgent",
    "origin",
    "referrer",
    "macAddress",
    "portal_url",
  ];
  const deviceFields = [
    "stalkerSerialNumber",
    "serialNumber",
    "stalkerDeviceId1",
    "stalkerDeviceId2",
    "stalkerSignature1",
    "stalkerSignature2",
    "stalkerSessionIdentity",
  ];
  const changed = [
    ...columns.map((c) => `OLD.${c} IS NOT NEW.${c}`),
    ...deviceFields.map(
      (c) =>
        `json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END, '$.${c}') IS NOT json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END, '$.${c}')`,
    ),
  ].join(" OR ");
  sqlite.transaction(() =>
    sqlite.exec(`
 CREATE TABLE IF NOT EXISTS source_playback_sources(source_id TEXT PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE, revision TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS source_playback_categories(source_id TEXT NOT NULL REFERENCES source_playback_sources(source_id) ON DELETE CASCADE, category TEXT NOT NULL, latest TEXT, successful_at INTEGER, attempt TEXT, cursor TEXT, next_eligible_at INTEGER, inconclusive_count INTEGER DEFAULT 0, PRIMARY KEY(source_id,category));
 CREATE TABLE IF NOT EXISTS source_playback_observations(source_id TEXT NOT NULL REFERENCES source_playback_sources(source_id) ON DELETE CASCADE, category TEXT NOT NULL, check_id TEXT NOT NULL, completed_at INTEGER NOT NULL, observation TEXT NOT NULL, PRIMARY KEY(source_id,category,check_id));
 CREATE INDEX IF NOT EXISTS source_playback_history_idx ON source_playback_observations(source_id,category,completed_at);
 CREATE TABLE IF NOT EXISTS source_playback_accounts(source_id TEXT PRIMARY KEY REFERENCES source_playback_sources(source_id) ON DELETE CASCADE,snapshot TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS source_playback_insert AFTER INSERT ON playlists BEGIN INSERT OR IGNORE INTO source_playback_sources VALUES(NEW.id,lower(hex(randomblob(16)))); END;
 CREATE TRIGGER IF NOT EXISTS source_playback_identity AFTER UPDATE ON playlists WHEN ${changed} BEGIN DELETE FROM source_playback_sources WHERE source_id=NEW.id; INSERT INTO source_playback_sources VALUES(NEW.id,lower(hex(randomblob(16)))); END;
 INSERT OR IGNORE INTO source_playback_sources SELECT id,lower(hex(randomblob(16))) FROM playlists;
 `),
  )();
}
