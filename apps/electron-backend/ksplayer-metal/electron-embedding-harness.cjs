"use strict";

// Focused real-host diagnostic. Run this with this repository's Electron
// executable after `pnpm ksplayer-metal:build`; it deliberately calls the same
// BrowserWindow#getNativeWindowHandle path as the production service.

const { app, BrowserWindow } = require("electron");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "../../..");
const sessionId = `ksplayer-metal-electron-harness-${process.pid}`;
const timeoutProbeSessionId = `${sessionId}-timeout-probe`;
const disposeProbeSessionId = `${sessionId}-dispose-probe`;
const testSeekTimeoutMilliseconds = 150;
const testLateCompletionDelayMilliseconds = 500;

// These environment variables are consumed only by the two harness-designated
// sessions. The runtime keeps its production timeout at 15 seconds everywhere
// else, and the seam is configured before the native dylib is loaded.
process.env.ARM_NATOR_KSPLAYER_METAL_TEST_SESSION_IDS = [
  timeoutProbeSessionId,
  disposeProbeSessionId,
].join(",");
process.env.ARM_NATOR_KSPLAYER_METAL_TEST_SEEK_TIMEOUT_MS = String(
  testSeekTimeoutMilliseconds,
);
process.env.ARM_NATOR_KSPLAYER_METAL_TEST_LATE_COMPLETION_MS = String(
  testLateCompletionDelayMilliseconds,
);

const addon = require(
  path.join(
    repositoryRoot,
    "apps/electron-backend/native/build/Release/ksplayer_metal.node",
  ),
);
const fixturePath = process.env.ARM_NATOR_KSPLAYER_METAL_HARNESS_FIXTURE
  ? path.resolve(process.env.ARM_NATOR_KSPLAYER_METAL_HARNESS_FIXTURE)
  : path.join(
      repositoryRoot,
      "tmp/ksplayer-spike/runtime-fixture/direct-metal-h264.mp4",
    );
const firstBounds = { x: 137, y: 83, width: 320, height: 180 };
const secondBounds = { x: 211, y: 117, width: 240, height: 135 };
const boundsChurnIterations = 32;
const seekTimeoutMilliseconds = 5_000;
const seekToleranceSeconds = 0.75;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function operationEvidence(value) {
  return {
    ok: value?.ok !== false,
    ...(typeof value?.reason === "string" ? { reason: value.reason } : {}),
    ...(typeof value?.message === "string" ? { message: value.message } : {}),
  };
}

function snapshotEvidence(snapshot) {
  return {
    state: snapshot?.state ?? snapshot?.status ?? "unavailable",
    positionSeconds: snapshot?.positionSeconds ?? null,
    durationSeconds: snapshot?.durationSeconds ?? null,
    resolution: snapshot?.resolution ?? null,
    aspectOverride: snapshot?.aspectOverride ?? null,
    renderPath: snapshot?.embedding?.renderPath ?? null,
    picture: snapshot?.picture ?? null,
    ...(typeof snapshot?.error === "string" ? { error: snapshot.error } : {}),
    embedding: snapshot?.embedding ?? null,
  };
}

function processMetricEvidence(metric) {
  if (!metric) {
    return null;
  }
  return {
    pid: metric.pid,
    type: metric.type,
    memory: {
      workingSetSize: metric.memory?.workingSetSize ?? null,
      peakWorkingSetSize: metric.memory?.peakWorkingSetSize ?? null,
      privateBytes: metric.memory?.privateBytes ?? null,
    },
  };
}

function compositorProcessEvidence(webContents) {
  const metrics = app.getAppMetrics();
  const rendererPid = webContents.getOSProcessId();
  return {
    renderer: processMetricEvidence(
      metrics.find((metric) => metric.pid === rendererPid),
    ),
    gpu: processMetricEvidence(metrics.find((metric) => metric.type === "GPU")),
  };
}

function requireDirectMetalFrame(snapshot) {
  const renderPath = snapshot?.embedding?.renderPath;
  if (!renderPath?.decodedFrame) {
    throw new Error(
      "The local fixture did not produce a decoded KSPlayer frame before the timeout.",
    );
  }
  if (!renderPath.directMetalActive) {
    throw new Error(
      "The decoded local fixture did not switch to KSPlayer's visible direct-Metal path.",
    );
  }
}

