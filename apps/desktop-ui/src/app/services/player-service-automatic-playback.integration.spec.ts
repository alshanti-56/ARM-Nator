import "@angular/compiler";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { createEnvironmentInjector, runInInjectionContext } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { Router } from "@angular/router";
import { DataService, PlaybackPositionService, SettingsStore } from "@arm-nator/services";
import { ResolvedPortalPlayback, VideoPlayer } from "@arm-nator/shared/interfaces";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("The expected automatic playback operation did not start.");
}

function source(streamUrl: string, extra: Partial<ResolvedPortalPlayback> = {}): ResolvedPortalPlayback {
  return { streamUrl, title: "Example movie", isLive: false, ...extra };
}

function prepared(id: string, url: string) {
  return { ok: true as const, session: { id, url, format: "hls" as const, container: "hls" as const } };
}

async function createHarness(preparePlayback: (...args: unknown[]) => Promise<unknown>) {
  const preparedCalls: { url: string; headers: Record<string, string>; isLive: boolean; attemptId: string }[] = [];
  const cancelCalls: string[] = [];
  const releaseCalls: string[] = [];
  const externalCalls: { type: string; payload: Record<string, unknown> }[] = [];
  const decisions: unknown[] = [];
  const bridge = {
    onBrowserViewUpdate: () => () => undefined,
    closeBrowserView: async () => undefined,
    prepareAutoPlayback: async (url: string, headers: Record<string, string>, isLive: boolean, attemptId: string) => {
      preparedCalls.push({ url, headers, isLive, attemptId });
      return preparePlayback(url, headers, isLive, attemptId);
    },
    cancelAutoPlaybackPreparation: async (attemptId: string) => { cancelCalls.push(attemptId); },
    releaseAutoPlaybackSession: async (sessionId: string) => { releaseCalls.push(sessionId); },
    getEmbeddedMpvSupport: async () => ({ supported: true }),
    getKsPlayerMetalSupport: async () => ({ supported: false }),
    recordAutomaticPlaybackDecision: async (decision: unknown) => { decisions.push(decision); },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    electron: bridge,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } });
  const require = createRequire(import.meta.url);
  const stateModulePath = resolve(process.cwd(), "libs/player/ui/src/lib/workspace-player/workspace-player-state.service.ts");
  const { WorkspacePlayerStateService } = require(stateModulePath);
  // PlayerService consumes only the state-service token from the UI barrel;
  // skip evaluating browser-only player drivers while keeping the real state.
  const moduleApi = await import("node:module");
  const moduleLoader = moduleApi.default as unknown as {
    _resolveFilename: (request: string, ...args: unknown[]) => string;
  };
  const originalResolveFilename = moduleLoader._resolveFilename;
  const mockUiModuleId = `${process.cwd()}/tmp/automatic-playback/player-ui-barrel-mock.cjs`;
  require.cache[mockUiModuleId] = {
    id: mockUiModuleId,
    filename: mockUiModuleId,
    loaded: true,
    exports: { WorkspacePlayerStateService },
    children: [],
    paths: [],
  } as NodeJS.Module;
  moduleLoader._resolveFilename = function (request: string, ...args: unknown[]): string {
    return request === "@arm-nator/player/ui"
      ? mockUiModuleId
      : originalResolveFilename.call(this, request, ...args);
  };
  let PlayerService: typeof import("./player.service").PlayerService;
  try {
    ({ PlayerService } = await import("./player.service"));
  } finally {
    moduleLoader._resolveFilename = originalResolveFilename;
    delete require.cache[mockUiModuleId];
  }
  const injector = createEnvironmentInjector([
    WorkspacePlayerStateService,
    PlayerService,
    { provide: MatDialog, useValue: { open: () => undefined } },
    { provide: Router, useValue: { url: "/workspace/dashboard", navigateByUrl: async () => true } },
    { provide: PlaybackPositionService, useValue: { savePlaybackPosition: async () => undefined, savePlaybackPositionOrThrow: async () => undefined, saveViewingProgressOrThrow: async () => undefined } },
    { provide: DataService, useValue: { sendIpcEvent: async (type: string, payload: unknown) => {
      externalCalls.push({ type, payload });
      return { id: "external-1", status: "started" };
    } } },
    { provide: SettingsStore, useValue: { getSettings: () => ({
      player: VideoPlayer.ArtPlayer,
      livePlayer: VideoPlayer.Auto,
      vodPlayer: VideoPlayer.Auto,
    }) } },
  ]);
  const state = runInInjectionContext(injector, () => injector.get(WorkspacePlayerStateService));
  const service = runInInjectionContext(injector, () => injector.get(PlayerService));
  return {
    observePosition(positionSeconds: number, durationSeconds: number): void {
      const { createEmptyControlsState, DEFAULT_PLAYER_CAPABILITIES } = createRequire(import.meta.url)(resolve('libs/player/ui/src/lib/player-controls/player-controls-defaults.ts'));
      state.onRuntimeSnapshot({ state: { ...createEmptyControlsState(), status: 'playing', positionSeconds, durationSeconds }, capabilities: DEFAULT_PLAYER_CAPABILITIES });
    },
    state, service, bridge, preparedCalls, cancelCalls, releaseCalls, externalCalls, decisions,
    destroy(): void {
      injector.destroy();
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
      if (previousSelf) Object.defineProperty(globalThis, "self", previousSelf);
      else Reflect.deleteProperty(globalThis, "self");
    },
  };
}

