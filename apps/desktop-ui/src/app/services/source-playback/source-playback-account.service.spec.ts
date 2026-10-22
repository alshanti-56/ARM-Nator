import "@angular/compiler";
import "@arm-nator/providers/shared/util/testing";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { of } from "rxjs";
import {
  PlaylistsService,
  SourcePlaybackRepositoryService,
} from "@arm-nator/services";
import { XtreamApiService } from "@arm-nator/providers/xtream/data-access";
import { SourcePlaybackAccountService } from "./source-playback-account.service";
import assert from "node:assert/strict";
import test from "node:test";
import {
  mapXtreamSourceAccount,
  sourceAccountAtCapacity,
} from "./source-playback-account.service";
test("account facts convert seconds, retain nullable missing fields and distinguish explicit unlimited expiry", () => {
  const value = mapXtreamSourceAccount(
    {
      user_info: {
        exp_date: "1800000000",
        active_cons: "0",
        max_connections: "2",
      },
    },
    100,
  );
  assert.deepEqual(value, {
    checkedAt: 100,
    expiresAt: 1800000000000,
    expiryKind: "date",
    activeConnections: 0,
    maxConnections: 2,
  });
  for (const exp_date of [undefined, null, "0", 0, "bad", "-1"])
    assert.equal(
      mapXtreamSourceAccount({ user_info: { exp_date } }, 100).expiryKind,
      "unknown",
    );
  assert.equal(
    mapXtreamSourceAccount({ user_info: { exp_date: "unlimited" } }, 100)
      .expiryKind,
    "none",
  );
  assert.equal(mapXtreamSourceAccount({}, 100).activeConnections, null);
  assert.equal(
    mapXtreamSourceAccount({ user_info: { active_cons: "1x" } }, 100)
      .activeConnections,
    null,
  );
  assert.equal(sourceAccountAtCapacity(value), false);
  assert.equal(
    sourceAccountAtCapacity({ ...value, activeConnections: 2 }),
    true,
  );
  assert.equal(sourceAccountAtCapacity({ ...value, maxConnections: 0 }), false);
});

test("account deadline cancels its request after five seconds and playable sampling retains its own budget", async (t) => {
  const { runSourceSampleCheck } =
    await import("./source-playback-check-runner");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  let rejectAccount!: (e: Error) => void,
    cancelled = 0,
    probeSignal: AbortSignal | undefined,
    finishProbe!: (v: any) => void;
  const injector = createEnvironmentInjector(
    [
      {
        provide: PlaylistsService,
        useValue: {
          getPlaylistById: () =>
            of({
              _id: "one",
              serverUrl: "https://fixture.test",
              username: "x",
              password: "y",
            }),
        },
      },
      {
        provide: SourcePlaybackRepositoryService,
        useValue: {
          writeAccount: async () => {
            throw Error("timed-out metadata must not be saved");
          },
        },
      },
      {
        provide: XtreamApiService,
        useValue: {
          getAccountInfo: () =>
            new Promise((_, reject) => (rejectAccount = reject)),
          cancelSession: async () => {
            cancelled++;
            rejectAccount(
              Object.assign(Error("cancelled"), { name: "AbortError" }),
            );
            return true;
          },
        },
      },
    ],
    null as never,
  );
  t.after(() => injector.destroy());
  const account = runInInjectionContext(
    injector,
    () => new SourcePlaybackAccountService(),
  );
  const pending = runSourceSampleCheck(
    { sourceId: "one", revision: "r", category: "movies" },
    "background",
    new AbortController().signal,
    {
      prepare: async (s) => {
        assert.equal(await account.read("one", "r", s), null);
        return null;
      },
      select: async () => [
        { itemId: "1", title: "Movie", category: "movies", categoryId: "1" },
      ],
      resolve: async () => ({
        streamUrl: "https://fixture.test/movie",
        title: "Movie",
      }),
      probe: async (_p, s) => {
        probeSignal = s;
        return new Promise((r) => (finishProbe = r));
      },
      drain: async () => {
        /* Test double intentionally has no side effects. */
      },
    },
  );
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.ok(rejectAccount);
  t.mock.timers.tick(5000);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(cancelled, 1);
  assert.ok(probeSignal);
  t.mock.timers.tick(19999);
  assert.equal(probeSignal!.aborted, false);
  finishProbe({
    outcome: "played",
    reason: null,
    elapsedMs: 19999,
    engine: "html5",
    audioOnly: false,
  });
  assert.equal((await pending).observation?.result, "verified");
});

test("reported full capacity defers before any media discovery", async () => {
  const { runSourceSampleCheck } =
    await import("./source-playback-check-runner");
  let calls = 0;
  const result = await runSourceSampleCheck(
    { sourceId: "one", revision: "r", category: "live" },
    "background",
    new AbortController().signal,
    {
      prepare: async () => "provider-busy",
      select: async () => {
        calls++;
        return [];
      },
      resolve: async () => {
        throw Error("unexpected");
      },
      probe: async () => {
        throw Error("unexpected");
      },
      drain: async () => {
        /* Test double intentionally has no side effects. */
      },
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.attempt.reason, "provider-busy");
  assert.equal(result.observation, undefined);
});
test("Stalker account facts never invent provider connection counts", async () => {
  const { mapStalkerSourceAccount } =
    await import("./source-playback-account.service");
  assert.deepEqual(mapStalkerSourceAccount({ expireDate: 1800000000 }, 100), {
    checkedAt: 100,
    expiresAt: 1800000000000,
    expiryKind: "date",
    activeConnections: null,
    maxConnections: null,
  });
  assert.equal(mapStalkerSourceAccount({}, 100).expiryKind, "unknown");
});