async function waitForDirectMetalFrame(
  probeSessionId = sessionId,
  timeoutMilliseconds = 5_000,
) {
  const deadline = Date.now() + timeoutMilliseconds;
  let latestSnapshot = null;
  while (Date.now() < deadline) {
    latestSnapshot = addon.getSnapshot(probeSessionId);
    if (latestSnapshot?.embedding?.renderPath?.directMetalActive) {
      return latestSnapshot;
    }
    await wait(500);
  }
  const evidence = snapshotEvidence(latestSnapshot);
  throw new Error(
    `Timed out waiting for a decoded direct-Metal frame: ${JSON.stringify(evidence)}`,
  );
}

function playbackState(snapshot) {
  return snapshot?.status ?? snapshot?.state ?? "unavailable";
}

function requireAccepted(result, operation) {
  if (result?.ok === false) {
    throw new Error(result.reason ?? `${operation} was rejected.`);
  }
}

function requireNearPosition(snapshot, target, operation) {
  const position = snapshot?.positionSeconds;
  if (
    typeof position !== "number" ||
    Math.abs(position - target) > seekToleranceSeconds
  ) {
    throw new Error(
      `${operation} did not settle near its target: ${JSON.stringify(
        snapshotEvidence(snapshot),
      )}`,
    );
  }
}

async function waitForSnapshot(
  predicate,
  operation,
  probeSessionId = sessionId,
) {
  const deadline = Date.now() + seekTimeoutMilliseconds;
  let latestSnapshot = null;
  while (Date.now() < deadline) {
    latestSnapshot = addon.getSnapshot(probeSessionId);
    if (predicate(latestSnapshot)) {
      return latestSnapshot;
    }
    await wait(50);
  }
  throw new Error(
    `${operation} timed out: ${JSON.stringify(snapshotEvidence(latestSnapshot))}`,
  );
}

async function requirePositionAdvances(operation) {
  const before = addon.getSnapshot(sessionId);
  await wait(500);
  const after = addon.getSnapshot(sessionId);
  if (
    playbackState(after) !== "playing" ||
    typeof before?.positionSeconds !== "number" ||
    typeof after?.positionSeconds !== "number" ||
    after.positionSeconds <= before.positionSeconds + 0.05
  ) {
    throw new Error(
      `${operation} did not resume advancing after seek: ${JSON.stringify({
        before: snapshotEvidence(before),
        after: snapshotEvidence(after),
      })}`,
    );
  }
  return { before: snapshotEvidence(before), after: snapshotEvidence(after) };
}

async function exercisePictureAdjustments() {
  const controls = addon.getSupportedControls(sessionId);
  if (controls?.pictureAdjustments !== true) {
    throw new Error("Native runtime did not advertise picture adjustments.");
  }
  const changed = {
    brightness: 25,
    contrast: -20,
    blackLevel: 12,
    saturation: 30,
    gamma: -10,
  };
  requireAccepted(
    addon.setPicture(sessionId, JSON.stringify(changed)),
    "set picture",
  );
  const afterChange = addon.getSnapshot(sessionId);
  if (
    !Object.entries(changed).every(
      ([key, value]) => afterChange?.picture?.[key] === value,
    )
  ) {
    throw new Error(
      `Picture snapshot did not update: ${JSON.stringify(afterChange?.picture)}`,
    );
  }
  const advancing = await requirePositionAdvances("picture adjustment");
  requireAccepted(
    addon.setPicture(
      sessionId,
      JSON.stringify({
        brightness: 0,
        contrast: 0,
        blackLevel: 0,
        saturation: 0,
        gamma: 0,
      }),
    ),
    "reset picture",
  );
  const afterReset = addon.getSnapshot(sessionId);
  if (Object.values(afterReset?.picture ?? {}).some((value) => value !== 0)) {
    throw new Error(
      `Picture reset did not restore defaults: ${JSON.stringify(afterReset?.picture)}`,
    );
  }
  const invalid = addon.setPicture(
    sessionId,
    JSON.stringify({ ...changed, gamma: 101 }),
  );
  if (invalid?.ok !== false) {
    throw new Error("Out-of-range picture setting was accepted.");
  }
  return {
    controls,
    afterChange: snapshotEvidence(afterChange),
    afterReset: snapshotEvidence(afterReset),
    advancing,
    invalid: operationEvidence(invalid),
  };
}

