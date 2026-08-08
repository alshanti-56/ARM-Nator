// Real Electron, identical-fixture evidence. Run via pnpm player-backend:compare.
import { app, BrowserWindow } from "electron";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  createReadStream,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const root = resolve(import.meta.dirname, ".."),
  dir = join(root, "tmp/player-backend-comparison"),
  out = join(dir, "results"),
  require = createRequire(import.meta.url);
const bounds = { x: 40, y: 40, width: 320, height: 180 },
  wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Each sample owns a fresh window. Keep Electron alive between samples; final
// cleanup explicitly calls app.quit().
app.on("window-all-closed", () => {});
function ff(args) {
  const r = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...args],
    { encoding: "utf8" },
  );
  if (r.status) throw Error(r.stderr);
}
function fixtures() {
  mkdirSync(dir, { recursive: true });
  const h264 = join(dir, "h264.mp4"),
    hevc = join(dir, "hevc.mp4"),
    srt = join(dir, "captions.srt");
  writeFileSync(
    srt,
    "1\n00:00:00,000 --> 00:00:05,000\nARM-Nator comparison\n\n",
  );
  for (const [file, codec, extra] of [
    [h264, "libx264", []],
    [hevc, "libx265", ["-tag:v", "hvc1"]],
  ])
    if (!existsSync(file))
      ff([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:sample_rate=48000",
        "-t",
        "7",
        "-c:v",
        codec,
        "-pix_fmt",
        "yuv420p",
        "-g",
        "30",
        ...extra,
        "-c:a",
        "aac",
        "-y",
        file,
      ]);
  return { h264, hevc, srt };
}
function server(file) {
  const size = statSync(file).size;
  const s = createServer((q, r) => {
    if (q.url !== "/h264.mp4") return r.writeHead(404).end();
    let a = 0,
      b = size - 1,
      code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(q.headers.range || "");
    if (m) {
      a = m[1] ? +m[1] : 0;
      b = m[2] ? +m[2] : b;
      if (a > b || a >= size)
        return r.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      b = Math.min(b, size - 1);
      code = 206;
    }
    const h = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": b - a + 1,
      ...(code === 206 ? { "Content-Range": `bytes ${a}-${b}/${size}` } : {}),
    };
    r.writeHead(code, h);
    if (q.method !== "HEAD")
      createReadStream(file, { start: a, end: b }).pipe(r);
    else r.end();
  });
  return new Promise((resolveServer) =>
    s.listen(0, "127.0.0.1", () =>
      resolveServer({
        s,
        url: `http://127.0.0.1:${s.address().port}/h264.mp4`,
      }),
    ),
  );
}
const state = (x) => x?.state ?? x?.status,
  pos = (x) => Number(x?.positionSeconds),
  snap = (a) => a.getSnapshot ?? a.getSessionSnapshot;
