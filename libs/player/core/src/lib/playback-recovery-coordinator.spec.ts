import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackRecoveryCoordinator } from "./playback-recovery-coordinator";

const source = {
  streamUrl: "https://media.example/live",
  title: "Live",
  isLive: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("renewal requires confirmed playback and explicit media rejection", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    false,
  );
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    true,
  );
  for (const status of [0, 502, null])
    assert.equal(
      coordinator.canRenew({ status, resourceKind: "segment" }),
      false,
    );
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "license" }),
    false,
  );
});

test("concurrent rejection shares one resolution and budget survives replacement", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  const pending = deferred<typeof source>();
  let calls = 0;
  let commits = 0;
  const resolve = async () => {
    calls++;
    return pending.promise;
  };
  const attempts = Array.from({ length: 10 }, () =>
    coordinator.run(
      resolve,
      async () => {
        commits++;
      },
      true,
    ),
  );
  pending.resolve(source);
  await Promise.all(attempts);
  assert.equal(calls, 1);
  assert.equal(commits, 1);
  assert.equal(
    coordinator.canRenew({ status: 401, resourceKind: "playlist" }),
    false,
  );
  for (let second = 2; second <= 17; second++)
    coordinator.observe(second + 1, "playing", false, second * 1000);
  assert.equal(
    coordinator.canRenew({ status: 401, resourceKind: "playlist" }),
    true,
  );
});

test("selection change aborts and discards an uncancellable provider reply", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  const pending = deferred<typeof source>();
  let signal!: AbortSignal;
  let commits = 0;
  const work = coordinator.run(
    async (request) => {
      signal = request.signal;
      return pending.promise;
    },
    async () => {
      commits++;
    },
    false,
  );
  await Promise.resolve();
  coordinator.beginSelection();
  pending.resolve(source);
  assert.equal(await work, false);
  assert.equal(signal.aborted, true);
  assert.equal(commits, 0);
});

test("resolution timeout releases lock without committing a late source", async () => {
  const coordinator = new PlaybackRecoveryCoordinator(5);
  coordinator.beginSelection();
  const pending = deferred<typeof source>();
  let commits = 0;
  assert.equal(
    await coordinator.run(
      () => pending.promise,
      async () => {
        commits++;
      },
      false,
    ),
    false,
  );
  pending.resolve(source);
  await Promise.resolve();
  assert.equal(commits, 0);
  assert.equal(coordinator.busy, false);
});

test("pause and stalled clock cannot replenish the automatic renewal budget", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  await coordinator.run(
    async () => source,
    async () => undefined,
    true,
  );
  coordinator.observe(2, "paused", false, 2000);
  coordinator.observe(2, "playing", false, 40000);
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    false,
  );
});

test("a synchronously throwing provider cannot leave recovery locked", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  assert.equal(
    await coordinator.run(
      () => {
        throw new Error("Provider failed");
      },
      async () => undefined,
      false,
    ),
    false,
  );
  assert.equal(coordinator.busy, false);
});

test("a long gap between clock samples does not count as stable playback", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  await coordinator.run(
    async () => source,
    async () => undefined,
    true,
  );
  coordinator.observe(3, "playing", false, 2000);
  coordinator.observe(4, "playing", false, 100000);
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    false,
  );
});

test("old buffered playback during resolution cannot replenish the renewal budget", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  const pending = deferred<typeof source>();
  const work = coordinator.run(
    () => pending.promise,
    async () => undefined,
    true,
  );
  for (let second = 2; second <= 25; second++)
    coordinator.observe(second + 1, "playing", false, second * 1000);
  pending.resolve(source);
  await work;
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    false,
  );
});

test("failed renewal remains terminal until a manual attempt", async () => {
  const coordinator = new PlaybackRecoveryCoordinator();
  coordinator.beginSelection();
  coordinator.observe(1, "playing", false, 0);
  coordinator.observe(2, "playing", false, 1000);
  await coordinator.run(
    async () => {
      throw new Error("Denied");
    },
    async () => undefined,
    true,
  );
  for (let second = 2; second <= 25; second++)
    coordinator.observe(second + 1, "playing", false, second * 1000);
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    false,
  );
  coordinator.beginAttempt();
  assert.equal(
    coordinator.canRenew({ status: 403, resourceKind: "segment" }),
    true,
  );
});