const aspectPresets = ["no", "16:9", "4:3", "21:9", "2.35:1"];
const aspectRatios = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "21:9": 21 / 9,
  "2.35:1": 2.35,
};

function requireEffectiveDar(snapshot, bounds, aspect, defaultRatio) {
  const frame = snapshot?.embedding?.playerView?.frame;
  const drawable = snapshot?.embedding?.metalLayer?.drawableSize;
  if (frame?.width !== bounds.width || frame?.height !== bounds.height) {
    throw new Error(`Aspect ${aspect} changed outer geometry: ${JSON.stringify({ frame, bounds })}`);
  }
  const expected = aspectRatios[aspect] ?? defaultRatio;
  const actual = drawable?.width / drawable?.height;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.08) {
    throw new Error(`Aspect ${aspect} did not update Metal drawable DAR: ${JSON.stringify({ drawable, expected, actual })}`);
  }
}

async function exerciseAspectOverrides(bounds) {
  const controls = addon.getSupportedControls(sessionId);
  if (
    controls?.aspectOverride !== true ||
    typeof addon.setAspect !== "function"
  ) {
    throw new Error(
      "Native runtime did not advertise an aspect override entry point.",
    );
  }
  const defaultSnapshot = addon.getSnapshot(sessionId);
  const defaultDrawable = defaultSnapshot?.embedding?.metalLayer?.drawableSize;
  const defaultRatio = defaultDrawable?.width / defaultDrawable?.height;
  if (!Number.isFinite(defaultRatio)) throw new Error("Missing default Metal drawable DAR.");
  const evidence = [];
  for (const aspect of aspectPresets) {
    requireAccepted(addon.setAspect(sessionId, aspect), `set aspect ${aspect}`);
    const snapshot = await waitForSnapshot(
      (candidate) => candidate?.aspectOverride === aspect,
      `aspect ${aspect} snapshot`,
    );
    requireEffectiveDar(snapshot, bounds, aspect, defaultRatio);
    requireDirectMetalFrame(snapshot);
    evidence.push({
      aspect,
      snapshot: snapshotEvidence(snapshot),
      outerFrame: snapshot.embedding.playerView.frame,
      drawableSize: snapshot.embedding.metalLayer.drawableSize,
    });
  }
  const invalid = addon.setAspect(sessionId, "1.618:1");
  if (invalid?.ok !== false) {
    throw new Error("Invalid arbitrary aspect override was accepted.");
  }
  const advancing = await requirePositionAdvances("aspect override");
  return {
    controls,
    defaultDrawableRatio: defaultRatio,
    presets: evidence,
    invalid: operationEvidence(invalid),
    advancing,
  };
}

async function exercisePausedAspectRefresh(bounds) {
  requireAccepted(addon.setPaused(sessionId, true), "pause before aspect refresh");
  await waitForSnapshot(
    (snapshot) => playbackState(snapshot) === "paused",
    "pause before aspect refresh",
  );
  const aspect = "4:3";
  requireAccepted(addon.setAspect(sessionId, aspect), "paused aspect refresh");
  const refreshed = await waitForSnapshot(
    (snapshot) =>
      playbackState(snapshot) === "paused" && snapshot?.aspectOverride === aspect,
    "paused aspect snapshot",
  );
  requireEffectiveDar(refreshed, bounds, aspect, 1);
  requireDirectMetalFrame(refreshed);
  requireAccepted(addon.setPaused(sessionId, false), "resume after aspect refresh");
  await waitForSnapshot(
    (snapshot) => playbackState(snapshot) === "playing",
    "resume after aspect refresh",
  );
  const advancing = await requirePositionAdvances("paused aspect refresh");
  return { refreshed: snapshotEvidence(refreshed), outerFrame: refreshed.embedding.playerView.frame, drawableSize: refreshed.embedding.metalLayer.drawableSize, advancing };
}

function seekTarget(duration, fraction) {
  if (!Number.isFinite(duration) || duration < 3) {
    throw new Error(
      `Seek fixture must expose a finite duration of at least 3 seconds; received ${duration}.`,
    );
  }
  return Math.min(Math.max(0.5, duration * fraction), duration - 0.5);
}

