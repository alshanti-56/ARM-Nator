import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import {
  SourcePlaybackProbeService,
  SOURCE_PROBE_TRANSPORT,
  SOURCE_PROBE_SESSION_FACTORY,
} from "./source-playback-probe.service";
import type { SourceConfirmationInput } from "@arm-nator/shared/interfaces";
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function harness(prepare?: () => Promise<unknown>) {
  let observe!: (s: SourceConfirmationInput) => void;
  const released: string[] = [];
  let closed = 0,
    cancelled = 0;
  const ready = deferred<void>();
  const injector = createEnvironmentInjector(
    [
      {
        provide: SOURCE_PROBE_TRANSPORT,
        useValue: {
          prepareAutoPlayback:
            prepare ??
            (async () => ({
              ok: true,
              session: {
                id: "prepared",
                url: "http://127.0.0.1/sample",
                format: "progressive",
              },
            })),
          releaseAutoPlaybackSession: async (id: string) => {
            released.push(id);
          },
          cancelAutoPlaybackPreparation: async () => {
            cancelled++;
          },
        },
      },
      {
        provide: SOURCE_PROBE_SESSION_FACTORY,
        useValue: () => ({
          start: async (_p: unknown, _s: unknown, callback: typeof observe) => {
            observe = callback;
            ready.resolve();
          },
          close: async () => {
            closed++;
          },
        }),
      },
    ],
    null as never,
  );
  const probe = runInInjectionContext(
    injector,
    () => new SourcePlaybackProbeService(),
  );
  return {
    probe,
    ready,
    released,
    get closed() {
      return closed;
    },
    get cancelled() {
      return cancelled;
    },
    emit: (s: SourceConfirmationInput) => observe(s),
    destroy: () => injector.destroy(),
  };
}
test("requires sustained frame evidence and always releases prepared media after success", async () => {
  const h = harness();
  try {
    const result = h.probe.probe(
      { streamUrl: "https://fixture.test/live", title: "Sample", isLive: true },
      new AbortController().signal,
    );
    await h.ready.promise;
    for (let at = 0; at <= 6000; at += 250)
      h.emit({
        generation: "g",
        atMs: at,
        positionSeconds: at / 1000,
        playing: true,
        stalled: false,
        seeking: false,
        presentedFrames: at / 50,
      });
    assert.equal((await result).outcome, "played");
    await h.probe.drain();
    assert.deepEqual(h.released, ["prepared"]);
    assert.equal(h.closed, 1);
  } finally {
    h.destroy();
  }
});
test("metadata with no frames cannot succeed and cancellation closes the driver", async () => {
  const h = harness();
  const abort = new AbortController();
  try {
    let done = false;
    const result = h.probe
      .probe(
        { streamUrl: "https://fixture.test/live", title: "Sample" },
        abort.signal,
      )
      .then((r) => {
        done = true;
        return r;
      });
    await h.ready.promise;
    for (let at = 0; at <= 7000; at += 250)
      h.emit({
        generation: "g",
        atMs: at,
        positionSeconds: at / 1000,
        playing: true,
        stalled: false,
        seeking: false,
        presentedFrames: 0,
      });
    await Promise.resolve();
    assert.equal(done, false);
    abort.abort();
    assert.equal((await result).outcome, "cancelled");
    assert.deepEqual(h.released, ["prepared"]);
  } finally {
    h.destroy();
  }
});
test("late successful preparation is released once before drain completes", async () => {
  const late = deferred<unknown>();
  const h = harness(() => late.promise);
  const abort = new AbortController();
  try {
    const result = h.probe.probe(
      { streamUrl: "https://fixture.test/live", title: "Sample" },
      abort.signal,
    );
    abort.abort();
    let drained = false;
    const drain = h.probe.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    assert.equal(drained, false);
    late.resolve({
      ok: true,
      session: { id: "late", url: "http://127.0.0.1/late", format: "hls" },
    });
    assert.equal((await result).outcome, "cancelled");
    await drain;
    assert.deepEqual(h.released, ["late"]);
    assert.equal(h.cancelled, 1);
  } finally {
    h.destroy();
  }
});

test("twenty-second deadline is inconclusive and closes the connection", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  try {
    const result = h.probe.probe(
      { streamUrl: "https://fixture.test/live", title: "Sample" },
      new AbortController().signal,
    );
    await h.ready.promise;
    t.mock.timers.tick(20000);
    const outcome = await result;
    assert.equal(outcome.outcome, "inconclusive");
    assert.equal(outcome.reason, "startup-timeout");
    assert.deepEqual(h.released, ["prepared"]);
    assert.equal(h.cancelled, 1);
  } finally {
    h.destroy();
  }
});
