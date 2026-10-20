import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
  signal,
} from "@angular/core";
import { Router } from "@angular/router";
import { PlaybackPositionService } from "@arm-nator/services";
import {
  VideoPlayer,
  type PlayerPreferenceIntent,
  type ResolvedPortalPlayback,
  type BrowserMiniPlayerState,
  type BrowserViewState,
} from "@arm-nator/shared/interfaces";
import {
  createEmptyControlsState,
  DEFAULT_PLAYER_CAPABILITIES,
} from "../player-controls/player-controls-defaults";
import { WorkspacePlayerStateService } from "./workspace-player-state.service";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("collapsing the mini-player preserves playback until explicitly closed", async () => {
  const harness = createHarness(async () => undefined);
  let teardowns = 0;
  try {
    await harness.state.open({ streamUrl: 'http://fixture.test/audio', title: 'Playing' }, VideoPlayer.ArtPlayer);
    harness.state.registerPlaybackTeardown(() => { teardowns++; });
    const playback = harness.state.playback();
    const generation = harness.state.reloadGeneration();
    harness.state.collapseToBar();
    assert.equal(harness.state.miniPlayerCollapsed(), true);
    assert.equal(harness.state.playback(), playback);
    assert.equal(harness.state.reloadGeneration(), generation);
    assert.equal(teardowns, 0);
    harness.state.restoreMiniPlayer();
    assert.equal(harness.state.miniPlayerCollapsed(), false);
    harness.state.collapseToBar();
    harness.state.expand();
    assert.equal(harness.state.miniPlayerCollapsed(), false);
    assert.equal(harness.state.presentation(), 'expanded');
    assert.equal(teardowns, 0);
    harness.state.collapseToBar();
    await harness.state.open({ streamUrl: 'http://fixture.test/next', title: 'Next' }, VideoPlayer.ArtPlayer);
    assert.equal(harness.state.miniPlayerCollapsed(), false);
  } finally {
    harness.destroy();
  }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("The expected playback state transition did not complete.");
}

function miniPlayer(title: string): BrowserMiniPlayerState {
  return {
    mode: "youtube",
    url: `https://video.example/${encodeURIComponent(title)}`,
    title,
    bounds: { x: 0, y: 0, width: 320, height: 180 },
    isMuted: false,
  };
}

function browserState(id: string, title: string): BrowserViewState {
  const mini = miniPlayer(title);
  return {
    id,
    mode: "youtube",
    displayMode: "mini",
    isFullscreen: false,
    url: mini.url,
    title,
    status: "ready",
    canGoBack: false,
    canGoForward: false,
    isMuted: false,
    bounds: mini.bounds,
    miniPlayer: mini,
  };
}

function createHarness(
  closeBrowserView: () => Promise<void>,
  save = async (_playlistId: string, _data: unknown) => undefined,
) {
  let onUpdate: ((state: BrowserViewState) => void) | undefined;
  let currentBrowserView: BrowserViewState | null = null;
  let closeCalls = 0;
  const bridge = {
    onBrowserViewUpdate: (callback: (state: BrowserViewState) => void) => {
      onUpdate = callback;
      return () => {
        onUpdate = undefined;
      };
    },
    closeBrowserView: async () => {
      closeCalls += 1;
      await closeBrowserView();
      currentBrowserView = null;
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { electron: bridge },
  });
  const injector = createEnvironmentInjector([
    WorkspacePlayerStateService,
    {
      provide: PlaybackPositionService,
      useValue: {
        savePlaybackPosition: save,
        savePlaybackPositionOrThrow: save,
        saveViewingProgressOrThrow: (
          playback: { contentInfo: { playlistId: string } },
          progress: unknown,
        ) =>
          save(playback.contentInfo.playlistId, {
            ...playback.contentInfo,
            ...(progress as object),
          }),
      },
    },
    {
      provide: Router,
      useValue: {
        url: "/workspace/dashboard",
        navigateByUrl: async () => true,
      },
    },
  ]);
  const state = runInInjectionContext(injector, () =>
    injector.get(WorkspacePlayerStateService),
  );
  return {
    state,
    emitBrowserView(next: BrowserViewState): void {
      currentBrowserView = next;
      onUpdate?.(next);
    },
    get currentBrowserView() {
      return currentBrowserView;
    },
    get closeCalls() {
      return closeCalls;
    },
    destroy(): void {
      injector.destroy();
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    },
  };
}

test("a superseded YouTube close failure cannot overwrite the newer transition state", async () => {
  const firstCloseStarted = deferred<void>();
  const firstClose = deferred<void>();
  let closeCalls = 0;
  const harness = createHarness(() => {
    closeCalls += 1;
    if (closeCalls === 1) {
      firstCloseStarted.resolve();
      return firstClose.promise;
    }
    return Promise.resolve();
  });
  try {
    harness.state.youtube.set(miniPlayer("old"));
    const older = harness.state.prepareForPlayback();
    await firstCloseStarted.promise;

    const newer = await harness.state.prepareForPlayback();
    assert.equal(typeof newer, "number");
    assert.equal(harness.state.teardownFailure(), null);

    firstClose.reject(new Error("old YouTube view close failed"));
    assert.equal(await older, null);
    assert.equal(harness.state.teardownFailure(), null);
  } finally {
    harness.destroy();
  }
});

test("a stale YouTube mini-player update cannot close the newer browser view", async () => {
  const teardownStarted = deferred<void>();
  const releaseTeardown = deferred<void>();
  const harness = createHarness(() => Promise.resolve());
  const unregister = harness.state.registerPlaybackTeardown(() => {
    teardownStarted.resolve();
    return releaseTeardown.promise;
  });
  try {
    harness.emitBrowserView(browserState("youtube-a", "YouTube A"));
    await teardownStarted.promise;
    harness.emitBrowserView(browserState("youtube-b", "YouTube B"));
    releaseTeardown.resolve();

    await waitUntil(() => harness.state.youtube()?.title === "YouTube B");
    assert.equal(harness.currentBrowserView?.title, "YouTube B");
    assert.equal(harness.closeCalls, 0);
  } finally {
    unregister();
    releaseTeardown.resolve();
    harness.destroy();
  }
});

test("a current YouTube update whose teardown fails still closes its own view", async () => {
  const harness = createHarness(() => Promise.resolve());
  harness.state.registerPlaybackTeardown(() => {
    throw new Error("player teardown failed");
  });
  try {
    harness.emitBrowserView(browserState("youtube-failed", "Failed YouTube"));
    await waitUntil(() => harness.closeCalls === 1);
    assert.equal(harness.currentBrowserView, null);
    assert.match(
      harness.state.teardownFailure() ?? "",
      /player teardown failed/,
    );
  } finally {
    harness.destroy();
  }
});

test("workspace persists only confirmed runtime positions, and rejects a superseded engine generation", async () => {
  const saved: {
    contentXtreamId: number;
    positionSeconds: number;
    durationSeconds: number;
  }[] = [];
  const events: unknown[] = [];
  const harness = createHarness(
    async () => undefined,
    async (_, data) => {
      saved.push(data as (typeof saved)[number]);
    },
  );
  const playback = (id: number) => ({
    streamUrl: `http://fixture.test/${id}`,
    title: "Fixture",
    contentInfo: {
      playlistId: "one",
      contentType: "vod" as const,
      contentXtreamId: id,
    },
  });
  const snapshot = (
    positionSeconds: number,
    status: "playing" | "paused" | "ended" = "playing",
    seeking = false,
  ) => ({
    state: {
      ...createEmptyControlsState(),
      positionSeconds,
      durationSeconds: 1000.1,
      status,
      seeking,
    },
    capabilities: DEFAULT_PLAYER_CAPABILITIES,
  });
  try {
    await harness.state.open(playback(1), VideoPlayer.Html5, {
      onTimeUpdate: (event) => events.push(event),
    });
    const oldGeneration = harness.state.reloadGeneration();
    harness.state.onTimeUpdate({ currentTime: 999, duration: 4 });
    harness.state.onRuntimeSnapshot(snapshot(94.9));
    await harness.state.flushPlaybackProgress();
    harness.state.onRuntimeSnapshot(snapshot(999, "playing", true));
    await harness.state.flushPlaybackProgress();
    assert.deepEqual(
      saved.map((value) => value.positionSeconds),
      [94.9],
    );
    assert.equal(saved[0].durationSeconds, 1000.1);
    assert.equal(
      (events[0] as { persistenceHandled: boolean }).persistenceHandled,
      true,
    );
    await harness.state.open(playback(2), VideoPlayer.Html5);
    harness.state.onRuntimeSnapshot(snapshot(990), oldGeneration);
    harness.state.onRuntimeSnapshot(snapshot(20, "paused"));
    await harness.state.flushPlaybackProgress();
    assert.deepEqual(
      saved.map((value) => [value.contentXtreamId, value.positionSeconds]),
      [
        [1, 94.9],
        [2, 20],
      ],
    );
  } finally {
    harness.destroy();
  }
});

test("progress storage failure remains observable while player cleanup succeeds", async () => {
  const harness = createHarness(
    async () => undefined,
    async () => {
      throw new Error("fixture disk full");
    },
  );
  let released = 0;
  harness.state.registerPlaybackTeardown(
    () => {
      released++;
    },
    { repeatable: true },
  );
  try {
    await harness.state.open(
      {
        streamUrl: "http://fixture.test/movie",
        title: "Fixture",
        contentInfo: {
          playlistId: "one",
          contentType: "vod",
          contentXtreamId: 1,
        },
      },
      VideoPlayer.Html5,
    );
    harness.state.onRuntimeSnapshot({
      state: {
        ...createEmptyControlsState(),
        status: "paused",
        positionSeconds: 20,
        durationSeconds: 100,
      },
      capabilities: DEFAULT_PLAYER_CAPABILITIES,
    });
    await harness.state.flushPlaybackProgress();
    assert.match(harness.state.persistenceFailure() ?? "", /fixture disk full/);
    await harness.state.close();
    assert.equal(harness.state.playback(), null);
    assert.ok(released >= 2);
  } finally {
    harness.destroy();
  }
});

test("workspace restores compatible shared progress before publishing a replacement version clock", async () => {
  const saved: number[] = [],
    seeks: number[] = [];
  const harness = createHarness(
    async () => undefined,
    async (_, value) => {
      saved.push((value as { positionSeconds: number }).positionSeconds);
    },
  );
  const bridge = window.electron;
  bridge.dbReconcileViewingItem = async () => ({
    identityKey: "fixture",
    workId: "matrix",
  });
  bridge.dbGetViewingResume = async (_, duration) => {
    assert.equal(duration, 1230);
    return {
      positionSeconds: 615,
      durationSeconds: 1230,
      confirmedAt: 100,
      action: "progress",
      finished: false,
    };
  };
  const snapshot = (positionSeconds: number, seeking = false) => ({
    state: {
      ...createEmptyControlsState(),
      status: "playing" as const,
      positionSeconds,
      durationSeconds: 1230,
      seeking,
    },
    capabilities: DEFAULT_PLAYER_CAPABILITIES,
  });
  try {
    await harness.state.open(
      {
        streamUrl: "http://fixture.test/movie",
        title: "Matrix",
        itemIdentity: {
          sourceType: "xtream",
          playlistId: "one",
          contentKind: "vod",
          providerItemId: "7",
        },
        work: { kind: "movie", title: "The Matrix", releaseYear: 1999 },
        contentInfo: {
          playlistId: "one",
          contentType: "vod",
          contentXtreamId: 7,
        },
      },
      VideoPlayer.Html5,
    );
    harness.state.onRuntimeSnapshot(snapshot(0), undefined, (target) => {
      seeks.push(target);
      return true;
    });
    await harness.state.flushPlaybackProgress();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(seeks, [615]);
    assert.deepEqual(saved, []);
    harness.state.onRuntimeSnapshot(snapshot(900, true));
    await harness.state.flushPlaybackProgress();
    assert.deepEqual(saved, []);
    harness.state.onRuntimeSnapshot(snapshot(615));
    await harness.state.flushPlaybackProgress();
    assert.deepEqual(saved, [615]);
  } finally {
    harness.destroy();
  }
});

test("workspace restores semantic preferences and saves only confirmed user choices", async () => {
  const harness = createHarness(async () => undefined);
  const patches: unknown[] = [],
    selected: number[] = [];
  window.electron.dbGetTitlePreferences = async () => ({
    audio: { language: "en", role: "main" },
  });
  window.electron.dbSaveTitlePreferences = async (_, patch) => {
    patches.push(patch);
    return { success: true };
  };
  let listener: ((intent: PlayerPreferenceIntent) => void) | undefined;
  const state = signal({
    ...createEmptyControlsState(),
    status: "playing" as const,
    positionSeconds: 20,
    durationSeconds: 100,
    audioTracks: [
      {
        id: 7,
        language: "fr",
        role: "main" as const,
        label: "French",
        selected: true,
      },
      {
        id: 42,
        language: "eng",
        role: "main" as const,
        label: "English",
        selected: false,
      },
    ],
  });
  const controller = {
    state,
    capabilities: signal({ ...DEFAULT_PLAYER_CAPABILITIES, audioTracks: true }),
    observePreferences: (fn: typeof listener) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    commands: {
      setAudioTrack: (id: number) => {
        selected.push(id);
        listener?.({
          kind: "audio",
          preference: { language: "en", role: "main" },
        });
      },
    },
  } as unknown as import("../player-controls/player-controls.model").PlayerController;
  try {
    await harness.state.open(
      {
        streamUrl: "http://fixture.test/movie",
        title: "Matrix",
        itemIdentity: {
          sourceType: "xtream",
          playlistId: "one",
          contentKind: "vod",
          providerItemId: "7",
        },
        work: { kind: "movie", title: "The Matrix", releaseYear: 1999 },
        contentInfo: {
          playlistId: "one",
          contentType: "vod",
          contentXtreamId: 7,
        },
      },
      VideoPlayer.Html5,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.state.onRuntimeSnapshot(
      { state: state(), capabilities: controller.capabilities() },
      undefined,
      undefined,
      controller,
    );
    assert.deepEqual(selected, [42]);
    assert.deepEqual(patches, []);
    listener?.({ kind: "audio", preference: { language: "en", role: "main" } });
    assert.deepEqual(patches, []);
    state.update((value) => ({
      ...value,
      audioTracks: value.audioTracks.map((track) => ({
        ...track,
        selected: track.id === 42,
      })),
    }));
    harness.state.onRuntimeSnapshot(
      {
        state: { ...state(), status: "ended" },
        capabilities: controller.capabilities(),
      },
      undefined,
      undefined,
      controller,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(patches, [{ audio: { language: "en", role: "main" } }]);
    await harness.state.prepareForPlayback();
    assert.equal(listener, undefined);
  } finally {
    harness.destroy();
  }
});

test("explicit finish and reset flush progress and release the engine before writing actions", async () => {
  const events: string[] = [];
  const harness = createHarness(
    async () => undefined,
    async (_, value) => {
      events.push(
        `save:${(value as { action?: string }).action ?? "progress"}`,
      );
    },
  );
  harness.state.registerPlaybackTeardown(
    () => {
      events.push("release");
    },
    { repeatable: true },
  );
  try {
    await harness.state.open(
      {
        streamUrl: "http://fixture.test/movie",
        title: "Movie",
        contentInfo: {
          playlistId: "one",
          contentType: "vod",
          contentXtreamId: 7,
        },
      },
      VideoPlayer.Html5,
    );
    events.length = 0;
    harness.state.onRuntimeSnapshot({
      state: {
        ...createEmptyControlsState(),
        status: "paused",
        positionSeconds: 40,
        durationSeconds: 100,
      },
      capabilities: DEFAULT_PLAYER_CAPABILITIES,
    });
    await harness.state.markFinished();
    assert.equal(harness.state.stopped(), true);
    assert.ok(events.indexOf("release") < events.indexOf("save:finished"));
    assert.equal(events.at(-1), "save:finished");
    await harness.state.startOver();
    assert.equal(events.at(-1), "save:reset");
    assert.equal(harness.state.playback()?.startTime, 0);
    assert.equal(harness.state.playback()?.resumePolicy, "start-over");
    assert.equal(harness.state.stopped(), true);
  } finally {
    harness.destroy();
  }
});

test("a delayed explicit action cannot update the replacement title context", async () => {
  const pending = deferred(),
    updates: unknown[] = [];
  let saving = false;
  const harness = createHarness(
    async () => undefined,
    async (_, value) => {
      if ((value as { action?: string }).action === "finished") {
        saving = true;
        await pending.promise;
      }
    },
  );
  const playback = (id: number) => ({
    streamUrl: `http://fixture.test/${id}`,
    title: "Movie",
    contentInfo: {
      playlistId: "one",
      contentType: "vod" as const,
      contentXtreamId: id,
    },
  });
  try {
    await harness.state.open(playback(1), VideoPlayer.Html5);
    const action = harness.state.markFinished();
    await waitUntil(() => saving);
    await harness.state.open(playback(2), VideoPlayer.Html5, {
      onTimeUpdate: (value) => updates.push(value),
    });
    pending.resolve();
    await action;
    assert.deepEqual(updates, []);
    assert.equal(harness.state.playback()?.contentInfo?.contentXtreamId, 2);
  } finally {
    pending.resolve();
    harness.destroy();
  }
});

test("provider recovery resolves before teardown and resumes from the latest confirmed clock", async () => {
  const harness = createHarness(async () => undefined);
  const pending = deferred<{ streamUrl: string; title: string }>();
  let teardowns = 0;
  try {
    await harness.state.open(
      { streamUrl: "https://media.example/old", title: "Movie", isLive: false },
      VideoPlayer.Html5Player,
    );
    harness.state.registerPlaybackTeardown(() => {
      teardowns++;
    });
    const work = harness.state.recoverPlayback(
      () => pending.promise,
      async (playback, context) => {
        await harness.state.open(playback, VideoPlayer.Html5Player, context);
      },
    );
    assert.equal(teardowns, 0);
    harness.state.onRuntimeSnapshot({
      state: {
        ...createEmptyControlsState(),
        status: "paused",
        positionSeconds: 42,
        durationSeconds: 100,
        canSeek: true,
      },
      capabilities: DEFAULT_PLAYER_CAPABILITIES,
    });
    pending.resolve({ streamUrl: "https://media.example/new", title: "Movie" });
    assert.equal(await work, true);
    assert.equal(teardowns, 1);
    assert.equal(harness.state.playback()?.startTime, 42);
    assert.equal(harness.state.playback()?.startPaused, true);
  } finally {
    harness.destroy();
  }
});

test("a normal transition cancels provider resolution without resurrecting the old channel", async () => {
  const harness = createHarness(async () => undefined);
  const pending = deferred<{ streamUrl: string; title: string }>();
  let commits = 0;
  try {
    await harness.state.open(
      { streamUrl: "https://media.example/old", title: "Old" },
      VideoPlayer.ArtPlayer,
    );
    const work = harness.state.recoverPlayback(
      () => pending.promise,
      async () => {
        commits++;
      },
    );
    await harness.state.open(
      { streamUrl: "https://media.example/new", title: "New" },
      VideoPlayer.ArtPlayer,
    );
    pending.resolve({ streamUrl: "https://media.example/stale", title: "Old" });
    assert.equal(await work, false);
    assert.equal(commits, 0);
    assert.equal(harness.state.playback()?.title, "New");
  } finally {
    harness.destroy();
  }
});

test("inline provider recovery uses its own latest clock without mounting a second workspace player", async () => {
  const harness = createHarness(async () => undefined);
  let clock = 5;
  let recovered: { startTime?: number; startPaused?: boolean } | undefined;
  const pending = deferred<{
    streamUrl: string;
    title: string;
    isLive: boolean;
  }>();
  try {
    const original = {
      streamUrl: "https://media.example/old",
      title: "Inline",
      isLive: false,
    };
    harness.state.recovery.beginSelection();
    const work = harness.state.recoverPlayback(
      () => pending.promise,
      async (playback) => {
        await harness.state.prepareForPlayback();
        recovered = playback;
      },
      false,
      15000,
      {
        playback: original,
        snapshot: () => ({
          state: {
            ...createEmptyControlsState(),
            status: "paused",
            positionSeconds: clock,
          },
          capabilities: DEFAULT_PLAYER_CAPABILITIES,
        }),
      },
    );
    clock = 21;
    pending.resolve({ ...original, streamUrl: "https://media.example/new" });
    assert.equal(await work, true);
    assert.equal(recovered?.startTime, 21);
    assert.equal(recovered?.startPaused, true);
    assert.equal(harness.state.playback(), null);
  } finally {
    harness.destroy();
  }
});

test("failed teardown cannot count a provider replacement as successful recovery", async () => {
  const harness = createHarness(async () => undefined);
  try {
    await harness.state.open(
      { streamUrl: "https://media.example/old", title: "Old" },
      VideoPlayer.ArtPlayer,
    );
    const unregister = harness.state.registerPlaybackTeardown(() => {
      throw new Error("Release rejected");
    });
    const result = await harness.state.recoverPlayback(
      async () => ({ streamUrl: "https://media.example/new", title: "New" }),
      async (playback, context) => {
        await harness.state.open(playback, VideoPlayer.ArtPlayer, context);
      },
    );
    assert.equal(result, false);
    assert.equal(harness.state.playback()?.title, "Old");
    unregister();
  } finally {
    harness.destroy();
  }
});

test("fresh source replaces prepared URL and clears a previous credential experiment", async () => {
  const harness = createHarness(async () => undefined);
  let candidate: ResolvedPortalPlayback | undefined;
  try {
    await harness.state.open(
      {
        streamUrl: "http://localhost/old-proxy",
        originalStreamUrl: "https://media.example/expired",
        preparedProxy: {
          id: "expired-session",
          url: "http://localhost/old-proxy",
          format: "hls",
        },
        title: "Movie",
        requestPolicy: { loginCookies: true, accountRef: "old" },
        headers: { "User-Agent": "experiment" },
      },
      VideoPlayer.ArtPlayer,
    );
    assert.equal(
      await harness.state.recoverPlayback(
        async () => ({
          streamUrl: "https://media.example/fresh",
          title: "Movie",
          transport: "direct",
        }),
        async (playback) => {
          candidate = playback;
        },
      ),
      true,
    );
    assert.equal(candidate?.streamUrl, "https://media.example/fresh");
    assert.equal(candidate?.originalStreamUrl, undefined);
    assert.equal(candidate?.preparedProxy, undefined);
    assert.equal(candidate?.requestPolicy, undefined);
    assert.equal(candidate?.headers, undefined);
    assert.equal(candidate?.transport, "direct");
  } finally {
    harness.destroy();
  }
});
