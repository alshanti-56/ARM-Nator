import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import {
  fixture,
  evidence,
} from "../../database/operations/source-playback.test-fixtures";
import {
  readSourcePlaybackEvidence,
  saveSourcePlaybackEvidence,
  saveSourcePlaybackAccount,
} from "../../database/operations/source-playback.operations";
test("registered IPC handlers validate payloads and reach evidence operations", () => {
  const require = createRequire(import.meta.url);
  const moduleApi = require("node:module");
  const original = moduleApi._load;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const { db, sqlite } = fixture();
  try {
    moduleApi._load = function (request: string, ...args: unknown[]) {
      if (request === "./worker-events.utils")
        return {
          handleWorkerRequest: (
            channel: string,
            build: (...args: unknown[]) => unknown,
          ) => handlers.set(channel, (...a) => build(...a)),
        };
      return original.call(this, request, ...args);
    };
    require("./source-playback.events");
    moduleApi._load = original;
    const read = handlers.get("DB_GET_SOURCE_PLAYBACK_EVIDENCE")!;
    const save = handlers.get("DB_SAVE_SOURCE_PLAYBACK_EVIDENCE")!;
    assert.throws(() => read("not-array"));
    const payload = read(["one"]) as { sourceIds: string[] };
    const revision = readSourcePlaybackEvidence(db, payload.sourceIds)[0]
      .revision;
    assert.equal(
      saveSourcePlaybackEvidence(db, save(evidence(revision))),
      "saved",
    );
    assert.throws(() => save({ ...evidence(revision), password: "secret" }));
    const account = {
      checkedAt: Date.now(),
      expiresAt: null,
      expiryKind: "unknown" as const,
      activeConnections: null,
      maxConnections: null,
    };
    const a = handlers.get("DB_SAVE_SOURCE_PLAYBACK_ACCOUNT")!(
      "one",
      revision,
      account,
    ) as { sourceId: string; revision: string; account: typeof account };
    assert.equal(
      saveSourcePlaybackAccount(db, a.sourceId, a.revision, a.account),
      "saved",
    );
  } finally {
    moduleApi._load = original;
    sqlite.close();
  }
});