function createAndLoadProbe(probeSessionId, nativeHandle, bounds) {
  const created = addon.createSession(probeSessionId, nativeHandle, bounds);
  if (created?.ok === false) {
    throw new Error(
      created.reason ?? `${probeSessionId} createSession failed.`,
    );
  }
  const loaded = addon.load(
    probeSessionId,
    pathToFileURL(fixturePath).href,
    {},
  );
  if (loaded?.ok === false) {
    throw new Error(loaded.reason ?? `${probeSessionId} load failed.`);
  }
}

async function exerciseSeekTimeoutRecovery(nativeHandle, duration) {
  let probeCreated = false;
  try {
    createAndLoadProbe(timeoutProbeSessionId, nativeHandle, firstBounds);
    probeCreated = true;
    await waitForDirectMetalFrame(timeoutProbeSessionId);

    const supersededTarget = seekTarget(duration, 0.55);
    const recoveryTarget = seekTarget(duration, 0.7);
    requireAccepted(
      addon.seek(timeoutProbeSessionId, supersededTarget),
      "timeout recovery seek",
    );
    requireAccepted(
      addon.seek(timeoutProbeSessionId, recoveryTarget),
      "queued timeout recovery seek",
    );
    const recovered = await waitForSnapshot(
      (snapshot) =>
        playbackState(snapshot) === "playing" &&
        String(snapshot?.error ?? "").includes("seek timed out") &&
        snapshot?.seekTestEvidence?.timeoutRecoveryCount === 1 &&
        snapshot?.seekTestEvidence?.lastRecoveryTarget === recoveryTarget &&
        Number.isFinite(snapshot.positionSeconds) &&
        Math.abs(snapshot.positionSeconds - recoveryTarget) <= seekToleranceSeconds,
      "seek timeout recovery",
      timeoutProbeSessionId,
    );
    const recoveredAdvanceBefore = addon.getSnapshot(timeoutProbeSessionId);
    await wait(500);
    const recoveredAdvanceAfter = addon.getSnapshot(timeoutProbeSessionId);
    if (
      playbackState(recoveredAdvanceAfter) !== "playing" ||
      !Number.isFinite(recoveredAdvanceBefore.positionSeconds) ||
      !Number.isFinite(recoveredAdvanceAfter.positionSeconds) ||
      recoveredAdvanceAfter.positionSeconds <=
        recoveredAdvanceBefore.positionSeconds + 0.05
    ) {
      throw new Error(
        `Timeout recovery did not resume from the requested target: ${JSON.stringify({
          before: snapshotEvidence(recoveredAdvanceBefore),
          after: snapshotEvidence(recoveredAdvanceAfter),
        })}`,
      );
    }

    // The delayed callback is guaranteed to be delivered after recovery. Its
    // generation is stale, so the recovery message/state must remain intact.
    await wait(testLateCompletionDelayMilliseconds + 150);
    const afterLateCallback = addon.getSnapshot(timeoutProbeSessionId);
    const evidence = afterLateCallback?.seekTestEvidence;
    if (
      evidence?.timeoutRecoveryCount !== 1 ||
      evidence?.ignoredCompletionCount !== 1 ||
      !String(afterLateCallback?.error ?? "").includes("seek timed out") ||
      playbackState(afterLateCallback) !== "playing" ||
      !Number.isFinite(afterLateCallback.positionSeconds) ||
      afterLateCallback.positionSeconds <
        recoveryTarget - seekToleranceSeconds
    ) {
      throw new Error(
        `Late timeout callback was not suppressed: ${JSON.stringify({
          recovered: snapshotEvidence(recovered),
          afterLateCallback: snapshotEvidence(afterLateCallback),
          seekTestEvidence: evidence ?? null,
        })}`,
      );
    }

    return {
      configuredTimeoutMilliseconds: testSeekTimeoutMilliseconds,
      configuredLateCompletionDelayMilliseconds:
        testLateCompletionDelayMilliseconds,
      supersededTarget,
      recoveryTarget,
      timeoutRecoveryObserved: true,
      recovered: snapshotEvidence(recovered),
      recoveredAdvance: {
        before: snapshotEvidence(recoveredAdvanceBefore),
        after: snapshotEvidence(recoveredAdvanceAfter),
      },
      afterLateCallback: snapshotEvidence(afterLateCallback),
      seekTestEvidence: evidence,
      lateCompletionIgnored: evidence.ignoredCompletionCount === 1,
    };
  } finally {
    if (probeCreated) {
      addon.disposeSession(timeoutProbeSessionId);
    }
  }
}

