import { NativeCompositionService } from './native-composition.service';
/* eslint-disable max-lines -- backend lifecycle coverage shares one harness. */
import "@angular/compiler";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DestroyRef,
  Injector,
  effect,
  signal,
  ɵChangeDetectionScheduler,
  ɵEffectScheduler,
} from "@angular/core";
import type {
  EmbeddedMpvBackend,
  EmbeddedMpvSession,
  EmbeddedMpvSupport,
  KsPlayerMetalSupport,
} from "@arm-nator/shared/interfaces";
import {
  EmbeddedMpvSessionController,
  readSessionActiveUntracked,
} from "./embedded-mpv-session-controller";

class TestEffectScheduler {
  private readonly queue = new Set<{
    dirty: boolean;
    run: () => void;
  }>();

  add(handle: { dirty: boolean; run: () => void }): void {
    this.queue.add(handle);
  }

  schedule(handle: { dirty: boolean; run: () => void }): void {
    if (handle.dirty) {
      this.queue.add(handle);
    }
  }

  remove(handle: { dirty: boolean; run: () => void }): void {
    this.queue.delete(handle);
  }

  flush(limit: number): number {
    let runs = 0;
    while (this.queue.size > 0 && runs < limit) {
      const handle = this.queue.values().next().value as {
        dirty: boolean;
        run: () => void;
      };
      this.queue.delete(handle);
      handle.run();
      runs += 1;
    }
    return runs;
  }

  get queued(): number {
    return this.queue.size;
  }
}

test("session activity is not a reactive startup dependency", () => {
  const scheduler = new TestEffectScheduler();
  const injector = Injector.create({
    providers: [
      {
        provide: DestroyRef,
        useValue: { onDestroy: () => undefined },
      },
      { provide: ɵEffectScheduler, useValue: scheduler },
      {
        provide: ɵChangeDetectionScheduler,
        useValue: { notify: () => undefined },
      },
    ],
  });
  const active = signal(false);
  let runs = 0;

  const ref = effect(
    (onCleanup) => {
      readSessionActiveUntracked(active);
      runs += 1;
      onCleanup(() => active.set(false));
      active.set(true);
    },
    { injector },
  );

  assert.equal(scheduler.flush(10), 1);
  assert.equal(runs, 1);
  assert.equal(scheduler.queued, 0);
  ref.destroy();
});

const playback = {
  streamUrl: "https://example.invalid/strict",
  title: "Strict fixture",
  isLive: false,
};

const host = {
  getBoundingClientRect: () => ({
    left: 10,
    top: 20,
    width: 640,
    height: 360,
  }),
} as unknown as HTMLElement;

const embeddedSupport: EmbeddedMpvSupport = {
  supported: true,
  platform: "darwin",
  capabilities: {
    subtitles: true,
    playbackSpeed: true,
    aspectOverride: true,
    pictureAdjustments: true,
  },
};

function makeSession(
  id: string,
  backend: EmbeddedMpvBackend,
): EmbeddedMpvSession {
  const now = new Date(0).toISOString();
  return {
    id,
    backend,
    title: "Strict fixture",
    streamUrl: playback.streamUrl,
    status: "playing",
    positionSeconds: 0,
    durationSeconds: 120,
    volume: 0.5,
    audioTracks: [],
    selectedAudioTrackId: null,
    subtitleTracks: [],
    selectedSubtitleTrackId: null,
    playbackSpeed: 1,
    aspectOverride: "no",
    picture: {
      brightness: 0,
      contrast: 0,
      blackLevel: 0,
      saturation: 0,
      gamma: 0,
    },
    startedAt: now,
    updatedAt: now,
  };
}

type HarnessOverrides = (events: string[]) => Record<string, unknown>;