test("saved provider headers reach preparation and the selected player receives the local HLS URL", async () => {
  const harness = await createHarness(async () => prepared("proxy-1", "http://127.0.0.1:43111/auto/proxy-1/master.m3u8"));
  try {
    const playback = source("https://provider.example/movie.m3u8", {
      headers: { Authorization: "Bearer saved", referer: "https://portal.example/watch", "user-agent": "stored-agent" },
      userAgent: "explicit-agent",
    });
    await harness.service.openResolvedPlayback(playback);

    assert.equal(harness.preparedCalls.length, 1);
    assert.equal(harness.preparedCalls[0].url, playback.streamUrl);
    assert.equal(harness.preparedCalls[0].isLive, false);
    assert.deepEqual(harness.preparedCalls[0].headers, {
      Authorization: "Bearer saved",
      referer: "https://portal.example/watch",
      "User-Agent": "explicit-agent",
    });
    assert.equal(harness.state.playback()?.streamUrl, "http://127.0.0.1:43111/auto/proxy-1/master.m3u8");
    assert.equal(harness.state.playback()?.originalStreamUrl, playback.streamUrl);
    assert.equal(harness.state.playback()?.preparedProxy?.id, "proxy-1");
    assert.equal(harness.state.engine(), VideoPlayer.EmbeddedMpv);
    assert.equal(harness.state.reloadGeneration(), 1);
  } finally {
    harness.destroy();
  }
});

test("manual inline switching drains the old proxy and retains preparation for the selected engine", async () => {
  const harness = await createHarness(async () => prepared("proxy-manual", "http://127.0.0.1:43111/auto/proxy-manual/master.m3u8"));
  try {
    const original = source("https://provider.example/channel.m3u8", { isLive: true });
    await harness.service.openAutomaticPlayback(original);
    const automaticPlayback = harness.state.playback();
    assert.ok(automaticPlayback?.preparedProxy);
    assert.ok(automaticPlayback);

    await harness.service.openInlinePlayback(automaticPlayback, VideoPlayer.Html5Player);

    assert.equal(harness.state.playback()?.originalStreamUrl, original.streamUrl);
    assert.equal(harness.preparedCalls.length, 2);
    assert.equal(harness.preparedCalls[1].url, original.streamUrl);
    assert.equal(harness.state.engine(), VideoPlayer.Html5Player);
    assert.deepEqual(harness.releaseCalls, ["proxy-manual"]);
  } finally {
    harness.destroy();
  }
});