async function exerciseDisposedLateCompletion(nativeHandle, duration) {
  let probeCreated = false;
  try {
    createAndLoadProbe(disposeProbeSessionId, nativeHandle, secondBounds);
    probeCreated = true;
    await waitForDirectMetalFrame(disposeProbeSessionId);
    requireAccepted(
      addon.seek(disposeProbeSessionId, seekTarget(duration, 0.6)),
      "disposed-session seek",
    );

    requireAccepted(
      addon.disposeSession(disposeProbeSessionId),
      "dispose during pending seek",
    );
    probeCreated = false;
    await wait(testLateCompletionDelayMilliseconds + 150);

    const afterLateCallback = addon.getSnapshot(disposeProbeSessionId);
    const diagnostic = addon.getEmbeddingDiagnostic(disposeProbeSessionId);
    const evidence = afterLateCallback?.seekTestEvidence;
    if (
      !String(afterLateCallback?.error ?? "").includes(
        "session was not found",
      ) ||
      evidence?.ignoredCompletionCount !== 1 ||
      diagnostic?.phase !== "disposed"
    ) {
      throw new Error(
        `Late disposed-session callback revived state: ${JSON.stringify({
          afterLateCallback: snapshotEvidence(afterLateCallback),
          seekTestEvidence: evidence ?? null,
          diagnostic,
        })}`,
      );
    }

    return {
      configuredLateCompletionDelayMilliseconds:
        testLateCompletionDelayMilliseconds,
      disposedBeforeLateCompletion: true,
      afterLateCallback: snapshotEvidence(afterLateCallback),
      seekTestEvidence: evidence,
      lateCompletionIgnored: evidence.ignoredCompletionCount === 1,
      disposedDiagnostic: diagnostic,
    };
  } finally {
    if (probeCreated) {
      addon.disposeSession(disposeProbeSessionId);
    }
  }
}

async function exerciseSeekRecovery(duration) {
  const playingTarget = seekTarget(duration, 0.25);
  requireAccepted(addon.seek(sessionId, playingTarget), "playing seek");
  const afterPlayingSeek = await waitForSnapshot(
    (snapshot) =>
      playbackState(snapshot) === "playing" &&
      typeof snapshot?.positionSeconds === "number" &&
      Math.abs(snapshot.positionSeconds - playingTarget) <=
        seekToleranceSeconds,
    "playing seek",
  );
  const playingAdvance = await requirePositionAdvances("playing seek");

  requireAccepted(addon.setPaused(sessionId, true), "pause before seek");
  await waitForSnapshot(
    (snapshot) => playbackState(snapshot) === "paused",
    "pause before seek",
  );
  const pausedTarget = seekTarget(duration, 0.5);
  requireAccepted(addon.seek(sessionId, pausedTarget), "paused seek");
  const afterPausedSeek = await waitForSnapshot(
    (snapshot) =>
      playbackState(snapshot) === "paused" &&
      typeof snapshot?.positionSeconds === "number" &&
      Math.abs(snapshot.positionSeconds - pausedTarget) <= seekToleranceSeconds,
    "paused seek",
  );
  const pausedBefore = afterPausedSeek.positionSeconds;
  await wait(500);
  const pausedAfter = addon.getSnapshot(sessionId);
  if (
    playbackState(pausedAfter) !== "paused" ||
    typeof pausedAfter?.positionSeconds !== "number" ||
    Math.abs(pausedAfter.positionSeconds - pausedBefore) > 0.15
  ) {
    throw new Error(
      `Paused seek unexpectedly resumed playback: ${JSON.stringify({
        before: snapshotEvidence(afterPausedSeek),
        after: snapshotEvidence(pausedAfter),
      })}`,
    );
  }

  requireAccepted(
    addon.setPaused(sessionId, false),
    "resume before rapid seeks",
  );
  await waitForSnapshot(
    (snapshot) => playbackState(snapshot) === "playing",
    "resume before rapid seeks",
  );
  const rapidTargets = [0.7, 0.35, 0.8].map((fraction) =>
    seekTarget(duration, fraction),
  );
  rapidTargets.forEach((target) =>
    requireAccepted(addon.seek(sessionId, target), "rapid seek"),
  );
  const finalTarget = rapidTargets.at(-1);
  const afterRapidSeek = await waitForSnapshot(
    (snapshot) =>
      playbackState(snapshot) === "playing" &&
      typeof snapshot?.positionSeconds === "number" &&
      Math.abs(snapshot.positionSeconds - finalTarget) <= seekToleranceSeconds,
    "rapid seek final target",
  );
  const rapidAdvance = await requirePositionAdvances("rapid seek");

  const invalidSeek = addon.seek(sessionId, Number.NaN);
  if (
    invalidSeek?.ok !== false ||
    !String(invalidSeek.reason ?? "").includes("finite")
  ) {
    throw new Error(
      `Invalid seek did not return the native failure contract: ${JSON.stringify(invalidSeek)}`,
    );
  }

  return {
    afterPlayingSeek: snapshotEvidence(afterPlayingSeek),
    playingAdvance,
    afterPausedSeek: snapshotEvidence(afterPausedSeek),
    afterRapidSeek: snapshotEvidence(afterRapidSeek),
    rapidAdvance,
    invalidSeek: operationEvidence(invalidSeek),
  };
}

