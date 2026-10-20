import assert from "node:assert/strict";
import test from "node:test";
import { VodSeekController } from "./vod-seek-controller";
test("replacement VOD resume respects seekable range even when duration is longer", () => {
  const video = new EventTarget() as HTMLVideoElement;
  Object.defineProperties(video, {
    currentTime: { value: 0, writable: true },
    seekable: { value: { length: 1, start: () => 10, end: () => 80 } },
  });
  let actual = -1;
  const seek = new VodSeekController({
    video,
    getStartTime: () => 95,
    getDuration: () => 100,
    seek: (value) => {
      actual = value;
      video.currentTime = value;
    },
  });
  try {
    seek.requestStartTime();
    assert.equal(actual, 80);
  } finally {
    seek.destroy();
  }
});
