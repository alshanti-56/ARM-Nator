import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import { runSourceSampleCheck } from "./source-playback-check-runner";
import type {
  SourcePlaybackCandidate,
  SourceSampleEvidence,
} from "@arm-nator/shared/interfaces";
const key = { sourceId: "one", revision: "r", category: "live" as const };
const candidates: SourcePlaybackCandidate[] = Array.from(
  { length: 3 },
  (_, i) => ({
    itemId: String(i),
    title: "Sample " + i,
    category: "live",
    categoryId: "1",
  }),
);
function setup(
  outcomes: SourceSampleEvidence["outcome"][],
  items = candidates,
) {
  let calls = 0,
    closed = 0;
  return {
    dependencies: {
      select: async () => items,
      resolve: async (c: SourcePlaybackCandidate) => ({
        streamUrl: "https://fixture.test/" + c.itemId,
        title: c.title,
      }),
      probe: async () => ({
        outcome: outcomes[calls++] ?? "failed",
        reason: null,
        elapsedMs: 100,
        engine: "html5",
        audioOnly: false,
      }),
      drain: async () => {
        closed++;
      },
    },
    get calls() {
      return calls;
    },
    get closed() {
      return closed;
    },
  };
}
test("tries up to three distinct samples, stops on first success and drains between attempts", async () => {
  for (const [outcomes, count, result] of [
    [["played"], 1, "verified"],
    [["failed", "played"], 2, "mixed"],
    [["failed", "failed", "failed"], 3, "failed"],
  ] as const) {
    const h = setup([...outcomes]);
    const check = await runSourceSampleCheck(
      key,
      "manual",
      new AbortController().signal,
      h.dependencies,
    );
    assert.equal(h.calls, count);
    assert.equal(check.observation?.result, result);
    assert.equal(h.closed, count);
  }
});
test("fewer candidates, empty catalogues and inconclusive attempts are honest", async () => {
  const h = setup(["failed", "failed"], candidates.slice(0, 2));
  assert.equal(
    (
      await runSourceSampleCheck(
        key,
        "manual",
        new AbortController().signal,
        h.dependencies,
      )
    ).observation?.samples.length,
    2,
  );
  const empty = await runSourceSampleCheck(
    key,
    "manual",
    new AbortController().signal,
    setup([], []).dependencies,
  );
  assert.equal(empty.observation, undefined);
  assert.equal(empty.attempt.reason, "no-samples");
  const unknown = await runSourceSampleCheck(
    key,
    "manual",
    new AbortController().signal,
    setup(["inconclusive", "failed", "failed"]).dependencies,
  );
  assert.equal(unknown.observation, undefined);
});
test("cancellation saves partial evidence without reporting a failed category", async () => {
  const abort = new AbortController();
  const h = setup(["failed", "played"]);
  h.dependencies.probe = async () => {
    abort.abort();
    return {
      outcome: "cancelled",
      reason: null,
      elapsedMs: 100,
      engine: "html5",
      audioOnly: false,
    };
  };
  const result = await runSourceSampleCheck(
    key,
    "manual",
    abort.signal,
    h.dependencies,
  );
  assert.equal(result.observation, undefined);
  assert.equal(result.attempt.reason, "cancelled");
  assert.equal(result.attempt.samples.length, 1);
});
test("a throttled provider stops sampling and retains its Retry-After delay", async () => {
  const h = setup(["failed"]);
  let requests = 0;
  h.dependencies.resolve = async () => {
    requests++;
    throw Object.assign(Error("limited"), {
      status: 429,
      retryAfterMs: 7200000,
    });
  };
  const result = await runSourceSampleCheck(
    key,
    "background",
    new AbortController().signal,
    h.dependencies,
  );
  assert.equal(requests, 1);
  assert.equal(result.observation, undefined);
  assert.ok(
    (result.nextEligibleAt ?? 0) >= result.attempt.completedAt + 7199900,
  );
});

test("persists a media preparation Retry-After without adding transport fields to sample evidence", async () => {
  const h = setup([]);
  const result = await runSourceSampleCheck(
    key,
    "manual",
    new AbortController().signal,
    {
      ...h.dependencies,
      probe: async () => ({
        outcome: "inconclusive",
        reason: "provider-throttled",
        elapsedMs: 1,
        engine: "html5",
        audioOnly: false,
        retryAfterMs: 86400000,
      }),
    },
  );
  assert.ok(
    (result.nextEligibleAt ?? 0) >= result.attempt.completedAt + 86399900,
  );
  assert.equal("retryAfterMs" in result.attempt.samples[0], false);
});
