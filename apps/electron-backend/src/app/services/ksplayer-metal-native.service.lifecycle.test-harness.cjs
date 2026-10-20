"use strict";

// Focused lifecycle harness for the main-process service. It loads the real
// TypeScript service with lightweight Electron/App mocks so it can exercise
// replacement BrowserWindows without launching a native player or editing
// app.ts.

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const Module = require("node:module");

const servicePath = path.resolve(__dirname, "ksplayer-metal-native.service.ts");
const appState = { mainWindow: null };
const activePowerBlockers = new Set();
let nextPowerBlockerId = 1;

const electronMock = {
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
  powerSaveBlocker: {
    start: () => {
      const id = nextPowerBlockerId++;
      activePowerBlockers.add(id);
      return id;
    },
    isStarted: (id) => activePowerBlockers.has(id),
    stop: (id) => activePowerBlockers.delete(id),
  },
};

const originalLoad = Module._load;
Module._load = function loadLifecycleHarnessModule(request, parent, isMain) {
  if (request === "electron") {
    return electronMock;
  }
  if (request === "../app" && parent?.filename === servicePath) {
    return appState;
  }
  if (request === "@arm-nator/shared/interfaces") {
    return {
      KSPLAYER_METAL_SESSION_UPDATE: "ksplayer-metal-session-update",
    };
  }
  if (
    request === "./playback-diagnostics.service" &&
    parent?.filename === servicePath
  ) {
    return { playbackDiagnostics: { record: () => undefined } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let KsPlayerMetalNativeService;
try {
  require("ts-node").register({
    project: path.resolve(__dirname, "../../../tsconfig.json"),
    transpileOnly: true,
  });
  ({ KsPlayerMetalNativeService } = require(servicePath));
} finally {
  Module._load = originalLoad;
}

class FakeWebContents extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.destroyed = false;
    this.sent = [];
  }

  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }

  getZoomFactor() {
    return 1;
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel, payload) {
    if (this.destroyed) {
      throw new Error(`${this.label} web contents is destroyed`);
    }
    this.sent.push({ channel, payload });
  }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(label) {
    super();
    this.label = label;
    this.destroyed = false;
    this.webContents = new FakeWebContents(label);
  }

  close() {
    this.destroyed = true;
    this.emit("closed");
  }

  getNativeWindowHandle() {
    return Buffer.from(this.label);
  }

  isDestroyed() {
    return this.destroyed;
  }
}

function createAddon() {
  const calls = {
    createSession: [],
    disposeAll: 0,
    disposeSession: [],
    getSnapshot: 0,
    seek: [],
  };
  const snapshot = {
    positionSeconds: 0,
    status: "playing",
    streamUrl: "https://stream.test/vod.mp4",
    volume: 1,
  };

  return {
    addon: {
      createSession: (sessionId) => {
        calls.createSession.push(sessionId);
        return { ok: true };
      },
      disposeAll: () => {
        calls.disposeAll += 1;
        return { ok: true };
      },
      disposeSession: (sessionId) => {
        calls.disposeSession.push(sessionId);
        return { ok: true };
      },
      getSnapshot: () => {
        calls.getSnapshot += 1;
        return { ...snapshot };
      },
      getSupport: () => ({ supported: true }),
      getSupportedControls: () => ({
        pause: true,
        seek: true,
        volume: true,
      }),
      load: () => ({ ok: true }),
      prepare: () => ({ supported: true }),
      seek: (sessionId, seconds) => {
        calls.seek.push({ sessionId, seconds });
        return { ok: true };
      },
      setBounds: () => ({ ok: true }),
      setPaused: () => ({ ok: true }),
      setVolume: () => ({ ok: true }),
    },
    calls,
  };
}

function createFixture() {
  activePowerBlockers.clear();
  const timers = new Set();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    timers.delete(timer);
  };

  const { addon, calls } = createAddon();
  const service = new KsPlayerMetalNativeService();
  service.addon = addon;
  service.prepare = () => ({ supported: true });

  return {
    addon,
    calls,
    service,
    timers,
    cleanup: () => {
      service.shutdown();
      appState.mainWindow = null;
      activePowerBlockers.clear();
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    },
  };
}

function assertLifecycleListeners(window, expected, message) {
  assert.equal(
    window.listenerCount("closed"),
    expected,
    `${message}: BrowserWindow closed listener count`,
  );
  assert.equal(
    window.webContents.listenerCount("did-navigate"),
    expected,
    `${message}: did-navigate listener count`,
  );
  assert.equal(
    window.webContents.listenerCount("destroyed"),
    expected,
    `${message}: webContents destroyed listener count`,
  );
  assert.equal(
    window.webContents.listenerCount("render-process-gone"),
    expected,
    `${message}: render-process-gone listener count`,
  );
}

function assertReleased(fixture, message) {
  assert.equal(fixture.timers.size, 0, `${message}: bounds timer released`);
  assert.equal(
    activePowerBlockers.size,
    0,
    `${message}: power blocker released`,
  );
}