async function exerciseNativeBounds() {
  for (let index = 0; index < boundsChurnIterations; index += 1) {
    const result = addon.setBounds(
      sessionId,
      index % 2 === 0 ? firstBounds : secondBounds,
    );
    if (result?.ok === false) {
      throw new Error(
        result.reason ?? "setBounds failed during native churn probe.",
      );
    }
    // Yield to the AppKit and Chromium run loops between changes. This
    // exercises native layer geometry updates without executing JavaScript
    // in the renderer or turning the probe into an IPC flood.
    await wait(40);
  }
}

function requireHierarchy(diagnostic, requestedBounds, phase) {
  if (!diagnostic?.available || diagnostic.phase !== phase) {
    throw new Error(
      "Live embedding diagnostic was unavailable or in the wrong phase.",
    );
  }
  if (!diagnostic.ok) {
    throw new Error(
      diagnostic.reason ??
        "Live embedding diagnostic reported an invalid hierarchy.",
    );
  }
  if (
    diagnostic.requestedBounds?.x !== requestedBounds.x ||
    diagnostic.requestedBounds?.y !== requestedBounds.y ||
    diagnostic.requestedBounds?.width !== requestedBounds.width ||
    diagnostic.requestedBounds?.height !== requestedBounds.height
  ) {
    throw new Error(
      "Native requested bounds did not match the Electron harness bounds.",
    );
  }
  if (diagnostic.container?.superview?.role !== "electron-content-view") {
    throw new Error(
      "Dedicated container was not attached directly to Electron content view.",
    );
  }
  if (diagnostic.playerView?.superview?.role !== "player-container") {
    throw new Error(
      "KSPlayer view was not attached inside the dedicated container.",
    );
  }
  if (
    diagnostic.playerView?.frame?.x !== diagnostic.container?.bounds?.x ||
    diagnostic.playerView?.frame?.y !== diagnostic.container?.bounds?.y ||
    diagnostic.playerView?.frame?.width !==
      diagnostic.container?.bounds?.width ||
    diagnostic.playerView?.frame?.height !==
      diagnostic.container?.bounds?.height
  ) {
    throw new Error(
      "KSPlayer view did not fill the dedicated container bounds.",
    );
  }
  if (!diagnostic.metalLayer) {
    throw new Error("KSPlayer hierarchy did not expose a CAMetalLayer.");
  }
}

