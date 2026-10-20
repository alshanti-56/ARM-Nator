import assert from "node:assert/strict";
import test from "node:test";
import {
  toAbsolutePlaybackDuration,
  toAbsolutePlaybackPosition,
  toLocalPlaybackPosition,
} from "./playback-timeline";

test("maps local companion time onto the source VOD timeline", () => {
  assert.equal(toAbsolutePlaybackPosition(12, 75), 87);
  assert.equal(toAbsolutePlaybackDuration(30, 75), 105);
});

test("converts absolute seeks to local segment positions and clamps before offset", () => {
  assert.equal(toLocalPlaybackPosition(87, 75), 12);
  assert.equal(toLocalPlaybackPosition(20, 75), 0);
});

test("keeps valid zero-length and unknown durations unknown", () => {
  assert.equal(toAbsolutePlaybackDuration(0, 50), null);
  assert.equal(toAbsolutePlaybackDuration(null, 50), null);
  assert.equal(toAbsolutePlaybackDuration(30, 50, 120), 120);
});
