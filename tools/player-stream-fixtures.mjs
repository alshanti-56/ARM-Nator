import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const host = "127.0.0.1";
const port = Number(process.env.ARM_NATOR_FIXTURE_PORT || 9876);
const fixtureRoot = await mkdtemp(join(tmpdir(), "arm-nator-streams-"));
const transportStreamPath = join(fixtureRoot, "sample.ts");

const ffmpeg = spawnSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=960x540:rate=25",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=1000:sample_rate=48000",
    "-t",
    "8",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "50",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "mpegts",
    "-y",
    transportStreamPath,
  ],
  { encoding: "utf8" },
);

if (ffmpeg.status !== 0) {
  await rm(fixtureRoot, { recursive: true, force: true });
  throw new Error(`FFmpeg fixture generation failed:\n${ffmpeg.stderr}`);
}

const transportStream = await readFile(transportStreamPath);
const hlsManifestPath = join(fixtureRoot, "vod.m3u8");
const hls = spawnSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    transportStreamPath,
    "-c",
    "copy",
    "-hls_time",
    "2",
    "-hls_list_size",
    "0",
    "-hls_segment_filename",
    join(fixtureRoot, "segment-%03d.ts"),
    "-y",
    hlsManifestPath,
  ],
  { encoding: "utf8" },
);

if (hls.status !== 0) {
  await rm(fixtureRoot, { recursive: true, force: true });
  throw new Error(`FFmpeg HLS generation failed:\n${hls.stderr}`);
}

const vodManifest = await readFile(hlsManifestPath, "utf8");
const liveManifest = vodManifest.replace("#EXT-X-ENDLIST", "");
const hlsSegments = new Map();
for (const name of await readdir(fixtureRoot)) {
  if (name.startsWith("segment-") && name.endsWith(".ts")) {
    hlsSegments.set(`/${name}`, await readFile(join(fixtureRoot, name)));
  }
}

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Cache-Control", "no-store");

  switch (request.url) {
    case "/vod.ts":
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Content-Length": transportStream.length,
      });
      response.end(transportStream);
      return;

    case "/live-close.ts":
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Transfer-Encoding": "chunked",
      });
      writePaced(response, transportStream, 8_000, () => response.end());
      return;

    case "/live.ts":
      response.writeHead(200, {
        "Content-Type": "video/mp2t",
        "Transfer-Encoding": "chunked",
      });
      writeLoop(response, transportStream);
      return;

    case "/vod.m3u8":
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end(vodManifest);
      return;

    case "/live.m3u8":
      response.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
      });
      response.end(liveManifest);
      return;

    case "/":
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          {
            vod: `http://${host}:${port}/vod.ts`,
            live: `http://${host}:${port}/live.ts`,
            reconnect: `http://${host}:${port}/live-close.ts`,
            hlsVod: `http://${host}:${port}/vod.m3u8`,
            hlsLive: `http://${host}:${port}/live.m3u8`,
          },
          null,
          2,
        ),
      );
      return;

    default:
      if (request.url && hlsSegments.has(request.url)) {
        const segment = hlsSegments.get(request.url);
        response.writeHead(200, {
          "Content-Type": "video/mp2t",
          "Content-Length": segment.length,
        });
        response.end(segment);
        return;
      }
      response.writeHead(404).end();
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    [
      "ARM-Nator player fixtures ready:",
      `  VOD:           http://${host}:${port}/vod.ts`,
      `  Live:          http://${host}:${port}/live.ts`,
      `  EOF/reconnect: http://${host}:${port}/live-close.ts`,
      `  HLS VOD:       http://${host}:${port}/vod.m3u8`,
      `  HLS live:      http://${host}:${port}/live.m3u8`,
      "",
      "Press Ctrl+C to stop.",
    ].join("\n") + "\n",
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => {
      void rm(fixtureRoot, { recursive: true, force: true }).finally(() =>
        process.exit(0),
      );
    });
  });
}

function writeLoop(response, buffer) {
  let closed = false;
  response.on("close", () => {
    closed = true;
  });
  const send = () => {
    if (closed) {
      return;
    }
    writePaced(response, buffer, 8_000, send);
  };
  send();
}

function writePaced(response, buffer, durationMs, done) {
  const chunkSize = Math.max(188, Math.ceil(buffer.length / 80 / 188) * 188);
  const intervalMs = durationMs / Math.ceil(buffer.length / chunkSize);
  let offset = 0;
  const timer = setInterval(() => {
    if (response.destroyed || offset >= buffer.length) {
      clearInterval(timer);
      if (!response.destroyed) {
        done();
      }
      return;
    }
    const end = Math.min(buffer.length, offset + chunkSize);
    response.write(buffer.subarray(offset, end));
    offset = end;
  }, intervalMs);
  response.on("close", () => clearInterval(timer));
}
