import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectMediaPrefix,
  inspectResponseForMedia,
  MediaInspectionError,
} from "./media-response-inspection";

function tsPackets(count = 3): Buffer {
  const bytes = Buffer.alloc(count * 188, 0xff);
  for (let offset = 0; offset < bytes.length; offset += 188) {
    bytes[offset] = 0x47;
  }
  return bytes;
}

test("media signatures take priority over a misleading content type and URL", () => {
  const result = inspectMediaPrefix(
    Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:4\n"),
    "video/mp4",
    "https://provider.example/movie.mp4",
  );

  assert.deepEqual(result, {
    format: "hls",
    container: "hls",
    mimeType: "video/mp4",
  });
});

test("media signature inspection recognizes TS, MP4, WebM, and Matroska bytes", () => {
  assert.equal(
    inspectMediaPrefix(tsPackets(), "application/octet-stream", "https://p.example/live").format,
    "mpegts",
  );
  assert.deepEqual(
    inspectMediaPrefix(Buffer.from("\0\0\0\x18ftypisom"), null, "https://p.example/live"),
    { format: "progressive", container: "mp4" },
  );
  assert.deepEqual(
    inspectMediaPrefix(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]),
      null,
      "https://p.example/live",
    ),
    { format: "progressive", container: "webm" },
  );
  assert.deepEqual(
    inspectMediaPrefix(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x82, 0x88, ...Buffer.from("matroska")]),
      null,
      "https://p.example/live",
    ),
    { format: "progressive", container: "matroska" },
  );
});

test("EBML needs a recognized DocType in its header", () => {
  const prefix = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x87,
    0x42, 0x82, 0x81, 0x78,
    ...Buffer.from(" matroska"),
  ]);

  assert.deepEqual(
    inspectMediaPrefix(prefix, null, "https://p.example/extensionless"),
    { format: "unknown" },
  );
});

test("content type is used before URL suffix when bytes have no known signature", () => {
  assert.deepEqual(
    inspectMediaPrefix(Buffer.from("opaque"), "application/vnd.apple.mpegurl", "https://p.example/no-extension"),
    { format: "hls", container: "hls", mimeType: "application/vnd.apple.mpegurl" },
  );
  assert.deepEqual(
    inspectMediaPrefix(Buffer.from("opaque"), null, "https://p.example/playlist.m3u8"),
    { format: "hls", container: "hls" },
  );
});

test("unions HLS master variant video and audio codecs", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f,mp4a.40.2"',
    "variant-a.m3u8",
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401e,mp4a.40.2"',
    "variant-b.m3u8",
  ].join("\n");

  assert.deepEqual(
    inspectMediaPrefix(Buffer.from(master), "application/vnd.apple.mpegurl", "https://p.example/master", true),
    {
      format: "hls",
      container: "hls",
      mimeType: "application/vnd.apple.mpegurl",
      videoCodecs: ["avc1.64001f", "avc1.4d401e"],
      audioCodecs: ["mp4a.40.2"],
    },
  );
});

test("marks HLS audio-only only when complete codec declarations prove it", () => {
  const audioMaster = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2,ac-3"',
    "audio.m3u8",
  ].join("\n");
  const audioResult = inspectMediaPrefix(Buffer.from(audioMaster), "application/vnd.apple.mpegurl", "https://p.example/master", true);
  assert.deepEqual(audioResult.audioCodecs, ["mp4a.40.2", "ac-3"]);
  assert.equal(audioResult.audioOnly, true);

  const partial = inspectMediaPrefix(Buffer.from(audioMaster), "application/vnd.apple.mpegurl", "https://p.example/master", false);
  assert.equal(partial.audioOnly, undefined);

  const missingCodecs = inspectMediaPrefix(
    Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=192000\naudio.m3u8\n"),
    "application/vnd.apple.mpegurl",
    "https://p.example/master",
    true,
  );
  assert.equal(missingCodecs.audioOnly, undefined);
});

test("does not label AES-128 HLS encryption as DRM but recognizes non-identity key formats", () => {
  const aes128 = inspectMediaPrefix(
    Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-ENDLIST\n'),
    "application/vnd.apple.mpegurl",
    "https://p.example/playlist",
    true,
  );
  assert.notEqual(aes128.encrypted, true);

  const drm = inspectMediaPrefix(
    Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://key"\n'),
    "application/vnd.apple.mpegurl",
    "https://p.example/playlist",
    false,
  );
  assert.equal(drm.encrypted, true);
});

