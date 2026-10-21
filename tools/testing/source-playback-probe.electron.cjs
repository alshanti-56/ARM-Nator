/* Real Chromium decoder acceptance: local fixtures only, no saved accounts or app profile. */
const { app, BrowserWindow } = require("electron");
const {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const http = require("node:http");
const assert = require("node:assert/strict");
const { build } = require("esbuild");
const temp = mkdtempSync(join(tmpdir(), "arm-source-check-"));
app.setPath("userData", join(temp, "profile"));
let window, server;
let inFlight = 0;
(async () => {
  const media = join(temp, "sample.mp4");
  const ffmpeg =
    process.env.ARM_NATOR_FFMPEG ??
    [
      "apps/electron-backend/native/build/Release/ffmpeg",
      "vendor/embedded-mpv/darwin-arm64/bin/ffmpeg",
    ]
      .map((p) => resolve(p))
      .find((p) => existsSync(p)) ??
    "ffmpeg";
  const encoders =
    spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" })
      .stdout ?? "";
  const encoder = encoders.includes("libx264")
    ? "libx264"
    : "h264_videotoolbox";
  const generated = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=160x90:rate=24",
      "-t",
      "14",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      encoder,
      "-movflags",
      "+faststart",
      "-an",
      media,
    ],
    { encoding: "utf8" },
  );
  if (generated.status !== 0)
    throw Error(
      "FFmpeg fixture generation failed: " +
        (generated.error?.message ?? generated.stderr),
    );
  const bytes = readFileSync(media);
  let offset = 0,
    metadataEnd = 0;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "mdat") {
      metadataEnd = offset + 8;
      break;
    }
    if (size < 8) break;
    offset += size;
  }
  const script = join(temp, "renderer.js");
  const session = resolve(
    "libs/player/ui/src/lib/source-playback/silent-media-session.ts",
  );
  const confirmation = resolve(
    "libs/shared/interfaces/src/lib/source-playback-confirmation.ts",
  );
  await build({
    stdin: {
      contents: `import '@angular/compiler';import {SilentMediaSession} from ${JSON.stringify(session)};import {SourcePlaybackConfirmation} from ${JSON.stringify(confirmation)};
 async function run(path,limit){const video=document.createElement('video');video.style.cssText='position:fixed;left:-10000px;width:2px;height:2px;opacity:.001';document.body.append(video);const controller=new AbortController();const session=new SilentMediaSession({video});const confirm=new SourcePlaybackConfirmation();let frames=0;const result=await new Promise(resolve=>{const timeout=setTimeout(()=>resolve(false),limit);session.failure.then(()=>{clearTimeout(timeout);resolve(false);});session.start({streamUrl:location.origin+path,title:'Local fixture'},controller.signal,s=>{frames=Math.max(frames,s.presentedFrames??0);if(confirm.observe(s)){clearTimeout(timeout);resolve(true);}}).catch(()=>{clearTimeout(timeout);resolve(false);});});controller.abort();await session.close();video.remove();return {played:result,frames};}
 globalThis.runSourceProbeAcceptance=async()=>({video:await run('/video.mp4',11000),metadata:await run('/metadata.mp4',3000)});`,
      resolveDir: process.cwd(),
      sourcefile: "source-probe-acceptance.ts",
      loader: "ts",
    },
    outfile: script,
    bundle: true,
    platform: "browser",
    format: "iife",
    tsconfig: "tsconfig.base.json",
    logLevel: "silent",
  });
  server = http.createServer((req, res) => {
    inFlight++;
    res.on("close", () => inFlight--);
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><title>Source playback fixture</title><script src="/renderer.js"></script>',
      );
      return;
    }
    if (req.url === "/renderer.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(readFileSync(script));
      return;
    }
    const body =
      req.url === "/video.mp4"
        ? bytes
        : req.url === "/metadata.mp4"
          ? bytes.subarray(0, metadataEnd)
          : null;
    if (!body) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    if (range) {
      const start = Number(range[1]),
        end = Math.min(
          range[2] ? Number(range[2]) : body.length - 1,
          body.length - 1,
        );
      if (start > end) {
        res.statusCode = 416;
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
      res.setHeader("Content-Length", end - start + 1);
      res.end(body.subarray(start, end + 1));
    } else {
      res.setHeader("Content-Length", body.length);
      res.end(body);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await app.whenReady();
  window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  window.webContents.on("console-message", (event) => {
    if (/error/i.test(event.message)) console.log("Renderer:", event.message);
  });
  await window.loadURL(`http://127.0.0.1:${server.address().port}`);
  const result = await window.webContents.executeJavaScript(
    "runSourceProbeAcceptance()",
  );
  assert.equal(result.video.played, true, "Real decoded video must qualify");
  assert.ok(result.video.frames > 0);
  assert.equal(
    result.metadata.played,
    false,
    "Metadata without decoded frames must not qualify",
  );
  assert.equal(inFlight, 0, "All fixture requests must be closed");
  console.log("PASS Electron playback acceptance:", JSON.stringify(result));
})().then(
  () => finish(0),
  (error) => {
    console.error(error);
    finish(1);
  },
);
function finish(code) {
  window?.destroy();
  server?.closeAllConnections();
  server?.close();
  rmSync(temp, { recursive: true, force: true });
  app.exit(code);
}
