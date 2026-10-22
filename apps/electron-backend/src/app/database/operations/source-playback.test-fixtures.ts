/* eslint-disable @nx/enforce-module-boundaries -- Integration fixture deliberately loads the real SQLite/player module without browser barrel side effects. */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@arm-nator/database/schema";
import { migrateSourcePlayback } from "../../../../../../libs/database/src/lib/source-playback-migration";
import type {
  SourceCheckAttempt,
  SourceEvidenceWrite,
} from "@arm-nator/shared/interfaces";
export function fixture(path = ":memory:") {
  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys=ON");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,name TEXT,type TEXT,serverUrl TEXT,username TEXT,password TEXT,userAgent TEXT,origin TEXT,referrer TEXT,macAddress TEXT,portal_url TEXT,payload TEXT)",
  );
  migrateSourcePlayback(sqlite);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO playlists(id,name,type,serverUrl,username) VALUES ('one','One','xtream','https://example.test','account')",
    )
    .run();
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
export function evidence(
  revision: string,
  at = Date.now(),
  id = String(at),
): SourceEvidenceWrite {
  const attempt: SourceCheckAttempt = {
    checkId: id,
    key: { sourceId: "one", revision, category: "live" },
    origin: "manual",
    startedAt: at - 100,
    completedAt: at,
    reason: null,
    samples: [
      {
        itemId: "7",
        title: "Sample channel",
        outcome: "played",
        reason: null,
        elapsedMs: 100,
        engine: "html5",
        audioOnly: false,
      },
    ],
  };
  const { reason: _, ...base } = attempt;
  return {
    attempt,
    observation: { ...base, result: "verified", successfulAt: at },
  };
}
