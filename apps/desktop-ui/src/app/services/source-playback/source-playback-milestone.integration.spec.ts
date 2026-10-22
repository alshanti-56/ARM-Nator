/* eslint-disable @nx/enforce-module-boundaries -- Integration fixture deliberately loads the real SQLite/player module without browser barrel side effects. */
import assert from "node:assert/strict";
import test from "node:test";
import { runPersistedSourceCheck } from "./source-playback-check-runner";
import { fixture } from "../../../../../../apps/electron-backend/src/app/database/operations/source-playback.test-fixtures";
import {
  readSourcePlaybackEvidence,
  saveSourcePlaybackEvidence,
} from "../../../../../../apps/electron-backend/src/app/database/operations/source-playback.operations";
const candidate = {
  itemId: "7",
  title: "Fixture Live",
  category: "live" as const,
  categoryId: "1",
};
test("Xtream Live sample outcomes are saved and source edits reject late results", async () => {
  const { db, sqlite } = fixture();
  try {
    const revision = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    let probes = 0;
    const dependencies = {
      select: async () => [candidate, { ...candidate, itemId: "8" }],
      resolve: async () => ({
        streamUrl: "https://fixture.test/live",
        title: "Fixture Live",
      }),
      probe: async () => ({
        outcome: ++probes === 1 ? ("failed" as const) : ("played" as const),
        reason: null,
        elapsedMs: 6000,
        engine: "html5",
        audioOnly: false,
      }),
      drain: async () => {
        /* Test double intentionally has no side effects. */
      },
    };
    const repository = {
      read: async (ids: readonly string[]) =>
        readSourcePlaybackEvidence(db, [...ids]),
      write: async (input: unknown) => saveSourcePlaybackEvidence(db, input),
    };
    assert.equal(
      await runPersistedSourceCheck(
        { sourceId: "one", revision, category: "live" },
        "manual",
        new AbortController().signal,
        dependencies,
        repository,
      ),
      "saved",
    );
    let snapshot = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(snapshot.latest[0].result, "mixed");
    assert.equal(snapshot.latest[0].samples.length, 2);
    assert.equal(
      snapshot.latest.some((o) => o.key.category === "movies"),
      false,
    );
    dependencies.probe = async () => {
      sqlite
        .prepare("UPDATE playlists SET username='changed' WHERE id='one'")
        .run();
      return {
        outcome: "played",
        reason: null,
        elapsedMs: 6000,
        engine: "html5",
        audioOnly: false,
      };
    };
    assert.equal(
      await runPersistedSourceCheck(
        { sourceId: "one", revision, category: "live" },
        "manual",
        new AbortController().signal,
        dependencies,
        repository,
      ),
      "obsolete",
    );
    snapshot = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.equal(snapshot.latest.length, 0);
  } finally {
    sqlite.close();
  }
});
test("failed persistence propagates and does not publish saved evidence", async () => {
  await assert.rejects(
    runPersistedSourceCheck(
      { sourceId: "one", revision: "r", category: "live" },
      "manual",
      new AbortController().signal,
      {
        select: async () => [candidate],
        resolve: async () => ({
          streamUrl: "https://fixture.test/live",
          title: "Live",
        }),
        probe: async () => ({
          outcome: "played",
          reason: null,
          elapsedMs: 6000,
          engine: "html5",
          audioOnly: false,
        }),
        drain: async () => {
          /* Test double intentionally has no side effects. */
        },
      },
      {
        read: async () => [{ sourceId: "one", revision: "r" } as never],
        write: async () => {
          throw Error("disk full");
        },
      },
    ),
    /disk full/,
  );
});
