import assert from "node:assert/strict";
import test from "node:test";
import {
  readProviderSeekPreviews,
  parseSeekPreviewVtt,
  seekPreviewAt,
} from "./seek-previews";
test("recognizes only explicit preview metadata, never posters or stream URLs", () => {
  assert.equal(
    readProviderSeekPreviews({
      movie_image: "https://fixture/poster.jpg",
      url: "https://fixture/movie.mp4",
    }),
    undefined,
  );
  assert.equal(
    readProviderSeekPreviews({ thumbnails_vtt: "https://fixture/previews.vtt" })
      ?.vttUrl,
    "https://fixture/previews.vtt",
  );
  assert.equal(
    readProviderSeekPreviews({ thumbnails_vtt: "https://fixture/movie.mp4" }),
    undefined,
  );
});
test("parses WebVTT image cues and crops relative sprite URLs; skips video payloads and malformed ranges", () => {
  const cues = parseSeekPreviewVtt(
    "WEBVTT\n\n00:00.000 --> 00:10.000\nsprite.jpg#xywh=0,0,160,90\n\n00:10.000 --> 00:20.000\nsprite.jpg#xywh=160,0,160,90\n\n00:20.000 --> 00:15.000\nmovie.mp4\n",
    "https://fixture/frames/index.vtt",
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[1].url, "https://fixture/frames/sprite.jpg");
  assert.deepEqual(cues[1].crop, { x: 160, y: 0, width: 160, height: 90 });
  assert.equal(seekPreviewAt(cues, 10)?.crop?.x, 160);
  assert.equal(seekPreviewAt(cues, 21), null);
});
test("sprite metadata maps only its advertised interval with bounded image geometry", () => {
  const source = readProviderSeekPreviews({
    thumbnails: {
      url: "https://fixture/sprite.jpg",
      number: 4,
      column: 2,
      width: 160,
      height: 90,
    },
  })!;
  assert.deepEqual(seekPreviewAt(source, 75, 100)?.crop, {
    x: 160,
    y: 90,
    width: 160,
    height: 90,
  });
  assert.equal(
    readProviderSeekPreviews({
      thumbnails: {
        url: "https://fixture/movie.mp4",
        number: 4,
        column: 2,
        width: 160,
        height: 90,
      },
    }),
    undefined,
  );
});
