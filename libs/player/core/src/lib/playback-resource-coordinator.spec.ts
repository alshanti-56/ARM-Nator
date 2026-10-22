import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackResourceCoordinator } from "./playback-resource-coordinator";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
test("occupied sessions and pending foreground opens block background synchronously", async () => {
  const c = new PlaybackResourceCoordinator();
  c.setOccupied(true);
  assert.equal(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
    null,
  );
  c.setOccupied(false);
  const open = c.beginForeground();
  assert.equal(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
    null,
  );
  const reservation = await open;
  reservation.finish();
  assert.ok(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
  );
});
test("preemption aborts immediately and awaits confirmed connection cleanup", async () => {
  const c = new PlaybackResourceCoordinator();
  const close = deferred();
  const lease = c.tryAcquireBackground(() => close.promise)!;
  let opened = false;
  const open = c.beginForeground().then((r) => {
    opened = true;
    return r;
  });
  assert.equal(lease.signal.aborted, true);
  await Promise.resolve();
  assert.equal(opened, false);
  close.resolve();
  const r = await open;
  assert.equal(opened, true);
  assert.equal(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
    null,
  );
  r.finish();
  assert.ok(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
  );
});
test("cleanup timeout keeps background blocked until late cleanup really finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const c = new PlaybackResourceCoordinator();
  const close = deferred();
  c.tryAcquireBackground(() => close.promise);
  const opening = c.beginForeground();
  const rejected = assert.rejects(opening, /cleanup/i);
  t.mock.timers.tick(2000);
  await rejected;
  assert.equal(c.isBlocked(), true);
  assert.equal(
    c.tryAcquireBackground(async () => {
      /* Test double intentionally has no side effects. */
    }),
    null,
  );
  close.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(c.isBlocked(), false);
});
test("failed cleanup is retryable and cannot discard a later foreground reservation", async () => {
  const c = new PlaybackResourceCoordinator();
  let calls = 0;
  c.tryAcquireBackground(async () => {
    if (++calls === 1) throw Error("release failed");
  });
  await assert.rejects(c.beginForeground(), /release failed/);
  assert.equal(c.isBlocked(), true);
  const [a, b] = await Promise.all([c.beginForeground(), c.beginForeground()]);
  a.finish();
  assert.equal(c.isBlocked(), true);
  b.finish();
  assert.equal(c.isBlocked(), false);
});
