import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackTeardownRegistry } from "./playback-teardown-registry";

test("playback preparation waits for active teardown acknowledgements", async () => {
  const teardown = new PlaybackTeardownRegistry();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let disposed = false;
  teardown.register(async () => {
    await blocked;
    disposed = true;
  });

  const prepared = teardown.prepareForPlayback();
  await Promise.resolve();
  assert.equal(disposed, false);
  release();

  const token = await prepared;
  assert.equal(typeof token, "number");
  assert.equal(disposed, true);
});

test("rapid preparations invalidate stale transition tokens", async () => {
  const teardown = new PlaybackTeardownRegistry();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  teardown.register(() => blocked);

  const requestA = teardown.prepareForPlayback();
  const requestB = teardown.prepareForPlayback();
  const requestC = teardown.prepareForPlayback();
  release();

  const [tokenA, tokenB, tokenC] = await Promise.all([
    requestA,
    requestB,
    requestC,
  ]);
  assert.equal(tokenA, null);
  assert.equal(tokenB, null);
  assert.equal(typeof tokenC, "number");
  assert.equal(teardown.isCurrent(tokenC!), true);
});

test("a rejected teardown blocks preparation and remains retryable", async () => {
  const teardown = new PlaybackTeardownRegistry();
  let attempts = 0;
  const unregister = teardown.register(() => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("release failed");
    }
  });

  await assert.rejects(teardown.prepareForPlayback(), /release failed/);
  assert.equal(attempts, 1);

  const token = await teardown.prepareForPlayback();
  assert.equal(typeof token, "number");
  assert.equal(attempts, 2);
  unregister();
});

test("teardown drains resources registered while another release is pending", async () => {
  const teardown = new PlaybackTeardownRegistry();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const released: string[] = [];
  teardown.register(async () => {
    await blocked;
    released.push("first");
    teardown.register(() => released.push("second"));
  });

  const prepared = teardown.prepareForPlayback();
  release();
  await prepared;

  assert.deepEqual(released, ["first", "second"]);
});

test("repeatable player cleanup remains registered for the next transition", async () => {
  const teardown = new PlaybackTeardownRegistry();
  let stops = 0;
  const unregister = teardown.register(() => {
    stops += 1;
  }, { repeatable: true });

  await teardown.prepareForPlayback();
  await teardown.prepareForPlayback();

  assert.equal(stops, 2);
  unregister();
});