test("extracts DASH adaptation codecs and content protection without guessing from partial prefixes", () => {
  const mpd = '<MPD><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.640028"/><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"/></Period></MPD>';
  const complete = inspectMediaPrefix(Buffer.from(mpd), "application/dash+xml", "https://p.example/manifest", true);
  assert.deepEqual(complete.videoCodecs, ["avc1.640028"]);
  assert.deepEqual(complete.audioCodecs, ["mp4a.40.2"]);
  assert.equal(complete.audioOnly, undefined);

  const partialAudio = inspectMediaPrefix(
    Buffer.from('<MPD><Period><AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"/>'),
    "application/dash+xml",
    "https://p.example/manifest",
    false,
  );
  assert.equal(partialAudio.audioOnly, undefined);

  const encrypted = inspectMediaPrefix(
    Buffer.from('<MPD><Period><ContentProtection schemeIdUri="urn:uuid:test"/>'),
    "application/dash+xml",
    "https://p.example/manifest",
    false,
  );
  assert.equal(encrypted.encrypted, true);
});

test("uses an audio MIME type as explicit audio-only evidence", () => {
  assert.equal(inspectMediaPrefix(Buffer.from("audio bytes"), "audio/aac", "https://p.example/track").audioOnly, true);
});

test("HTML login pages are rejected with the upstream HTTP status", async () => {
  const response = new Response("<!-- provider error -->\n<html><body>login</body></html>", {
    status: 200,
    headers: { "content-type": "video/mp2t" },
  });

  await assert.rejects(
    inspectResponseForMedia(response, "https://p.example/live", { prefixTimeoutMs: 50 }),
    (error: unknown) =>
      error instanceof MediaInspectionError &&
      error.code === "html-response" &&
      error.status === 200,
  );
});

test("recognized media bytes take priority over an HTML content type", async () => {
  const hls = await inspectResponseForMedia(
    new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", {
      headers: { "content-type": "text/html" },
    }),
    "https://p.example/stream",
  );
  assert.equal(hls.media.format, "hls");

  const ts = await inspectResponseForMedia(
    new Response(tsPackets(), { headers: { "content-type": "text/html" } }),
    "https://p.example/stream",
  );
  assert.equal(ts.media.format, "mpegts");
});

test("HTTP denials fail before reading or classifying the body", async () => {
  let bodyCancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    }),
    { status: 403, headers: { "content-type": "application/vnd.apple.mpegurl" } },
  );

  await assert.rejects(
    inspectResponseForMedia(response, "https://p.example/playlist.m3u8", { prefixTimeoutMs: 50 }),
    (error: unknown) =>
      error instanceof MediaInspectionError &&
      error.code === "http-error" &&
      error.status === 403,
  );
  assert.equal(bodyCancelled, true);
});

test("inspection replays bytes already read so the proxy receives the source body once", async () => {
  let pullCount = 0;
  const original = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(Buffer.from("\0\0\0\x18ftypisom"));
        } else {
          controller.enqueue(Buffer.from("tail"));
          controller.close();
        }
      },
    }),
    { headers: { "content-type": "application/octet-stream" } },
  );
  Object.defineProperty(original, "url", { value: "https://p.example/source" });

  const inspected = await inspectResponseForMedia(original, "https://p.example/source", {
    prefixTimeoutMs: 100,
  });

  assert.equal(inspected.media.format, "progressive");
  assert.equal(inspected.response.url, "https://p.example/source");
  assert.equal(await inspected.response.text(), "\0\0\0\x18ftypisomtail");
});

test("inspection extracts metadata from the retained HLS response and replays it unchanged", async () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.64001f,mp4a.40.2"',
    "variant.m3u8",
  ].join("\n");
  const inspected = await inspectResponseForMedia(
    new Response(master, { headers: { "content-type": "application/vnd.apple.mpegurl" } }),
    "https://p.example/master.m3u8",
  );
  assert.deepEqual(inspected.media.videoCodecs, ["avc1.64001f"]);
  assert.deepEqual(inspected.media.audioCodecs, ["mp4a.40.2"]);
  assert.equal(await inspected.response.text(), master);
});

test("bounded HLS prefixes do not claim audio-only when the retained manifest is incomplete", async () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"',
    "audio.m3u8",
    "#EXT-X-VERSION:7",
  ].join("\n");
  const inspected = await inspectResponseForMedia(
    new Response(master, { headers: { "content-type": "application/vnd.apple.mpegurl" } }),
    "https://p.example/master.m3u8",
    { maxPrefixBytes: 72 },
  );

  assert.deepEqual(inspected.media.audioCodecs, ["mp4a.40.2"]);
  assert.equal(inspected.media.audioOnly, undefined);
  assert.equal(await inspected.response.text(), master);
});
