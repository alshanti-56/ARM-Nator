import assert from "node:assert/strict";
import test from "node:test";
import type { AutoPlaybackPreparation } from "@arm-nator/shared/interfaces";
import {
  getPreparedProxyMediaExtension,
  getPreparedProxyMimeType,
  getPreparedProxyPlayerType,
} from "./prepared-proxy-source.util";

test("prepared format metadata drives extensionless player source selection", () => {
  const cases: Array<{
    prepared: AutoPlaybackPreparation;
    extension: string;
    mimeType: string;
    playerType: string;
  }> = [
    {
      prepared: {
        id: "hls",
        url: "http://127.0.0.1/hls/hls",
        format: "hls",
      },
      extension: "m3u8",
      mimeType: "application/x-mpegURL",
      playerType: "m3u8",
    },
    {
      prepared: {
        id: "ts",
        url: "http://127.0.0.1/stream/ts",
        format: "mpegts",
      },
      extension: "ts",
      mimeType: "video/mp2t",
      playerType: "ts",
    },
    {
      prepared: {
        id: "mp4",
        url: "http://127.0.0.1/media/mp4",
        format: "progressive",
        container: "mp4",
      },
      extension: "mp4",
      mimeType: "video/mp4",
      playerType: "mp4",
    },
  ];

  for (const item of cases) {
    assert.equal(getPreparedProxyMediaExtension(item.prepared), item.extension);
    assert.equal(getPreparedProxyMimeType(item.prepared), item.mimeType);
    assert.equal(getPreparedProxyPlayerType(item.prepared), item.playerType);
  }
});

test("progressive response MIME supplies a container when the proxy omits one", () => {
  const prepared: AutoPlaybackPreparation = {
    id: "webm",
    url: "http://127.0.0.1/media/webm",
    format: "progressive",
    mimeType: "video/webm; codecs=vp9",
  };

  assert.equal(getPreparedProxyMediaExtension(prepared), "webm");
  assert.equal(getPreparedProxyMimeType(prepared), "video/webm; codecs=vp9");
  assert.equal(getPreparedProxyPlayerType(prepared), "webm");
});

test("inspected format and container override misleading wire MIME types", () => {
  for (const mimeType of ["application/octet-stream", "text/html; charset=utf-8"]) {
    assert.equal(
      getPreparedProxyMimeType({
        id: "mp4",
        url: "http://127.0.0.1/media/mp4",
        format: "progressive",
        container: "mp4",
        mimeType,
      }),
      "video/mp4",
    );
  }

  assert.equal(
    getPreparedProxyMimeType({
      id: "hls",
      url: "http://127.0.0.1/hls/hls",
      format: "hls",
      mimeType: "application/octet-stream",
    }),
    "application/x-mpegURL",
  );
  assert.equal(
    getPreparedProxyMimeType({
      id: "webm",
      url: "http://127.0.0.1/media/webm",
      format: "progressive",
      container: "webm",
      mimeType: 'video/mp4; codecs="avc1.640028"',
    }),
    "video/webm",
  );
});