function play(service, window) {
  appState.mainWindow = window;
  return service.createSession({ x: 10, y: 20, width: 320, height: 180 });
}

function testCloseActivateReplacementLifecycle() {
  const fixture = createFixture();
  try {
    const firstWindow = new FakeBrowserWindow("first");
    play(fixture.service, firstWindow);
    assertLifecycleListeners(firstWindow, 1, "first playback");
    assert.equal(fixture.timers.size, 1, "first playback starts one timer");
    assert.equal(
      activePowerBlockers.size,
      1,
      "first playback starts a power blocker",
    );

    firstWindow.close();
    assert.equal(
      fixture.calls.disposeAll,
      1,
      "first close disposes native player",
    );
    assertReleased(fixture, "first close");
    assertLifecycleListeners(firstWindow, 0, "first close detaches listeners");

    const replacementWindow = new FakeBrowserWindow("replacement");
    play(fixture.service, replacementWindow);
    play(fixture.service, replacementWindow);
    assertLifecycleListeners(
      replacementWindow,
      1,
      "replacement playback binds once",
    );
    assertLifecycleListeners(
      firstWindow,
      0,
      "replacement playback leaves old window detached",
    );
    assert.equal(
      fixture.timers.size,
      1,
      "replacement playback retains one timer",
    );

    replacementWindow.close();
    assert.equal(
      fixture.calls.disposeAll,
      2,
      "replacement close disposes native player",
    );
    assertReleased(fixture, "replacement close");
    assertLifecycleListeners(
      replacementWindow,
      0,
      "replacement close detaches listeners",
    );

    const recreatedWindow = new FakeBrowserWindow("recreated");
    play(fixture.service, recreatedWindow);
    assertLifecycleListeners(
      recreatedWindow,
      1,
      "recreated playback rebinds listeners",
    );
    assert.equal(fixture.timers.size, 1, "recreated playback starts one timer");
    assert.equal(
      activePowerBlockers.size,
      1,
      "recreated playback starts one power blocker",
    );
  } finally {
    fixture.cleanup();
  }
}

function testNavigationRendererFailureAndDestroyedWindowLifecycle() {
  const fixture = createFixture();
  try {
    const window = new FakeBrowserWindow("navigation");
    play(fixture.service, window);

    window.webContents.emit("did-navigate");
    assert.equal(
      fixture.calls.disposeAll,
      1,
      "navigation disposes native player",
    );
    assertReleased(fixture, "navigation");
    assertLifecycleListeners(window, 1, "navigation retains current watch");

    play(fixture.service, window);
    assertLifecycleListeners(
      window,
      1,
      "navigation replay does not duplicate watch",
    );
    window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    assert.equal(
      fixture.calls.disposeAll,
      2,
      "renderer failure disposes native player",
    );
    assertReleased(fixture, "renderer failure");
    assertLifecycleListeners(
      window,
      1,
      "renderer failure retains current watch",
    );

    play(fixture.service, window);
    window.webContents.destroy();
    assert.equal(
      fixture.calls.disposeAll,
      3,
      "destroyed web contents disposes native player",
    );
    assertReleased(fixture, "destroyed web contents");
    assertLifecycleListeners(
      window,
      0,
      "destroyed web contents detaches watch",
    );

    const replacementWindow = new FakeBrowserWindow("after-destroy");
    play(fixture.service, replacementWindow);
    assertLifecycleListeners(
      replacementWindow,
      1,
      "replacement after destroyed web contents binds watch",
    );
  } finally {
    fixture.cleanup();
  }
}

function testSessionAndServiceShutdownReleaseResources() {
  const fixture = createFixture();
  try {
    const window = new FakeBrowserWindow("dispose");
    const session = play(fixture.service, window);

    fixture.service.disposeSession(session.id);
    assert.deepEqual(
      fixture.calls.disposeSession,
      [session.id],
      "session dispose releases the native session",
    );
    assertReleased(fixture, "session dispose");
    assertLifecycleListeners(
      window,
      1,
      "session dispose retains current watch",
    );

    play(fixture.service, window);
    fixture.service.shutdown();
    assert.equal(
      fixture.calls.disposeAll,
      1,
      "service shutdown disposes active native sessions",
    );
    assertReleased(fixture, "service shutdown");
    assertLifecycleListeners(window, 0, "service shutdown detaches watch");

    window.close();
    assert.equal(
      fixture.calls.disposeAll,
      1,
      "late window close cannot run stale service listener",
    );
  } finally {
    fixture.cleanup();
  }
}

