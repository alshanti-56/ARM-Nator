import assert from "node:assert/strict";
import { test } from "node:test";
import "@angular/compiler";
import {
  isKnownAudioOnlySourceUrl,
  readBrowserPlaybackEvidence,
} from "./playback-evidence";

test("reads presented video frames and confirms audio-only after media data exists", () => {
  const video = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 42 }),
  } as unknown as HTMLVideoElement;

  assert.deepEqual(readBrowserPlaybackEvidence(video), {
    presentedFrames: 42,
    audioOnly: false,
    muted: false,
  });
});

test("does not count dropped browser frames as presented evidence", () => {
  const video = {
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    getVideoPlaybackQuality: () => ({
      totalVideoFrames: 42,
      droppedVideoFrames: 40,
    }),
  } as unknown as HTMLVideoElement;

  assert.deepEqual(readBrowserPlaybackEvidence(video), {
    presentedFrames: 2,
    audioOnly: false,
    muted: false,
  });
});

test("does not call an unready media element audio-only", () => {
  const video = {
    readyState: 1,
    videoWidth: 0,
    videoHeight: 0,
    muted: false,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }),
  } as unknown as HTMLVideoElement;

  assert.deepEqual(readBrowserPlaybackEvidence(video), {
    presentedFrames: 0,
    muted: false,
  });
});

test("identifies ready audio-only elements and omits unavailable frame counts", () => {
  const video = {
    readyState: 2,
    videoWidth: 0,
    videoHeight: 0,
    muted: true,
  } as unknown as HTMLVideoElement;

  assert.deepEqual(readBrowserPlaybackEvidence(video), {
    audioOnly: true,
    muted: true,
  });
});

test("ignores invalid quality counters and media API failures", () => {
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: Number.NaN }),
  } as unknown as HTMLVideoElement;
  assert.deepEqual(readBrowserPlaybackEvidence(video), { audioOnly: false });

  const brokenVideo = {
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    getVideoPlaybackQuality: () => {
      throw new Error("quality unavailable");
    },
  } as unknown as HTMLVideoElement;
  assert.deepEqual(readBrowserPlaybackEvidence(brokenVideo), {});
});

test("recognizes only explicit audio media extensions as native audio-only sources", () => {
  assert.equal(isKnownAudioOnlySourceUrl("https://media.example/live?id=4&ext=mp3"), true);
  assert.equal(isKnownAudioOnlySourceUrl("https://media.example/movie.m3u8"), false);
  assert.equal(isKnownAudioOnlySourceUrl("https://media.example/stream"), false);
});