test("an HTTP 401 preparation failure stays diagnostic, preserves retry context, and does not mount a driver", async () => {
  const retrySignals: AbortSignal[] = [];
  const context = { onRetry: (signal: AbortSignal) => { retrySignals.push(signal); } };
  const harness = await createHarness(async () => ({
    ok: false as const,
    error: { code: "upstream-http-error", status: 401, message: "Provider rejected the stream" },
  }));
  try {
    const original = source("https://provider.example/expired.m3u8");
    await harness.service.openAutomaticPlayback(original, context);

    assert.equal(harness.state.reloadGeneration(), 0);
    assert.equal(harness.state.automaticPreparing(), false);
    assert.equal(harness.state.playback()?.streamUrl, original.streamUrl);
    assert.equal(harness.state.automaticFailure()?.code, "provider-rejected");
    assert.match(harness.state.automaticFailure()?.details ?? "", /401/);
    assert.equal(harness.state.context(), context);

    await harness.state.restart();
    await waitUntil(() => retrySignals.length === 1);
    assert.equal(retrySignals[0].aborted, false);
    assert.equal(harness.state.reloadGeneration(), 0);
  } finally {
    harness.destroy();
  }
});

test("manual engine preparation rejection retains its failure instead of leaving an empty player", async () => {
  const harness = await createHarness(async () => ({
    ok: false as const,
    error: { code: "upstream-http-error", status: 403, message: "Provider rejected the stream" },
  }));
  try {
    await harness.service.openInlinePlayback(source("https://provider.example/denied.mp4"), VideoPlayer.KsPlayer);
    assert.equal(harness.state.automaticMode(), false, "manual selection remains manual");
    assert.equal(harness.state.automaticPreparing(), false);
    assert.equal(harness.state.automaticFailure()?.code, "provider-rejected");
    assert.equal(harness.state.automaticFailure()?.network?.status, 403);
    assert.equal(harness.state.reloadGeneration(), 0, "rejected preparation must not mount a driver");
  } finally {
    harness.destroy();
  }
});

test("a late preparation result is released before the replacement source starts", async () => {
  const late = deferred<ReturnType<typeof prepared>>();
  let prepareCount = 0;
  const harness = await createHarness(async () => {
    prepareCount += 1;
    return prepareCount === 1 ? late.promise : prepared("proxy-b", "http://127.0.0.1:43111/auto/proxy-b/master.m3u8");
  });
  try {
    const first = harness.service.openAutomaticPlayback(source("https://provider.example/a.m3u8"));
    await waitUntil(() => harness.preparedCalls.length === 1);
    const replacement = harness.service.openAutomaticPlayback(source("https://provider.example/b.m3u8"));
    await waitUntil(() => harness.cancelCalls.length === 1);
    assert.equal(harness.preparedCalls.length, 1, "replacement waits for old ownership to drain");

    late.resolve(prepared("proxy-a-late", "http://127.0.0.1:43111/auto/proxy-a/master.m3u8"));
    await Promise.all([first, replacement]);

    assert.deepEqual(harness.releaseCalls, ["proxy-a-late"]);
    assert.equal(harness.state.playback()?.streamUrl, "http://127.0.0.1:43111/auto/proxy-b/master.m3u8");
    assert.equal(harness.state.playback()?.originalStreamUrl, "https://provider.example/b.m3u8");
    assert.equal(harness.state.reloadGeneration(), 1);
  } finally {
    harness.destroy();
  }
});

