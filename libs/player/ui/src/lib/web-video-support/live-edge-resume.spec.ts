import { strict as assert } from "node:assert";
import { test } from "node:test";
import { seekVideoToLiveEdge } from "./live-edge-resume";

function createVideo(
  ranges: readonly (readonly [number, number])[],
  currentTime = 0,
): HTMLMediaElement {
  return {
    currentTime,
    seekable: {
      length: ranges.length,
      start: (index: number) => ranges[index][0],
      end: (index: number) => ranges[index][1],
    },
  } as unknown as HTMLMediaElement;
}

test("uses the engine-provided safe live position when available", () => {
  const video = createVideo([[10, 30]], 12);

  assert.equal(seekVideoToLiveEdge(video, 26), true);
  assert.equal(video.currentTime, 26);
});

test("falls back to the end of the newest seekable live range", () => {
  const video = createVideo([
    [0, 10],
    [20, 40],
  ]);

  assert.equal(seekVideoToLiveEdge(video), true);
  assert.ok(Math.abs(video.currentTime - 39.9) < 0.000_001);
});

test("leaves playback unchanged when no live range is available", () => {
  const video = createVideo([], 12);

  assert.equal(seekVideoToLiveEdge(video), false);
  assert.equal(video.currentTime, 12);
});
