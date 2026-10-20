import assert from "node:assert/strict";
import test from "node:test";

async function loadUtils() {
  return import("./player-benchmark-utils.mjs").catch(() => null);
}

test("startup percentile uses finite nearest-rank samples", async () => {
  const utils = await loadUtils();
  assert.equal(typeof utils?.empiricalPercentile, "function");
  assert.equal(utils.empiricalPercentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(utils.empiricalPercentile([5, Number.NaN, 1, Infinity], 0.95), 5);
  assert.equal(utils.empiricalPercentile([], 0.95), null);
});

test("each local-file comparison run gets a unique fixture path", async () => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const utils = await loadUtils();
  assert.equal(typeof utils?.createIsolatedFixture, "function");

  const root = mkdtempSync(join(tmpdir(), "player-fixture-isolation-"));
  try {
    const source = join(root, "source.mp4");
    const targetDir = join(root, "runs");
    writeFileSync(source, "fixture-content");

    const first = utils.createIsolatedFixture(source, targetDir, "mpv");
    const second = utils.createIsolatedFixture(source, targetDir, "mpv");

    assert.notEqual(first.path, second.path);
    assert.equal(readFileSync(first.path, "utf8"), "fixture-content");
    assert.equal(readFileSync(second.path, "utf8"), "fixture-content");
    first.cleanup();
    second.cleanup();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seek verification tolerates playback advancing during its sample interval", async () => {
  const utils = await loadUtils();
  assert.equal(typeof utils?.isSettledBackwardSeek, "function");

  const advancedAfterSeek = utils.isSettledBackwardSeek(
    { state: "playing", positionSeconds: 0.75 },
    { state: "playing", positionSeconds: 1.25 },
    0.25,
    6,
    0.25,
  );
  const staleBeforeSeek = utils.isSettledBackwardSeek(
    { state: "playing", positionSeconds: 6 },
    { state: "playing", positionSeconds: 0.75 },
    0.25,
    6,
    0.25,
  );

  assert.equal(advancedAfterSeek.accepted, true);
  assert.equal(staleBeforeSeek.accepted, false);
});

test("comparison paths can select packaged baseline and Stage 1 runtimes", async () => {
  const utils = await loadUtils();
  assert.equal(typeof utils?.resolveNativeReleaseDir, "function");
  assert.equal(
    utils.resolveNativeReleaseDir("/repo", { ARM_NATOR_NATIVE_DIR: "/baseline/native" }),
    "/baseline/native",
  );
  assert.equal(
    utils.resolveNativeReleaseDir("/repo", {}),
    "/repo/apps/electron-backend/native/build/Release",
  );
  assert.equal(utils.resolveFfmpegPath({ ARM_NATOR_FFMPEG: "/bundle/ffmpeg" }), "/bundle/ffmpeg");
  assert.equal(utils.resolveFfmpegPath({}), "ffmpeg");
});

test("verified startup requires video geometry or a selected audio stream", async () => {
  const utils = await loadUtils();
  assert.equal(typeof utils?.isConfirmedStartup, "function");
  const playingVideo = {
    state: "playing",
    durationSeconds: 7,
    positionSeconds: 0.1,
    resolution: { width: 320, height: 180 },
  };
  assert.equal(utils.isConfirmedStartup(playingVideo), true);
  assert.equal(utils.isConfirmedStartup({ ...playingVideo, resolution: null }), false);
  assert.equal(
    utils.isConfirmedStartup({
      state: "playing",
      durationSeconds: 7,
      positionSeconds: 0.1,
      audioTracks: [{ id: 4, selected: true }],
      selectedAudioTrackId: 4,
    }, { audioOnly: true }),
    true,
  );
  assert.equal(
    utils.isConfirmedStartup({
      state: "playing",
      durationSeconds: 7,
      positionSeconds: 0.1,
      audioTracks: [{ id: 4, selected: false }],
      selectedAudioTrackId: null,
    }, { audioOnly: true }),
    false,
  );
});
