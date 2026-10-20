import assert from "node:assert/strict";
import test from "node:test";
import { InitialResumeCoordinator } from "./initial-resume-coordinator";
import type { ViewingResume } from "./viewing-continuity";
const sample = (positionSeconds = 0, extra = {}) => ({
  positionSeconds,
  durationSeconds: 1200,
  status: "playing",
  ...extra,
});
const resume: ViewingResume = {
  positionSeconds: 600,
  durationSeconds: 1200,
  confirmedAt: 100,
  finished: false,
  action: "progress",
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("initial shared resume waits for actual duration and confirmed seek before saving progress", async () => {
  const targets: number[] = [],
    durations: number[] = [];
  const coordinator = new InitialResumeCoordinator<string>({
    resolve: async (_, duration) => {
      durations.push(duration);
      return resume;
    },
    seek: (target) => {
      targets.push(target);
      return true;
    },
  });
  const token = coordinator.begin("one");
  assert.equal(
    coordinator.accept(token, sample(0, { durationSeconds: null })),
    false,
  );
  assert.equal(coordinator.accept(token, sample()), false);
  await turn();
  assert.deepEqual(durations, [1200]);
  assert.deepEqual(targets, [600]);
  assert.equal(coordinator.accept(token, sample()), false);
  assert.equal(
    coordinator.accept(token, sample(900, { seeking: true })),
    false,
  );
  assert.equal(coordinator.accept(token, sample(600)), true);
});

test("stale lookup responses cannot seek a replacement session; Start over bypasses shared resume", async () => {
  let finish!: (value: ViewingResume) => void;
  let seeks = 0,
    requests = 0;
  const coordinator = new InitialResumeCoordinator<string>({
    resolve: () => {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    seek: () => {
      seeks++;
      return true;
    },
  });
  const old = coordinator.begin("one");
  coordinator.accept(old, sample());
  await turn();
  const next = coordinator.begin("two", "start-over");
  finish(resume);
  await turn();
  assert.equal(seeks, 0);
  assert.equal(requests, 1);
  assert.equal(coordinator.accept(old, sample()), false);
  assert.equal(coordinator.accept(next, sample()), true);
});

test("finished, rejected and hung lookups retain a usable current version", async () => {
  for (const result of [
    async () => ({ ...resume, finished: true }),
    async () => {
      throw new Error("database unavailable");
    },
    () => new Promise<ViewingResume>(() => undefined),
  ]) {
    let now = 0,
      seeks = 0;
    const coordinator = new InitialResumeCoordinator<string>({
      now: () => now,
      resolve: result,
      seek: () => {
        seeks++;
        return true;
      },
    });
    const token = coordinator.begin("one");
    coordinator.accept(token, sample());
    await turn();
    now = 10001;
    assert.equal(coordinator.accept(token, sample(20)), true);
    assert.equal(seeks, 0);
  }
});

test("a throwing seek releases the resume gate immediately and remains observable", async () => {
  const errors: unknown[] = [];
  const coordinator = new InitialResumeCoordinator<string>({
    resolve: async () => resume,
    seek: () => {
      throw new Error("seek failed");
    },
    onError: (error) => errors.push(error),
  });
  const token = coordinator.begin("one");
  coordinator.accept(token, sample());
  await turn();
  assert.equal(coordinator.accept(token, sample(10)), true);
  assert.equal(errors.length, 1);
});