test("native decoder failure falls back to the browser at the current VOD position", async () => {
  const preparedSessions = [
    prepared("proxy-web", "http://127.0.0.1:43111/auto/proxy-web/master.m3u8"),
    prepared("proxy-native", "http://127.0.0.1:43111/auto/proxy-native/master.m3u8"),
  ];
  let nextSession = 0;
  const harness = await createHarness(async () => preparedSessions[nextSession++]);
  try {
    const original = source("https://provider.example/movie.m3u8", { startTime: 3 });
    await harness.service.openAutomaticPlayback(original);
    harness.observePosition(47, 120);

    const switched = await harness.service.handleAutomaticDiagnostic({
      code: "media-decode-error",
      sourceUrl: "http://127.0.0.1:43111/auto/proxy-web/master.m3u8",
    });

    assert.equal(switched, true);
    assert.equal(harness.preparedCalls.length, 2);
    assert.equal(harness.preparedCalls[1].url, original.streamUrl);
    assert.equal(harness.state.playback()?.streamUrl, "http://127.0.0.1:43111/auto/proxy-native/master.m3u8");
    assert.equal(harness.state.playback()?.startTime, 47);
    assert.equal(harness.state.engine(), VideoPlayer.ArtPlayer);
    assert.deepEqual(harness.releaseCalls, ["proxy-web"]);
    assert.equal(harness.state.reloadGeneration(), 2);
  } finally {
    harness.destroy();
  }
});

test("manual recovery carries volume, speed and semantic tracks alongside position and pause", async () => {
  const harness = await createHarness(async () => prepared("restore", "http://127.0.0.1:43111/movie.mp4"));
  try {
    const original = source("https://provider.example/movie.mp4");
    await harness.service.openInlinePlayback(original, VideoPlayer.KsPlayer);
    const { createEmptyControlsState, DEFAULT_PLAYER_CAPABILITIES } = createRequire(import.meta.url)(resolve('libs/player/ui/src/lib/player-controls/player-controls-defaults.ts'));
    const audio = { id: 4, label: 'French', language: 'fr', role: 'main', selected: true };
    const subtitle = { id: 8, label: 'English', language: 'en', role: 'forced', selected: true };
    harness.state.onRuntimeSnapshot({ capabilities: DEFAULT_PLAYER_CAPABILITIES, state: {
      ...createEmptyControlsState(), status: 'paused', positionSeconds: 24, durationSeconds: 60,
      volume: 0.35, playbackSpeed: 1.25, audioTracks: [audio], subtitleTracks: [subtitle], subtitlesEnabled: true,
    } });
    let restored: ResolvedPortalPlayback | undefined;
    await harness.state.recoverPlayback(async () => original, async (playback: ResolvedPortalPlayback) => { restored = playback; });
    assert.equal(restored?.startTime, 24);
    assert.equal(restored?.startPaused, true);
    assert.deepEqual(restored?.recoveryState, { volume: 0.35, playbackSpeed: 1.25, audio, subtitle });
  } finally {
    harness.destroy();
  }
});

test("manual external playback also receives the original provider URL", async () => {
  const harness = await createHarness(async () => prepared("proxy-external", "http://127.0.0.1:43111/auto/proxy-external/master.m3u8"));
  try {
    await harness.service.openAutomaticPlayback(source("https://provider.example/external.m3u8"));
    const automaticPlayback = harness.state.playback();
    assert.ok(automaticPlayback);
    await harness.service.openExternalPlayback(automaticPlayback, "vlc");

    assert.equal(harness.externalCalls.length, 1);
    assert.equal(harness.externalCalls[0].payload.url, "https://provider.example/external.m3u8");
    assert.deepEqual(harness.releaseCalls, ["proxy-external"]);
  } finally {
    harness.destroy();
  }
});

 test("browser Auto starts direct playback without an Electron preparation bridge", async () => {
  const harness = await createHarness(async () => { throw new Error('Desktop preparation must not run'); });
  try {
    Object.assign(harness.bridge, { platform: 'web', getEmbeddedMpvSupport: undefined, getKsPlayerMetalSupport: undefined });
    await harness.service.openAutomaticPlayback(source('https://media.example/test.mp4'));
    assert.equal(harness.preparedCalls.length, 0);
    assert.equal(harness.state.engine(), VideoPlayer.Html5Player);
    assert.equal(harness.state.playback()?.preparedProxy?.processingMode, 'direct');
  } finally { harness.destroy(); }
});
