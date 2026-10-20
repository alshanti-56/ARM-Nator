"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");

const servicePath = path.resolve(__dirname, "embedded-mpv-native.service.ts");
const appState = { mainWindow: null };
const activePowerBlockers = new Set();
let nextPowerBlockerId = 1;
const electronMock = {
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
Module._load = function loadEmbeddedLifecycleHarness(request, parent, isMain) {
  if (request === "electron") {
    return electronMock;
  }
  if (request === "../app" && parent?.filename === servicePath) {
    return appState;
  }
  if (request === "@arm-nator/shared/interfaces") {
    return { EMBEDDED_MPV_SESSION_UPDATE: "embedded-mpv-session-update" };
  }
  if (
    request === "./playback-diagnostics.service" &&
    parent?.filename === servicePath
  ) {
    return { playbackDiagnostics: { record: () => undefined } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let EmbeddedMpvNativeService;
try {
  require("ts-node").register({
    project: path.resolve(__dirname, "../../../tsconfig.json"),
    transpileOnly: true,
  });
  ({ EmbeddedMpvNativeService } = require(servicePath));
} finally {
  Module._load = originalLoad;
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  getZoomFactor() {
    return 1;
  }

  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
}

function createFixture() {
  const timers = new Set();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay };
    timers.add(timer);
    return timer;
  };
  global.clearInterval = (timer) => timers.delete(timer);

  const webContents = new FakeWebContents();
  appState.mainWindow = {
    webContents,
    getNativeWindowHandle: () => Buffer.from("test-window"),
    isDestroyed: () => false,
    on: () => undefined,
    off: () => undefined,
  };
  let nextSessionId = 0;
  const calls = { disposeSession: [] };
  const addon = {
    isSupported: () => true,
    createSession: () => `embedded-test-${++nextSessionId}`,
    loadPlayback: () => undefined,
    setBounds: () => undefined,
    setPaused: () => undefined,
    seek: () => undefined,
    setVolume: () => undefined,
    setAudioTrack: () => undefined,
    getSessionSnapshot: () => ({
      status: "playing",
      positionSeconds: 1,
      durationSeconds: 60,
      volume: 0.5,
      streamUrl: "https://stream.test/video.mp4",
    }),
    disposeSession: (sessionId) => {
      calls.disposeSession.push(sessionId);
    },
  };
  const service = new EmbeddedMpvNativeService();
  service.addon = addon;

  return {
    addon,
    app: appState,
    calls,
    service,
    timers,
    updates: webContents.sent,
    cleanup: () => {
      try {
        service.shutdown();
      } finally {
        appState.mainWindow = null;
        activePowerBlockers.clear();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
      }
    },
  };
}

function testFailedDisposeRetainsOwnershipForRetry() {
  const fixture = createFixture();
  try {
    const session = fixture.service.createSession(
      { x: 0, y: 0, width: 320, height: 180 },
      "Native teardown test",
      0.5,
    );
    const initialUpdates = fixture.updates.length;
    fixture.addon.disposeSession = (sessionId) => {
      fixture.calls.disposeSession.push(sessionId);
      throw new Error("native dispose failed");
    };

    assert.throws(
      () => fixture.service.disposeSession(session.id),
      /native dispose failed/,
    );
    assert.equal(fixture.service.sessions.has(session.id), true);
    assert.equal(
      fixture.updates
        .slice(initialUpdates)
        .some(({ payload }) => payload.status === "closed"),
      false,
      "failed disposal must not publish a closed snapshot",
    );
    assert.equal(fixture.timers.size, 1, "failed disposal retains polling ownership");
    assert.equal(activePowerBlockers.size, 1, "failed disposal retains the power blocker");

    fixture.addon.disposeSession = (sessionId) => {
      fixture.calls.disposeSession.push(sessionId);
    };
    const closed = fixture.service.disposeSession(session.id);
    assert.equal(closed?.status, "closed");
    assert.equal(fixture.service.sessions.has(session.id), false);
    assert.equal(
      fixture.updates
        .slice(initialUpdates)
        .filter(({ payload }) => payload.status === "closed").length,
      1,
      "successful retry publishes one closed snapshot",
    );
    assert.equal(fixture.timers.size, 0);
    assert.equal(activePowerBlockers.size, 0);
  } finally {
    fixture.cleanup();
  }
}

function testShutdownBestEffortRetainsFailedOwnership() {
  const fixture = createFixture();
  try {
    const session = fixture.service.createSession(
      { x: 0, y: 0, width: 320, height: 180 },
      "Native shutdown test",
      0.5,
    );
    const initialUpdates = fixture.updates.length;
    fixture.addon.disposeSession = () => {
      throw new Error("native shutdown dispose failed");
    };

    assert.throws(() => fixture.service.shutdown(true), /Native player cleanup failed/);
    assert.doesNotThrow(() => fixture.service.shutdown());
    assert.equal(fixture.service.sessions.has(session.id), true);
    assert.equal(
      fixture.updates
        .slice(initialUpdates)
        .some(({ payload }) => payload.status === "closed"),
      false,
    );

    fixture.addon.disposeSession = () => undefined;
    fixture.service.shutdown();
    assert.equal(fixture.service.sessions.has(session.id), false);
  } finally {
    fixture.cleanup();
  }
}

function testConfirmedFractionalClock() {
  const fixture = createFixture();
  try {
    const session = fixture.service.createSession({ x: 0, y: 0, width: 320, height: 180 }, 'Clock test', 0.5);
    fixture.addon.getSessionSnapshot = () => ({ status: 'playing', positionSeconds: 94.9, durationSeconds: 100.1, seeking: true, volume: 0.5, streamUrl: 'https://stream.test/video.mp4' });
    const snapshot = fixture.service.refreshSession(session.id);
    assert.equal(snapshot.positionSeconds, 94.9);
    assert.equal(snapshot.durationSeconds, 100.1);
    assert.equal(snapshot.seeking, true);
  } finally { fixture.cleanup(); }
}

testConfirmedFractionalClock();
testFailedDisposeRetainsOwnershipForRetry();
testShutdownBestEffortRetainsFailedOwnership();
console.log("ok - Embedded MPV native disposal failure retains ownership for retry");
