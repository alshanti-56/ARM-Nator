import assert from "node:assert/strict";
import test from "node:test";
import { nextSourceCheck, sourceCheckBackoff } from "./source-check-scheduler";
import { sourceEvidenceKey } from "@arm-nator/shared/interfaces";
const keys = ["a", "b"].flatMap((sourceId) =>
  ["live", "movies", "series"].map((category) => ({
    sourceId,
    revision: "r",
    category: category as "live" | "movies" | "series",
  })),
);
const input = {
  keys,
  supported: ["live"] as const,
  due: new Map<string, number>(),
  busySourceIds: new Set<string>(),
  occupied: false,
  idleSince: 0,
  lastServedKey: null,
};
test("requires ten continuous idle seconds, skips unsupported and busy sources, rotates after slow work", () => {
  assert.equal(nextSourceCheck(input, 9999), null);
  assert.deepEqual(nextSourceCheck(input, 10000), keys[0]);
  assert.equal(nextSourceCheck({ ...input, occupied: true }, 10000), null);
  assert.equal(nextSourceCheck({ ...input, idleSince: 10001 }, 20000), null);
  assert.deepEqual(
    nextSourceCheck(
      { ...input, lastServedKey: sourceEvidenceKey(keys[0]) },
      80000,
    ),
    keys[3],
  );
  assert.deepEqual(
    nextSourceCheck({ ...input, busySourceIds: new Set(["a"]) }, 10000),
    keys[3],
  );
  assert.equal(
    nextSourceCheck(
      {
        ...input,
        due: new Map(keys.map((k) => [sourceEvidenceKey(k), 86400000])),
      },
      86399999,
    ),
    null,
  );
  assert.deepEqual(
    nextSourceCheck(
      {
        ...input,
        due: new Map(keys.map((k) => [sourceEvidenceKey(k), 86400000])),
      },
      86400000,
    ),
    keys[0],
  );
});
test("inconclusive cooldown doubles from 15 minutes to six hours and honors longer Retry-After", () => {
  for (const [count, minutes] of [
    [1, 15],
    [2, 30],
    [3, 60],
    [6, 360],
    [20, 360],
  ])
    assert.equal(
      sourceCheckBackoff({ inconclusiveCount: count }, 100),
      100 + minutes * 60000,
    );
  assert.equal(
    sourceCheckBackoff({ inconclusiveCount: 1, retryAfterMs: 86400000 }, 100),
    86400100,
  );
});
test("all-category fairness moves to a different source after one slow category", () => {
  assert.deepEqual(
    nextSourceCheck(
      {
        ...input,
        supported: ["live", "movies", "series"],
        lastServedKey: sourceEvidenceKey(keys[0]),
      },
      80000,
    ),
    keys[3],
  );
  assert.deepEqual(
    nextSourceCheck(
      {
        ...input,
        supported: ["live", "movies", "series"],
        lastServedKey: sourceEvidenceKey(keys[3]),
        due: new Map([[sourceEvidenceKey(keys[0]), 86400000]]),
      },
      90000,
    ),
    keys[1],
  );
});