async function run() {
  if (!existsSync(fixturePath)) {
    throw new Error(`Missing local KSPlayer fixture: ${fixturePath}`);
  }

  app.setPath(
    "userData",
    path.join(os.tmpdir(), `arm-nator-ksplayer-metal-harness-${process.pid}`),
  );
  await app.whenReady();

  const synthetic = addon.diagnoseEmbedding();
  if (synthetic?.ok !== true) {
    throw new Error(
      synthetic?.reason ?? "Synthetic embedding diagnostic failed.",
    );
  }

  const window = new BrowserWindow({
    width: 1_000,
    height: 700,
    show: true,
    webPreferences: {
      backgroundThrottling: false,
    },
  });
  let sessionCreated = false;
  const rendererProcessGone = [];
  let rendererUnresponsiveCount = 0;

  window.webContents.on("render-process-gone", (_event, details) => {
    rendererProcessGone.push({
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
  window.webContents.on("unresponsive", () => {
    rendererUnresponsiveCount += 1;
  });

  try {
    await window.loadURL(
      "data:text/html;charset=utf-8," +
        encodeURIComponent(
          '<!doctype html><html><body style="margin:0;background:#fafafa"><main>Electron host remains active</main></body></html>',
        ),
    );
    await wait(250);

    const nativeHandle = window.getNativeWindowHandle();
    const created = addon.createSession(sessionId, nativeHandle, firstBounds);
    if (created?.ok === false) {
      throw new Error(created.reason ?? "createSession failed.");
    }
    sessionCreated = true;

    const loaded = addon.load(sessionId, pathToFileURL(fixturePath).href, {});
    if (loaded?.ok === false) {
      throw new Error(loaded.reason ?? "load failed.");
    }

    const afterLoad = snapshotEvidence(await waitForDirectMetalFrame());
    requireHierarchy(afterLoad.embedding, firstBounds, "attached");
    requireDirectMetalFrame(afterLoad);
    const pictureAdjustments = await exercisePictureAdjustments();

    const beforeBoundsChurn = compositorProcessEvidence(window.webContents);
    await exerciseNativeBounds();

    const afterBounds = snapshotEvidence(await waitForDirectMetalFrame());
    requireHierarchy(afterBounds.embedding, secondBounds, "attached");
    requireDirectMetalFrame(afterBounds);
    const aspectOverrides = await exerciseAspectOverrides(secondBounds);
    const pausedAspectRefresh = await exercisePausedAspectRefresh(secondBounds);
    const afterBoundsChurn = compositorProcessEvidence(window.webContents);
    const seekTimeoutRecovery = await exerciseSeekTimeoutRecovery(
      nativeHandle,
      afterBounds.durationSeconds,
    );
    const seekRecovery = await exerciseSeekRecovery(
      afterBounds.durationSeconds,
    );
    const disposedLateCompletion = await exerciseDisposedLateCompletion(
      nativeHandle,
      afterBounds.durationSeconds,
    );

    if (rendererProcessGone.length > 0) {
      throw new Error(
        `Renderer exited during native local-fixture playback: ${JSON.stringify(rendererProcessGone)}`,
      );
    }
    if (rendererUnresponsiveCount > 0) {
      throw new Error(
        "Renderer became unresponsive during native local-fixture playback.",
      );
    }

    // Dispose while a new seek is still pending. The runtime's generation
    // guard must make the later KSPlayer completion a no-op rather than
    // reviving a detached session.
    requireAccepted(
      addon.seek(sessionId, seekTarget(afterBounds.durationSeconds, 0.6)),
      "dispose-race seek",
    );
    const disposed = addon.disposeSession(sessionId);
    if (disposed?.ok === false) {
      throw new Error(disposed.reason ?? "disposeSession failed.");
    }
    sessionCreated = false;
    await wait(100);

    const afterDispose = addon.getEmbeddingDiagnostic(sessionId);
    if (
      !afterDispose?.available ||
      afterDispose.phase !== "disposed" ||
      !afterDispose.ok ||
      afterDispose.childCounts?.containerAfterPlayerDispose !== 0 ||
      afterDispose.childCounts?.hostBeforeAttach !==
        afterDispose.childCounts?.hostAfterDispose
    ) {
      throw new Error(
        afterDispose?.reason ??
          "Live teardown diagnostic did not restore the host child count.",
      );
    }

    // Output only geometry and state evidence. The fixture URL and any
    // headers deliberately never appear in this diagnostic report.
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        electronNativeHandleBytes: nativeHandle.length,
        synthetic,
        afterLoad,
        afterBounds,
        pictureAdjustments,
        aspectOverrides,
        pausedAspectRefresh,
        seekTimeoutRecovery,
        seekRecovery,
        disposedLateCompletion,
        compositorProbe: {
          boundsChurnIterations,
          rendererProcessGone,
          rendererUnresponsiveCount,
          beforeBoundsChurn,
          afterBoundsChurn,
        },
        afterDispose,
      })}\n`,
    );
  } finally {
    if (sessionCreated) {
      try {
        addon.disposeSession(sessionId);
      } catch {
        // The harness still closes its own Electron window on failure.
      }
    }
    if (!window.isDestroyed()) {
      window.destroy();
    }
    app.quit();
  }
}

run().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  app.quit();
  process.exitCode = 1;
});