function testPausedSessionPollingStops() {
  const fixture = createFixture();
  try {
    fixture.addon.getSnapshot = () => ({
      positionSeconds: 4,
      status: "paused",
      streamUrl: "https://stream.test/vod.mp4",
      volume: 1,
    });
    const window = new FakeBrowserWindow("paused");
    play(fixture.service, window);
    const pollTimer = [...fixture.timers][0];
    const snapshotsAfterCreate = fixture.calls.getSnapshot;

    pollTimer.callback();

    assert.equal(
      fixture.calls.getSnapshot,
      snapshotsAfterCreate,
      "paused KSPlayer sessions are not refreshed by the hot polling timer",
    );
  } finally {
    fixture.cleanup();
  }
}

function testSeekFailureAndDisposeRace() {
  const fixture = createFixture();
  try {
    const window = new FakeBrowserWindow("seek");
    const session = play(fixture.service, window);
    const pollTimer = [...fixture.timers][0];

    fixture.service.seek(session.id, 1.25);
    fixture.service.seek(session.id, 3.5);
    fixture.service.seek(session.id, 6.75);
    assert.deepEqual(
      fixture.calls.seek,
      [
        { sessionId: session.id, seconds: 1.25 },
        { sessionId: session.id, seconds: 3.5 },
        { sessionId: session.id, seconds: 6.75 },
      ],
      "main-process service forwards rapid requests without waiting for native completion",
    );

    fixture.addon.seek = (sessionId, seconds) => {
      fixture.calls.seek.push({ sessionId, seconds });
      return {
        ok: false,
        reason: "KSPlayer Metal cannot seek a live or non-seekable stream.",
      };
    };
    assert.throws(
      () => fixture.service.seek(session.id, 2),
      /live or non-seekable stream/,
      "native unsupported seek result remains a truthful IPC failure",
    );

    const snapshotsBeforeDispose = fixture.calls.getSnapshot;
    fixture.service.disposeSession(session.id);
    const updatesAfterDispose = window.webContents.sent.length;
    assertReleased(fixture, "seek dispose race");

    // A timer callback can already be queued when disposal clears the interval.
    // It must observe the deleted session map and never publish a stale native
    // completion/snapshot back to the renderer.
    pollTimer.callback();
    assert.equal(
      fixture.calls.getSnapshot,
      snapshotsBeforeDispose,
      "late polling callback does not query a disposed native session",
    );
    assert.equal(
      window.webContents.sent.length,
      updatesAfterDispose,
      "late polling callback does not revive a disposed renderer session",
    );
  } finally {
    fixture.cleanup();
  }
}

function testDisposeFailureRetainsSessionOwnershipForRetry() {
  const fixture = createFixture();
  try {
    const window = new FakeBrowserWindow("dispose-failure");
    const session = play(fixture.service, window);
    const initialUpdates = window.webContents.sent.length;
    fixture.addon.disposeSession = () => ({
      ok: false,
      reason: "native dispose failed",
    });

    assert.throws(
      () => fixture.service.disposeSession(session.id),
      /native dispose failed/,
    );
    assert.equal(fixture.service.sessions.has(session.id), true);
    assert.equal(
      window.webContents.sent
        .slice(initialUpdates)
        .some(({ payload }) => payload.status === "closed"),
      false,
      "failed disposal must not publish a closed snapshot",
    );
    assert.equal(fixture.timers.size, 1, "failed disposal retains polling ownership");
    assert.equal(activePowerBlockers.size, 1, "failed disposal retains the power blocker");

    const previousDisposeAll = fixture.addon.disposeAll;
    fixture.addon.disposeAll = () => ({ok: false, reason: "strict cleanup failed"});
    assert.throws(() => fixture.service.shutdown(true), /strict cleanup failed/);
    assert.equal(fixture.service.sessions.has(session.id), true);
    fixture.addon.disposeAll = previousDisposeAll;
    fixture.addon.disposeSession = () => ({ ok: true });
    const closed = fixture.service.disposeSession(session.id);
    assert.equal(closed?.status, "closed");
    assert.equal(fixture.service.sessions.has(session.id), false);
    assert.equal(
      window.webContents.sent
        .slice(initialUpdates)
        .filter(({ payload }) => payload.status === "closed").length,
      1,
      "successful retry publishes one closed snapshot",
    );
    assertReleased(fixture, "successful disposal retry");
  } finally {
    fixture.cleanup();
  }
}

const tests = [
  [
    "close → activate/replacement → play → close/recreate",
    testCloseActivateReplacementLifecycle,
  ],
  [
    "navigation, renderer failure, and destroyed web contents",
    testNavigationRendererFailureAndDestroyedWindowLifecycle,
  ],
  [
    "session dispose and service shutdown",
    testSessionAndServiceShutdownReleaseResources,
  ],
  ["paused sessions stop hot polling", testPausedSessionPollingStops],
  [
    "rapid seek dispatch, unsupported failure, and dispose race",
    testSeekFailureAndDisposeRace,
  ],
  ["failed native disposal retains ownership for retry", testDisposeFailureRetainsSessionOwnershipForRetry],
];

for (const [name, run] of tests) {
  run();
  console.log(`ok - KSPlayer Metal lifecycle: ${name}`);
}