async function until(read, pred) {
  const start = performance.now();
  let x;
  while (performance.now() - start < 9000) {
    x = read();
    if (pred(x)) return { x, ms: Math.round(performance.now() - start) };
    await wait(50);
  }
  throw Error(`timeout ${JSON.stringify(x)}`);
}
async function advances(read) {
  const before = read();
  await wait(500);
  const after = read();
  if (!(pos(after) > pos(before) + 0.05))
    throw Error(`no advancement ${pos(before)} -> ${pos(after)}`);
  return { before: pos(before), after: pos(after), windowMs: 500 };
}
function hasResolution(snapshot) {
  return (
    (snapshot?.resolution?.width > 0 && snapshot?.resolution?.height > 0) ||
    (snapshot?.videoWidth > 0 && snapshot?.videoHeight > 0)
  );
}
function isSettledBackwardSeek(
  first,
  second,
  target,
  preSeekPosition,
  requiredDiscontinuitySeconds,
) {
  const observedDiscontinuity =
    preSeekPosition - Math.min(pos(first), pos(second));
  return {
    accepted:
      state(first) === "playing" &&
      state(second) === "playing" &&
      Math.abs(pos(first) - target) < 0.5 &&
      Math.abs(pos(second) - target) < 1 &&
      pos(second) > pos(first) + 0.05 &&
      observedDiscontinuity >= requiredDiscontinuitySeconds,
    observedDiscontinuity,
  };
}
async function settledSeek(
  read,
  target,
  preSeekPosition,
  requiredDiscontinuitySeconds,
) {
  const start = performance.now();
  let observation;
  while (performance.now() - start < 9000) {
    const first = read();
    await wait(500);
    const second = read();
    const evidence = isSettledBackwardSeek(
      first,
      second,
      target,
      preSeekPosition,
      requiredDiscontinuitySeconds,
    );
    if (evidence.accepted) {
      return {
        latencyMs: Math.round(performance.now() - start),
        observations: [pos(first), pos(second)],
        actualObservedDiscontinuity: evidence.observedDiscontinuity,
        windowMs: 500,
      };
    }
    observation = [pos(first), pos(second)];
    await wait(50);
  }
  throw Error(
    `seek never settled and advanced near ${target}: ${JSON.stringify(observation)}`,
  );
}
async function one(name, addon, file, srt, iteration) {
  let id = `cmp-${name}-${Date.now()}-${iteration}`,
    win = new BrowserWindow({ show: false, width: 500, height: 300 }),
    read = snap(addon);
  const base = await process.getProcessMemoryInfo();
  try {
    const t = performance.now(),
      handle = win.getNativeWindowHandle();
    if (name === "ksplayer-metal") {
      const c = addon.createSession(id, handle, bounds);
      if (c.ok === false) throw Error(c.reason);
      const l = addon.load(id, file);
      if (l.ok === false) throw Error(l.reason);
    } else {
      id = addon.createSession(handle, bounds);
      addon.loadPlayback(id, { streamUrl: file });
    }
    const ready = await until(
      () => read(id),
      (x) =>
        state(x) === "playing" &&
        Number.isFinite(x?.durationSeconds) &&
        hasResolution(x) &&
        pos(x) > 0.05,
    );
    const startup = {
      latencyMs: Math.round(performance.now() - t),
      evidence: await advances(() => read(id)),
    };
    await wait(700);
    const preSeekPosition = pos(read(id));
    const target = 0.25;
    if (
      !Number.isFinite(preSeekPosition) ||
      Math.abs(preSeekPosition - target) < 0.25
    ) {
      throw Error(
        `seek target is not materially separated from pre-command position: ${preSeekPosition}`,
      );
    }
    addon.seek(id, target);
    const seek = {
      preCommandPosition: preSeekPosition,
      target,
      requiredDiscontinuitySeconds: 0.25,
      ...(await settledSeek(() => read(id), target, preSeekPosition, 0.25)),
    };
    const subtitleIDsBefore = new Set(
      (read(id)?.subtitleTracks ?? []).map((track) => track.id),
    );
    const subResult = addon.setSubtitleFile(id, srt);
    const external = await until(
      () => read(id),
      (snapshot) =>
        (snapshot?.subtitleTracks ?? []).some(
          (track) => !subtitleIDsBefore.has(track.id) && track.id !== -1,
        ),
    );
    const externalTrack = external.x.subtitleTracks.find(
      (track) => !subtitleIDsBefore.has(track.id) && track.id !== -1,
    );
    if (!externalTrack) throw Error("external subtitle track was not exposed");
    const selectedResult = addon.setSubtitleTrack(id, externalTrack.id);
    const selected = await until(
      () => read(id),
      (snapshot) =>
        snapshot?.selectedSubtitleTrackId === externalTrack.id ||
        snapshot?.subtitleTracks?.some(
          (track) => track.id === externalTrack.id && track.selected,
        ),
    );
    const x = selected.x,
      after = await process.getProcessMemoryInfo();
    return {
      backend: name,
      fixture: file.startsWith("http")
        ? "range-http-h264"
        : file.split("/").at(-1),
      iteration,
      ok: true,
      startup,
      seek,
      resource: {
        hostPid: process.pid,
        beforePrivateKiB: base.private,
        afterPrivateKiB: after.private,
        deltaPrivateKiB: after.private - base.private,
        cpu: "unavailable: app metrics has no documented per-host CPU field",
      },
      frames: { droppedFrames: x?.droppedFrames ?? null, observationMs: 500 },
      render:
        name === "ksplayer-metal"
          ? {
              directMetalActive:
                x?.embedding?.renderPath?.directMetalActive ?? null,
            }
          : { hwdecCurrent: x?.hwdecCurrent ?? null },
      subtitles: {
        operationAccepted: subResult?.ok !== false,
        selectionAccepted: selectedResult?.ok !== false,
        trackCount: x?.subtitleTracks?.length ?? null,
        selectedTrackId: x?.selectedSubtitleTrackId ?? null,
        externalTrackId: externalTrack.id,
        selectionVerification: "selected",
        renderVerification:
          "unavailable: neither snapshot exposes rendered cue state",
      },
      finalState: state(x),
    };
  } catch (e) {
    return {
      backend: name,
      fixture: file.startsWith("http")
        ? "range-http-h264"
        : file.split("/").at(-1),
      iteration,
      ok: false,
      error: String(e),
    };
  } finally {
    try {
      addon.disposeSession(id);
    } catch {}
    win.destroy();
  }
}
function median(v) {
  const a = v.filter(Number.isFinite).sort((a, b) => a - b);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}
