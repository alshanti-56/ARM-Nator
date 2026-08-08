import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKsPlayerMetalControls } from "./ksplayer-metal-controls";

test("normalizes advertised KSPlayer picture controls only with the additive addon method", () => {
  const runtimeControls = { pause: true, pictureAdjustments: true };

  assert.deepEqual(normalizeKsPlayerMetalControls(runtimeControls, true), {
    pause: true,
    seek: false,
    volume: false,
    audioTracks: false,
    subtitles: false,
    playbackSpeed: false,
    displayMode: false,
    aspectOverride: false,
    pictureAdjustments: true,
  });
  assert.equal(
    normalizeKsPlayerMetalControls(runtimeControls, false).pictureAdjustments,
    false,
  );
});

test("normalizes aspect override only when both runtime and addon support it", () => {
  const runtimeControls = { aspectOverride: true };

  assert.equal(
    normalizeKsPlayerMetalControls(runtimeControls, false, true).aspectOverride,
    true,
  );
  assert.equal(
    normalizeKsPlayerMetalControls(runtimeControls, false, false)
      .aspectOverride,
    false,
  );
});