function createHarness(overrides: HarnessOverrides = () => ({})): {
  controller: EmbeddedMpvSessionController;
  injector: Injector;
  events: string[];
  destroy: () => void;
} {
  const events: string[] = [];
  const bridge = {
    platform: "darwin",
    onEmbeddedMpvSessionUpdate: () => () => undefined,
    onKsPlayerMetalSessionUpdate: () => () => undefined,
    getKsPlayerMetalSupport: async (): Promise<KsPlayerMetalSupport> => ({
      supported: true,
    }),
    prepareKsPlayerMetal: async (): Promise<KsPlayerMetalSupport> => ({
      supported: true,
    }),
    getKsPlayerMetalSupportedControls: async () => ({
      pause: true,
      seek: true,
      volume: true,
    }),
    createKsPlayerMetalSession: async () => {
      events.push("create-ks");
      return makeSession("ks-strict", "ksplayer-metal");
    },
    loadKsPlayerMetalPlayback: async () => {
      events.push("load-ks");
    },
    disposeKsPlayerMetalSession: async (sessionId: string) => {
      events.push("dispose-ks");
      return {
        ...makeSession(sessionId, "ksplayer-metal"),
        status: "closed",
      };
    },
    disposeAllKsPlayerMetal: async () => {
      events.push("dispose-all-ks");
    },
    setKsPlayerMetalBounds: async () => undefined,
    getEmbeddedMpvSupport: async () => embeddedSupport,
    prepareEmbeddedMpv: async () => embeddedSupport,
    createEmbeddedMpvSession: async () => {
      events.push("create-embedded");
      return makeSession("embedded-direct", "embedded-mpv");
    },
    loadEmbeddedMpvPlayback: async () => {
      events.push("load-embedded");
    },
    disposeEmbeddedMpvSession: async (sessionId: string) => {
      events.push("dispose-embedded");
      return {
        ...makeSession(sessionId, "embedded-mpv"),
        status: "closed",
      };
    },
    setEmbeddedMpvBounds: async () => undefined,
    ...overrides(events),
  } as unknown as Window["electron"];

  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousResizeObserver = (globalThis as { ResizeObserver?: unknown })
    .ResizeObserver;
  const previousRequestAnimationFrame = (
    globalThis as { requestAnimationFrame?: unknown }
  ).requestAnimationFrame;
  const previousCancelAnimationFrame = (
    globalThis as { cancelAnimationFrame?: unknown }
  ).cancelAnimationFrame;

  (globalThis as { window?: unknown }).window = {
    electron: bridge,
    devicePixelRatio: 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => undefined,
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {
      return undefined;
    }
    disconnect(): void {
      return undefined;
    }
  };
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
    callback: (time: number) => void,
  ) => {
    callback(0);
    return 0;
  };
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame =
    () => undefined;

  const scheduler = new TestEffectScheduler();
  const injector = Injector.create({
    providers: [
      {
        provide: DestroyRef,
        useValue: { onDestroy: () => undefined },
      },
      { provide: ɵEffectScheduler, useValue: scheduler },
      {
        provide: ɵChangeDetectionScheduler,
        useValue: { notify: () => undefined },
      },
      {provide:NativeCompositionService,useValue:{enabled:false,clearAperture:()=>undefined}},
      EmbeddedMpvSessionController,
    ],
  });

  return {
    controller: injector.get(EmbeddedMpvSessionController),
    injector,
    events,
    destroy: () => {
      injector.destroy();
      if (previousWindow === undefined) {
        delete (globalThis as { window?: unknown }).window;
      } else {
        (globalThis as { window?: unknown }).window = previousWindow;
      }
      if (previousResizeObserver === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
          previousResizeObserver;
      }
      if (previousRequestAnimationFrame === undefined) {
        delete (globalThis as { requestAnimationFrame?: unknown })
          .requestAnimationFrame;
      } else {
        (
          globalThis as { requestAnimationFrame?: unknown }
        ).requestAnimationFrame = previousRequestAnimationFrame;
      }
      if (previousCancelAnimationFrame === undefined) {
        delete (globalThis as { cancelAnimationFrame?: unknown })
          .cancelAnimationFrame;
      } else {
        (
          globalThis as { cancelAnimationFrame?: unknown }
        ).cancelAnimationFrame = previousCancelAnimationFrame;
      }
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the session lifecycle event.");
}

function assertStrictMetalTerminalState(
  controller: EmbeddedMpvSessionController,
  reason: string,
): void {
  const support = controller.support();
  const session = controller.session();
  assert.equal(controller.activeBackend(), "ksplayer-metal");
  assert.equal(controller.sessionId(), null);
  assert.equal(support?.backend, "ksplayer-metal");
  assert.equal(support?.supported, false);
  assert.equal(support?.reason, reason);
  assert.deepEqual(support?.capabilities, {
    subtitles: false,
    playbackSpeed: false,
    aspectOverride: false,
    pictureAdjustments: false,
  });
  assert.equal(controller.supportedControls(), null);
  assert.equal(session?.backend, "ksplayer-metal");
  assert.equal(session?.status, "error");
  assert.equal(session?.error, reason);
}

function assertNoEmbeddedCalls(events: string[]): void {
  assert.equal(
    events.some((event) => event.includes("embedded")),
    false,
  );
}

test("KSPlayer applies a paused VOD start position once metadata is ready", async () => {
  let update!: (session: EmbeddedMpvSession) => void;
  const seeks: number[] = [];
  const harness = createHarness(() => ({
    onKsPlayerMetalSessionUpdate: (listener: typeof update) => { update = listener; return () => undefined; },
    seekKsPlayerMetal: async (_id: string, seconds: number) => {
      seeks.push(seconds);
      return { ...makeSession('ks-strict', 'ksplayer-metal'), status: 'paused', positionSeconds: seconds };
    },
  }));
  try {
    harness.controller.startSession(host, { ...playback, startTime: 37, startPaused: true }, 0.5, 'ksplayer-metal');
    await waitFor(() => harness.events.includes('load-ks'));
    await new Promise<void>(resolve => setImmediate(resolve));
    update({ ...makeSession('ks-strict', 'ksplayer-metal'), status: 'loading', durationSeconds: null });
    assert.deepEqual(seeks, [], 'wait for seekable metadata');
    const ready = { ...makeSession('ks-strict', 'ksplayer-metal'), status: 'paused' as const };
    update(ready);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(seeks, [37]);
    update(ready);
    assert.deepEqual(seeks, [37], 'subsequent snapshots cannot replay the initial seek');
  } finally {
    harness.destroy();
  }
});

test("KSPlayer retains resume when paused metadata arrives before load acknowledgement", async () => {
  let update!: (session: EmbeddedMpvSession) => void;
  const seeks: number[] = [];
  const harness = createHarness(() => ({
    onKsPlayerMetalSessionUpdate: (listener: typeof update) => { update = listener; return () => undefined; },
    loadKsPlayerMetalPlayback: async () => {
      update({ ...makeSession('ks-strict', 'ksplayer-metal'), status: 'paused' });
    },
    seekKsPlayerMetal: async (_id: string, seconds: number) => {
      seeks.push(seconds);
      return { ...makeSession('ks-strict', 'ksplayer-metal'), status: 'paused', positionSeconds: seconds };
    },
  }));
  try {
    harness.controller.startSession(host, { ...playback, startTime: 37, startPaused: true }, 0.5, 'ksplayer-metal');
    await waitFor(() => harness.events.includes('create-ks'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(seeks, [37]);
  } finally {
    harness.destroy();
  }
});

test("unsupported KS probe is terminal and never enters embedded MPV", async () => {
  let prepareCalled = false;
  const harness = createHarness((events) => ({
    getKsPlayerMetalSupport: async () => ({
      supported: false,
      reason: "KS probe unsupported",
    }),
    prepareKsPlayerMetal: async () => {
      prepareCalled = true;
      return { supported: true };
    },
    disposeAllKsPlayerMetal: async () => {
      events.push("dispose-all-ks");
    },
  }));

  try {
    harness.controller.startSession(
      host,
      playback,
      0.5,
      "ksplayer-metal",
    );
    await waitFor(() => harness.controller.session()?.status === "error");

    assert.equal(prepareCalled, false);
    assert.deepEqual(harness.events, ["dispose-all-ks"]);
    assertNoEmbeddedCalls(harness.events);
    assertStrictMetalTerminalState(harness.controller, "KS probe unsupported");
  } finally {
    harness.destroy();
  }
});

test("preserves advertised KSPlayer picture-adjustment controls", async () => {
  const harness = createHarness(() => ({
    getKsPlayerMetalSupportedControls: async () => ({
      pause: true,
      seek: true,
      volume: true,
      pictureAdjustments: true,
    }),
  }));

  try {
    harness.controller.startSession(host, playback, 0.5, "ksplayer-metal");
    await waitFor(() => harness.controller.supportedControls()?.pictureAdjustments === true);
    assert.equal(harness.controller.supportedControls()?.pictureAdjustments, true);
  } finally {
    harness.destroy();
  }
});

test("KS preparation rejection is terminal and cleans native state", async () => {
  const harness = createHarness(() => ({
    prepareKsPlayerMetal: async () => {
      throw new Error("KS preparation failed");
    },
  }));

  try {
    harness.controller.startSession(
      host,
      playback,
      0.5,
      "ksplayer-metal",
    );
    await waitFor(() => harness.controller.session()?.status === "error");

    assert.deepEqual(harness.events, ["dispose-all-ks"]);
    assertNoEmbeddedCalls(harness.events);
    assertStrictMetalTerminalState(harness.controller, "KS preparation failed");
  } finally {
    harness.destroy();
  }
});

test("unsupported KS preparation result is terminal with truthful capabilities", async () => {
  const harness = createHarness(() => ({
    prepareKsPlayerMetal: async () => ({
      supported: false,
      reason: "KS preparation unsupported",
    }),
  }));

  try {
    harness.controller.startSession(
      host,
      playback,
      0.5,
      "ksplayer-metal",
    );
    await waitFor(() => harness.controller.session()?.status === "error");

    assert.deepEqual(harness.events, ["dispose-all-ks"]);
    assertNoEmbeddedCalls(harness.events);
    assertStrictMetalTerminalState(
      harness.controller,
      "KS preparation unsupported",
    );
  } finally {
    harness.destroy();
  }
});

test("KS session creation rejection is terminal with no embedded attempt", async () => {
  const harness = createHarness((events) => ({
    createKsPlayerMetalSession: async () => {
      events.push("create-ks");
      throw new Error("KS session creation failed");
    },
  }));

  try {
    harness.controller.startSession(
      host,
      playback,
      0.5,
      "ksplayer-metal",
    );
    await waitFor(() => harness.controller.session()?.status === "error");

    assert.deepEqual(harness.events, ["create-ks", "dispose-all-ks"]);
    assertNoEmbeddedCalls(harness.events);
    assertStrictMetalTerminalState(
      harness.controller,
      "KS session creation failed",
    );
  } finally {
    harness.destroy();
  }
});

test("KS load failure disposes the session, stays Metal, and does not re-enter", async () => {
  const harness = createHarness((events) => ({
    loadKsPlayerMetalPlayback: async () => {
      events.push("load-ks");
      throw new Error("KS load failed");
    },
  }));

  try {
    harness.controller.startSession(
      host,
      playback,
      0.5,
      "ksplayer-metal",
    );
    await waitFor(() => harness.controller.session()?.status === "error");

    assert.deepEqual(harness.events, [
      "create-ks",
      "load-ks",
      "dispose-ks",
    ]);
    assertNoEmbeddedCalls(harness.events);
    assertStrictMetalTerminalState(harness.controller, "KS load failed");

    const eventsAfterFailure = [...harness.events];
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.events, eventsAfterFailure);
    assert.equal(
      harness.events.filter((event) => event === "create-ks").length,
      1,
    );
  } finally {
    harness.destroy();
  }
});

test("direct EmbeddedMpv requests keep their existing create/load behavior", async () => {
  const harness = createHarness((events) => ({
    prepareEmbeddedMpv: async () => {
      events.push("prepare-embedded");
      return embeddedSupport;
    },
  }));
  let teardown: (() => void) | undefined;

  try {
    teardown = harness.controller.startSession(
      host,
      playback,
      0.5,
      "embedded-mpv",
    );
    await waitFor(() => harness.controller.session()?.status === "playing");

    assert.deepEqual(harness.events, [
      "prepare-embedded",
      "create-embedded",
      "load-embedded",
    ]);
    assert.equal(harness.controller.activeBackend(), "embedded-mpv");
    assert.equal(harness.controller.support()?.backend, "embedded-mpv");
    assert.equal(harness.controller.support()?.supported, true);
    assert.equal(harness.controller.session()?.backend, "embedded-mpv");
    assert.equal(harness.controller.session()?.status, "playing");
  } finally {
    teardown?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(harness.events.at(-1), "dispose-embedded");
    harness.destroy();
  }
});

test("teardown waits for native startup and disposes a session created late", async () => {
  let completeCreate!: (session: EmbeddedMpvSession) => void;
  const creation = new Promise<EmbeddedMpvSession>((resolve) => {
    completeCreate = resolve;
  });
  const harness = createHarness((events) => ({
    createEmbeddedMpvSession: async () => {
      events.push("create-embedded");
      return creation;
    },
  }));

  try {
    harness.controller.startSession(host, playback, 0.5, "embedded-mpv");
    await waitFor(() => harness.events.includes("create-embedded"));

    const teardown = harness.controller.teardownActiveSessionAndWait();
    await Promise.resolve();
    assert.equal(harness.events.includes("dispose-embedded"), false);
    completeCreate(makeSession("embedded-late", "embedded-mpv"));
    await teardown;

    assert.deepEqual(harness.events, [
      "create-embedded",
      "dispose-embedded",
    ]);
    assert.equal(harness.controller.sessionId(), null);
  } finally {
    harness.destroy();
  }
});

test("native teardown retains session ownership when dispose does not acknowledge closure", async () => {
  let disposeAttempts = 0;
  const harness = createHarness((events) => ({
    disposeEmbeddedMpvSession: async () => {
      events.push("dispose-embedded");
      disposeAttempts += 1;
      return disposeAttempts === 1
        ? makeSession("embedded-direct", "embedded-mpv")
        : { ...makeSession("embedded-direct", "embedded-mpv"), status: "closed" };
    },
  }));

  try {
    harness.controller.startSession(host, playback, 0.5, "embedded-mpv");
    await waitFor(() => harness.controller.session()?.status === "playing");

    await assert.rejects(
      harness.controller.teardownActiveSessionAndWait(),
      /did not confirm closure/,
    );
    assert.equal(disposeAttempts, 1);
    await harness.controller.teardownActiveSessionAndWait();
    assert.equal(disposeAttempts, 2);
    assert.equal(harness.events.at(-1), "dispose-embedded");
  } finally {
    harness.destroy();
  }
});