app.whenReady().then(async () => {
  let net, keeper;
  let finalExitCode = 0;
  try {
    keeper = new BrowserWindow({ show: false });
    if (process.env.ARM_NATOR_COMPARISON_SELF_TEST === "1") {
      const noOp = isSettledBackwardSeek(
        { state: "playing", positionSeconds: 0.61 },
        { state: "playing", positionSeconds: 1.11 },
        0.75,
        0.6,
        0.25,
      );
      const backward = isSettledBackwardSeek(
        { state: "playing", positionSeconds: 0.25 },
        { state: "playing", positionSeconds: 0.75 },
        0.25,
        1,
        0.25,
      );
      if (noOp.accepted || !backward.accepted)
        throw Error("backward seek predicate self-test failed");
      console.log(
        JSON.stringify({
          selfTest: "passed",
          noOpRejected: true,
          backwardAccepted: true,
        }),
      );
      return;
    }
    const f = fixtures();
    net = await server(f.h264);
    const release = join(root, "apps/electron-backend/native/build/Release"),
      backends = [
        ["ksplayer-metal", require(join(release, "ksplayer_metal.node"))],
        ["embedded-mpv", require(join(release, "embedded_mpv.node"))],
      ],
      cases = [pathToFileURL(f.h264).href, pathToFileURL(f.hevc).href, net.url],
      runs = [];
    for (const [n, a] of backends)
      for (const c of cases)
        for (let i = 1; i <= 3; i++) runs.push(await one(n, a, c, f.srt, i));
    // Test-only seam: proves JSON persistence and nonzero signaling without
    // altering player behavior.
    if (process.env.ARM_NATOR_COMPARISON_FORCE_FAILURE === "1") {
      runs[0] = { ...runs[0], ok: false, error: "forced comparison failure" };
    }
    const summary = Object.values(
      Object.groupBy(runs, (r) => `${r.backend}:${r.fixture}`),
    ).map((rs) => ({
      backend: rs[0].backend,
      fixture: rs[0].fixture,
      successfulRuns: rs.filter((r) => r.ok).length,
      medianStartupMs: median(rs.map((r) => r.startup?.latencyMs)),
      medianSeekMs: median(rs.map((r) => r.seek?.latencyMs)),
    }));
    const report = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      method:
        "isolated hidden window/session per run; three samples; host process memory baseline/delta",
      iptvGap:
        "No loopback HLS/TS case in this command; Range HTTP MP4 is the local-network case.",
      runs,
      summary,
    };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "latest.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (
      runs.some((run) => !run.ok) ||
      summary.some((item) => item.successfulRuns !== 3)
    ) {
      finalExitCode = 1;
    }
  } catch (e) {
    console.error(e);
    finalExitCode = 1;
  } finally {
    net?.s.close();
    keeper?.destroy();
    // Electron ignores Node's process.exitCode when app.quit() drains the
    // event loop. Exit explicitly only after report persistence and cleanup.
    app.exit(finalExitCode);
  }
});
