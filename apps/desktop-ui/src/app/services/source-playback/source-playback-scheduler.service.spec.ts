import assert from "node:assert/strict";
import test from "node:test";
import { SourceCheckQueue } from "./source-check-queue";
const a = { sourceId: "a", revision: "r", category: "live" as const },
  b = { ...a, sourceId: "b" };
test("manual clicks coalesce, wait for provider cooldown and refresh/delete/import cancel work", () => {
  const q = new SourceCheckQueue();
  q.request(a);
  q.request(a);
  assert.equal(q.size, 1);
  assert.equal(q.take(new Set(), new Map([["a", 100]]), 99), null);
  q.beginOperation("a");
  assert.equal(q.size, 0);
  q.request(a);
  assert.equal(q.take(q.busy, new Map(), 100), null);
  q.endOperation("a");
  assert.deepEqual(q.take(q.busy, new Map(), 100), a);
  q.request(a);
  q.request(b);
  q.retain([b]);
  assert.deepEqual(q.take(q.busy, new Map(), 100), b);
  assert.equal(q.size, 0);
});
