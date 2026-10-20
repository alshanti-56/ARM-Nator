import assert from "node:assert/strict";
import test from "node:test";
import { waitForRecoveryRetry } from "./recovery-retry-delay";
test("delayed retry observes the entire Retry-After and stops its countdown", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const controller = new AbortController();
  const counts: number[] = [];
  let done = false;
  const waiting = waitForRecoveryRetry(5000, controller.signal, (count) =>
    counts.push(count),
  ).then(() => {
    done = true;
  });
  context.mock.timers.tick(4999);
  await Promise.resolve();
  assert.equal(done, false);
  context.mock.timers.tick(1);
  await waiting;
  assert.equal(done, true);
  assert.equal(counts.at(-1), 0);
});
test("cancelling delayed retry prevents any later countdown or retry", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const controller = new AbortController();
  const counts: number[] = [];
  const waiting = waitForRecoveryRetry(60000, controller.signal, (count) =>
    counts.push(count),
  );
  controller.abort();
  await assert.rejects(waiting);
  const size = counts.length;
  context.mock.timers.tick(60000);
  assert.equal(counts.length, size);
});
