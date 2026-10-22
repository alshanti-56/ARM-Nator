import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import { SilentMediaSession } from "./silent-media-session";
class FakeVideo extends EventTarget {
  muted = false;
  playsInline = false;
  tabIndex = 0;
  src = "";
  currentTime = 0;
  readyState = 2;
  paused = true;
  ended = false;
  seeking = false;
  videoWidth = 1280;
  videoHeight = 720;
  frames = 0;
  volume = 1;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    /* Test double intentionally has no side effects. */
  }
  setAttribute() {
    /* Test double intentionally has no side effects. */
  }
  removeAttribute() {
    this.src = "";
  }
  canPlayType() {
    return "probably";
  }
  getVideoPlaybackQuality() {
    return { totalVideoFrames: this.frames, droppedVideoFrames: 0 };
  }
}
test("silent session emits decode telemetry without volume preferences or foreground player", async () => {
  const video = new FakeVideo();
  let tick = () => {
    /* Test double intentionally has no side effects. */
  };
  let stopped = false;
  const samples: unknown[] = [];
  let clock = 0;
  const session = new SilentMediaSession({
    video: video as unknown as HTMLVideoElement,
    now: () => clock,
    every: (fn) => {
      tick = fn;
      return () => {
        stopped = true;
      };
    },
  });
  await session.start(
    { streamUrl: "https://fixture.test/video.mp4", title: "Sample" },
    new AbortController().signal,
    (s) => samples.push(s),
  );
  assert.equal(video.muted, true);
  assert.equal(video.volume, 1);
  video.currentTime = 1;
  video.frames = 30;
  clock = 1000;
  tick();
  assert.equal(
    (samples.at(-1) as { presentedFrames: number }).presentedFrames,
    30,
  );
  await session.close();
  assert.equal(stopped, true);
  assert.equal(video.paused, true);
  assert.equal(video.src, "");
});
