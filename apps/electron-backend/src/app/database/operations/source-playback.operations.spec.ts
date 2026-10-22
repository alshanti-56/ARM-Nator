/* eslint-disable @nx/enforce-module-boundaries -- Integration fixture deliberately loads the real SQLite/player module without browser barrel side effects. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, evidence } from "./source-playback.test-fixtures";
import {
  readSourcePlaybackEvidence,
  saveSourcePlaybackEvidence,
  saveSourcePlaybackAccount,
} from "./source-playback.operations";
import { migrateSourcePlayback } from "../../../../../../libs/database/src/lib/source-playback-migration";
test("migration is idempotent and evidence survives reopening without pruning latest success", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-evidence-"));
  const path = join(dir, "test.db");
  try {
    let f = fixture(path);
    const revision = readSourcePlaybackEvidence(f.db, ["one"])[0].revision;
    migrateSourcePlayback(f.sqlite);
    assert.equal(saveSourcePlaybackEvidence(f.db, evidence(revision)), "saved");
    f.sqlite.close();
    f = fixture(path);
    const data = readSourcePlaybackEvidence(f.db, ["one"])[0];
    assert.equal(data.latest[0].result, "verified");
    assert.equal(data.revision, revision);
    f.sqlite.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("caps history, coalesces attempts and rejects obsolete or unsafe writes atomically", () => {
  const { db, sqlite } = fixture();
  try {
    const revision = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    const now = Date.now();
    for (let i = 0; i < 25; i++)
      saveSourcePlaybackEvidence(db, evidence(revision, now + i));
    let data = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(data.observations.length, 20);
    saveSourcePlaybackEvidence(
      db,
      evidence(revision, now + 30, String(now + 24)),
    );
    data = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(data.observations.length, 20);
    saveSourcePlaybackEvidence(
      db,
      evidence(revision, now - 31 * 86400000, "old"),
    );
    data = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(data.observations.length, 20);
    assert.equal(data.latest[0].completedAt, now + 30);
    assert.equal(
      saveSourcePlaybackEvidence(db, evidence("obsolete")),
      "obsolete",
    );
    const before = JSON.stringify(data);
    assert.throws(() =>
      saveSourcePlaybackEvidence(db, {
        ...evidence(revision),
        url: "https://secret.test/password",
      } as never),
    );
    assert.equal(
      JSON.stringify(readSourcePlaybackEvidence(db, ["one"])[0]),
      before,
    );
  } finally {
    sqlite.close();
  }
});
test("inconclusive attempt preserves last result; missing accounts remain nullable", () => {
  const { db, sqlite } = fixture();
  try {
    const revision = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    const initial = evidence(revision);
    saveSourcePlaybackEvidence(db, initial);
    const attempt = {
      ...initial.attempt,
      completedAt: initial.attempt.completedAt + 1,
      samples: [],
      reason: "cancelled" as const,
    };
    saveSourcePlaybackEvidence(db, { attempt });
    const data = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(data.latest[0].result, "verified");
    assert.equal(data.attempts[0].reason, "cancelled");
    assert.equal(
      saveSourcePlaybackAccount(db, "one", revision, {
        checkedAt: Date.now(),
        expiresAt: null,
        expiryKind: "unknown",
        activeConnections: null,
        maxConnections: null,
      }),
      "saved",
    );
    assert.equal(
      readSourcePlaybackEvidence(db, ["one"])[0].account?.maxConnections,
      null,
    );
  } finally {
    sqlite.close();
  }
});

test("candidate query limits before IPC and excludes hidden and unavailable categories", async () => {
  const { getSourcePlaybackCandidates } =
    await import("./source-playback.operations");
  const { db, sqlite } = fixture();
  try {
    sqlite.exec(
      "CREATE TABLE categories(id INTEGER PRIMARY KEY,playlist_id TEXT,xtream_id INTEGER,type TEXT,hidden INTEGER,available INTEGER);CREATE TABLE content(id INTEGER PRIMARY KEY,category_id INTEGER,xtream_id INTEGER,title TEXT,type TEXT,available INTEGER)",
    );
    sqlite.exec(
      "INSERT INTO categories VALUES(1,'one',100,'live',0,1),(2,'one',200,'live',1,1);INSERT INTO content VALUES(1,1,11,'Visible one','live',1),(2,1,12,'Visible two','live',1),(3,1,13,'Visible three','live',1),(4,1,14,'Visible four','live',1),(5,2,15,'Hidden','live',1)",
    );
    const selected = getSourcePlaybackCandidates(db, {
      sourceId: "one",
      category: "live",
      limit: 3,
    });
    assert.equal(selected.length, 3);
    assert.equal(
      selected.some((x) => x.title === "Hidden"),
      false,
    );
    assert.equal(
      getSourcePlaybackCandidates(db, {
        sourceId: "one",
        category: "live",
        limit: 3,
        cursor: selected.at(-1)?.cursor,
      })[0].itemId,
      "14",
    );
    assert.throws(() =>
      getSourcePlaybackCandidates(db, {
        sourceId: "one",
        category: "live",
        limit: 300,
      }),
    );
  } finally {
    sqlite.close();
  }
});
test("provider identifiers and cursors cannot persist credential-bearing URLs", () => {
  const { db, sqlite } = fixture();
  try {
    const revision = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    for (const secret of [
      "https://provider.test/live/user/password/1?token=secret",
      "id?username=user&password=secret",
    ]) {
      const write = structuredClone(evidence(revision));
      for (const sample of write.attempt.samples as any[])
        sample.itemId = secret;
      for (const sample of write.observation!.samples as any[])
        sample.itemId = secret;
      assert.throws(() => saveSourcePlaybackEvidence(db, write));
      const cursor = structuredClone(evidence(revision));
      cursor.cursor = secret;
      assert.throws(() => saveSourcePlaybackEvidence(db, cursor));
    }
    assert.equal(
      readSourcePlaybackEvidence(db, ["one"])[0].observations.length,
      0,
    );
  } finally {
    sqlite.close();
  }
});
