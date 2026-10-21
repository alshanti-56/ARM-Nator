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
