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
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  empiricalPercentile,
  createIsolatedFixture,
  isSettledBackwardSeek,
  isConfirmedStartup,
  resolveFfmpegPath,
  resolveNativeReleaseDir,
} from "./testing/player-benchmark-utils.mjs";
const root = resolve(import.meta.dirname, ".."),
  dir = join(root, "tmp/player-backend-comparison"),
  out = join(dir, "results"),
  require = createRequire(import.meta.url),
  ffmpegPath = resolveFfmpegPath(process.env),
  nativeRelease = resolveNativeReleaseDir(root, process.env),
  requestedIterations = Number.parseInt(process.env.ARM_NATOR_COMPARISON_ITERATIONS ?? "3", 10),
  startupIterations = Number.isInteger(requestedIterations) && requestedIterations > 0 ? requestedIterations : 3,
  startupBenchmarkOnly = process.env.ARM_NATOR_STARTUP_BENCHMARK_ONLY === "1",
  reportPath = resolve(process.env.ARM_NATOR_COMPARISON_OUTPUT ?? join(out, "latest.json"));
const bounds = { x: 40, y: 40, width: 320, height: 180 },
  ENDURANCE_DURATION_MS = 6_000,
  READY_TIMEOUT_MS = 4_000,
  SEEK_TIMEOUT_MS = 9_000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Each sample owns a fresh window. Keep Electron alive between samples; final
// cleanup explicitly calls app.quit().
app.on("window-all-closed", () => {});
function ff(args) {
  const r = spawnSync(
    ffmpegPath,
    ["-hide_banner", "-loglevel", "error", ...args],
    { encoding: "utf8" },
  );
  if (r.status) throw Error(r.stderr);
}
function availableEncoders() {
  const result = spawnSync(ffmpegPath, ["-hide_banner", "-encoders"], { encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr || `Could not inspect ${ffmpegPath}`);
  return result.stdout;
}
function chooseEncoder(list, candidates) {
  return candidates.find((candidate) => list.includes(candidate)) ?? null;
}
function fixtures() {
  mkdirSync(dir, { recursive: true });
  const h264 = join(dir, "h264.mp4"),
    hevc = join(dir, "hevc.mp4"),
    srt = join(dir, "captions.srt"),
    hlsDir = join(dir, "hls-ts"),
    hls = join(hlsDir, "stream.m3u8"),
    subtitleVideo = join(dir, "subtitle-black.mp4"),
    enduranceVideo = join(dir, "endurance-10s.mp4");
  const encoders = availableEncoders(),
    h264Encoder = chooseEncoder(encoders, ["h264_videotoolbox", "libx264"]),
    hevcEncoder = chooseEncoder(encoders, ["hevc_videotoolbox", "libx265"]);
  if (!h264Encoder) throw Error(`No supported H.264 encoder in ${ffmpegPath}`);
  writeFileSync(
    srt,
    "1\n00:00:00,000 --> 00:00:05,000\nARM-Nator comparison\n\n",
  );
  for (const [file, codec, extra] of [
    [h264, h264Encoder, []],
    ...(hevcEncoder ? [[hevc, hevcEncoder, ["-tag:v", "hvc1"]]] : []),
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
  // A black fixture makes white subtitle pixels unambiguous. Using testsrc
  // here could falsely "find" subtitle-like bright pixels in the video.
  if (!existsSync(subtitleVideo))
    ff(["-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30", "-t", "7", "-c:v", h264Encoder, "-pix_fmt", "yuv420p", "-y", subtitleVideo]);
  if (!existsSync(enduranceVideo))
    ff(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000", "-t", "10", "-c:v", h264Encoder, "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", enduranceVideo]);
  // This is deliberately a real VOD HLS manifest with MPEG-TS segments, not
  // an MP4 served under an .m3u8 URL. It exercises the network playlist path.
  if (!existsSync(hls)) {
    mkdirSync(hlsDir, { recursive: true });
    ff([
      "-i", h264, "-c", "copy", "-f", "hls", "-hls_time", "2",
      "-hls_playlist_type", "vod", "-hls_segment_type", "mpegts",
      "-hls_segment_filename", join(hlsDir, "segment-%03d.ts"), "-y", hls,
    ]);
  }
  return { h264, hevc: hevcEncoder ? hevc : null, hevcEncoder, h264Encoder, srt, hlsDir, hls, subtitleVideo, enduranceVideo };
}
function server(file, hlsDir) {
  const size = statSync(file).size;
  const s = createServer((q, r) => {
    const pathname = new URL(q.url, "http://127.0.0.1").pathname;
    if (pathname === "/stream.m3u8") {
      r.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return createReadStream(join(hlsDir, "stream.m3u8")).pipe(r);
    }
    if (/^\/segment-\d{3}\.ts$/.test(pathname)) {
      const segment = join(hlsDir, pathname.slice(1));
      if (!existsSync(segment)) return r.writeHead(404).end();
      r.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": statSync(segment).size });
      return createReadStream(segment).pipe(r);
    }
    if (pathname !== "/h264.mp4") return r.writeHead(404).end();
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
        hlsUrl: `http://127.0.0.1:${s.address().port}/stream.m3u8`,
      }),
    ),
  );
}
function fixtureName(file) {
  if (file.endsWith("stream.m3u8")) return "loopback-hls-mpegts";
  return file.startsWith("http") ? "range-http-h264" : file.split("/").at(-1);
}
function renderedSubtitleEvidence() {
  // capturePage captures Chromium's surface, while both backends draw through
  // native child NSViews. It is therefore not evidence of composited subtitle
  // pixels. Keep selection evidence, but make this limitation machine-readable.
  return {
    status: "unavailable",
    method: "unavailable: BrowserWindow.capturePage does not reliably include native child NSView/Metal surfaces",
  };
}
const state = (x) => x?.state ?? x?.status,
  pos = (x) => Number(x?.positionSeconds),
  snap = (a) => a.getSnapshot ?? a.getSessionSnapshot;
function hasSubtitleSelection(snapshot, trackId) {
  if (trackId === -1) {
    return (
      (snapshot?.selectedSubtitleTrackId == null ||
        snapshot.selectedSubtitleTrackId === -1) &&
      !snapshot?.subtitleTracks?.some(
        (track) => track.id !== -1 && track.selected,
      )
    );
  }
  return (
    snapshot?.selectedSubtitleTrackId === trackId ||
    snapshot?.subtitleTracks?.some(
      (track) => track.id === trackId && track.selected,
    )
  );
}
async function until(read, pred) {
  const start = performance.now();
  let x;
  while (performance.now() - start < READY_TIMEOUT_MS) {
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
async function settledSeek(
  read,
  target,
  preSeekPosition,
  requiredDiscontinuitySeconds,
) {
  const start = performance.now();
  let observation;
  while (performance.now() - start < SEEK_TIMEOUT_MS) {
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
async function one(name, addon, file, srt, iteration, options = {}) {
  let id = `cmp-${name}-${Date.now()}-${iteration}`,
    win = new BrowserWindow({ show: false, width: 500, height: 300 }),
    read = snap(addon),
    isolatedFixture = null,
    playbackFile = file;
  if (file.startsWith("file:")) {
    isolatedFixture = createIsolatedFixture(
      fileURLToPath(file),
      join(dir, "isolated-runs"),
      `${name}-${iteration}`,
    );
    playbackFile = pathToFileURL(isolatedFixture.path).href;
  }
  const base = await process.getProcessMemoryInfo();
  try {
    const t = performance.now(),
      handle = win.getNativeWindowHandle();
    if (name === "ksplayer-metal") {
      const c = addon.createSession(id, handle, bounds);
      if (c.ok === false) throw Error(c.reason);
      const l = addon.load(id, playbackFile);
      if (l.ok === false) throw Error(l.reason);
    } else {
      id = addon.createSession(handle, bounds);
      addon.loadPlayback(id, { streamUrl: playbackFile });
    }
    const ready = await until(
      () => read(id),
      (x) => isConfirmedStartup(x, { audioOnly: options.audioOnly === true }),
    );
    const startup = {
      latencyMs: Math.round(performance.now() - t),
      evidence: await advances(() => read(id)),
    };
    let seek = null, subtitle = { status: "not-run" }, x = read(id);
    if (options.seek !== false) {
      await wait(500);
      const preSeekPosition = pos(read(id)), target = 0.25;
      if (!Number.isFinite(preSeekPosition) || Math.abs(preSeekPosition - target) < 0.25)
        throw Error(`seek target is not materially separated from pre-command position: ${preSeekPosition}`);
      addon.seek(id, target);
      seek = { preCommandPosition: preSeekPosition, target, requiredDiscontinuitySeconds: 0.25,
        ...(await settledSeek(() => read(id), target, preSeekPosition, 0.25)) };
    }
    if (options.subtitles) {
      const subtitleIDsBefore = new Set((read(id)?.subtitleTracks ?? []).map((track) => track.id));
      const subResult = addon.setSubtitleFile(id, srt);
      const external = await until(() => read(id), (snapshot) => (snapshot?.subtitleTracks ?? []).some((track) => !subtitleIDsBefore.has(track.id) && track.id !== -1));
      const externalTrack = external.x.subtitleTracks.find((track) => !subtitleIDsBefore.has(track.id) && track.id !== -1);
      if (!externalTrack) throw Error("external subtitle track was not exposed");
      const disabledResult = addon.setSubtitleTrack(id, -1);
      const disabled = await until(
        () => read(id),
        (snapshot) => hasSubtitleSelection(snapshot, -1),
      );
      const selectedResult = addon.setSubtitleTrack(id, externalTrack.id);
      const selected = await until(
        () => read(id),
        (snapshot) => hasSubtitleSelection(snapshot, externalTrack.id),
      );
      x = selected.x;
      const rendered = renderedSubtitleEvidence();
      subtitle = { status: rendered.status, operationAccepted: subResult?.ok !== false,
        disableAccepted: disabledResult?.ok !== false, disableVerification: hasSubtitleSelection(disabled.x, -1) ? "off" : "failed",
        selectionAccepted: selectedResult?.ok !== false,
        trackCount: x?.subtitleTracks?.length ?? null, selectedTrackId: x?.selectedSubtitleTrackId ?? null, externalTrackId: externalTrack.id,
        selectionVerification: "off-to-external", renderVerification: rendered.status, rendered };
    }
    const after = await process.getProcessMemoryInfo();
    return {
      backend: name,
      fixture: fixtureName(file),
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
      subtitles: subtitle,
      finalState: state(x),
    };
  } catch (e) {
    return {
      backend: name,
      fixture: fixtureName(file),
      iteration,
      ok: false,
      error: String(e),
    };
  } finally {
    try {
      addon.disposeSession(id);
    } catch {}
    win.destroy();
    isolatedFixture?.cleanup();
  }
}
function hostCpuMetric() {
  const metric = app.getAppMetrics().find((item) => item.pid === process.pid);
  const percentCPUUsage = metric?.cpu?.percentCPUUsage;
  return Number.isFinite(percentCPUUsage) ? percentCPUUsage : null;
}
async function enduranceCheck(name, addon, file) {
  let id = `endurance-${name}-${Date.now()}`,
    win = new BrowserWindow({ show: false, width: 500, height: 300 }),
    read = snap(addon),
    isolatedFixture = null,
    playbackFile = file;
  if (file.startsWith("file:")) {
    isolatedFixture = createIsolatedFixture(
      fileURLToPath(file),
      join(dir, "isolated-runs"),
      `endurance-${name}`,
    );
    playbackFile = pathToFileURL(isolatedFixture.path).href;
  }
  try {
    const handle = win.getNativeWindowHandle();
    if (name === "ksplayer-metal") {
      const created = addon.createSession(id, handle, bounds);
      if (created.ok === false) throw Error(created.reason);
      const loaded = addon.load(id, playbackFile);
      if (loaded.ok === false) throw Error(loaded.reason);
    } else { id = addon.createSession(handle, bounds); addon.loadPlayback(id, { streamUrl: playbackFile }); }
    await until(() => read(id), (x) => state(x) === "playing" && pos(x) > 0.05);
    // Electron documents percentCPUUsage as the process CPU percentage since
    // the previous getAppMetrics call. Prime it, then sample over endurance.
    hostCpuMetric();
    const start = performance.now();
    let samples = 0, failures = [], previous = pos(read(id));
    while (performance.now() - start < ENDURANCE_DURATION_MS) {
      await wait(500);
      const x = read(id), current = pos(x); samples++;
      if (state(x) !== "playing" || !Number.isFinite(current) || current <= previous + 0.02)
        failures.push({ elapsedMs: Math.round(performance.now() - start), state: state(x), positionSeconds: current });
      previous = current;
    }
    const elapsedMs = Math.round(performance.now() - start), percentCPUUsage = hostCpuMetric();
    const cpu = percentCPUUsage == null
      ? { status: "unavailable", reason: "app.getAppMetrics() did not return a finite host-process cpu.percentCPUUsage" }
      : { status: "measured", scope: "Electron host process", intervalMs: elapsedMs,
          method: "app.getAppMetrics() host PID cpu.percentCPUUsage sampled after a priming call at endurance start",
          percentCPUUsage, limitations: "Includes Electron and benchmark-host overhead; it is not decoder-only CPU and is comparable only within this command." };
    return { backend: name, fixture: fixtureName(file), status: failures.length ? "failed" : "passed",
      durationMs: elapsedMs, sampleIntervalMs: 500, samples, failures,
      cpu,
    };
  } catch (error) { return { backend: name, fixture: fixtureName(file), status: "failed", durationMs: ENDURANCE_DURATION_MS, error: String(error), cpu: { status: "unavailable", reason: "playback did not remain available long enough to measure" } }; }
  finally { try { addon.disposeSession(id); } catch {} win.destroy(); isolatedFixture?.cleanup(); }
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
      const subtitleOff = hasSubtitleSelection(
        { selectedSubtitleTrackId: null, subtitleTracks: [{ id: 7, selected: false }] },
        -1,
      );
      const subtitleExternal = hasSubtitleSelection(
        { subtitleTracks: [{ id: 7, selected: true }] },
        7,
      );
      const subtitleWrong = hasSubtitleSelection(
        { selectedSubtitleTrackId: -1 },
        7,
      );
      if (noOp.accepted || !backward.accepted || !subtitleOff || !subtitleExternal || subtitleWrong)
        throw Error("comparison predicate self-test failed");
      console.log(
        JSON.stringify({
          selfTest: "passed",
          noOpRejected: true,
          backwardAccepted: true,
          subtitleOffAccepted: true,
          subtitleExternalAccepted: true,
        }),
      );
      return;
    }
    console.error("comparison: preparing fixtures");
    const f = fixtures();
    console.error("comparison: fixtures ready");
    net = await server(f.h264, f.hlsDir);
    const release = nativeRelease,
      backends = [
        ["ksplayer-metal", require(join(release, "ksplayer_metal.node"))],
        ["embedded-mpv", require(join(release, "embedded_mpv.node"))],
      ],
      cases = [pathToFileURL(f.h264).href, ...(f.hevc ? [pathToFileURL(f.hevc).href] : []), net.url, net.hlsUrl],
      runs = [];
    console.error("comparison: functional runs starting");
    async function runCase(label, backend, addon, file, iteration, options) {
      console.error(`comparison: start ${label}`);
      const result = await one(backend, addon, file, f.srt, iteration, options);
      runs.push(result);
      console.error(`comparison: done ${label} ${result.ok ? "passed" : `failed ${result.error}`}`);
    }
    // Three samples are retained only for latency/seek fixtures. Network HLS
    // and subtitle rendering are explicit functional proofs, once per backend.
    for (const [n, a] of backends) {
      for (const c of cases.slice(0, f.hevc ? 2 : 1))
        for (let i = 1; i <= startupIterations; i++) await runCase(`${n}:${fixtureName(c)}:${i}/${startupIterations}`, n, a, c, i, { seek: !startupBenchmarkOnly });
      if (!startupBenchmarkOnly) {
        await runCase(`${n}:loopback-hls-mpegts:1/1`, n, a, net.hlsUrl, 1, { seek: false });
        await runCase(`${n}:rendered-subtitle:1/1`, n, a, pathToFileURL(f.subtitleVideo).href, 1, { seek: false, subtitles: true });
      }
    }
    const endurance = [];
    for (const [n, a] of startupBenchmarkOnly ? [] : backends) {
      console.error(`comparison: start ${n}:endurance:${ENDURANCE_DURATION_MS}ms`);
      const result = await enduranceCheck(n, a, pathToFileURL(f.enduranceVideo).href);
      endurance.push(result);
      console.error(`comparison: done ${n}:endurance ${result.status}`);
    }
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
      sampleCount: rs.length,
      successfulRuns: rs.filter((r) => r.ok).length,
      medianStartupMs: median(rs.map((r) => r.startup?.latencyMs)),
      p95StartupMs: empiricalPercentile(rs.map((r) => r.startup?.latencyMs), 0.95),
      medianSeekMs: median(rs.map((r) => r.seek?.latencyMs)),
    }));
    const report = {
      schemaVersion: 4,
      generatedAt: new Date().toISOString(),
      runtime: { nativeRelease, ffmpegPath, startupBenchmarkOnly, startupIterations },
      method:
        "isolated hidden native-window/session per run; nearest-rank p95 startup over configured samples; bounded HLS, subtitle-selection, and endurance proofs",
      iptvGap:
        "Loopback VOD HLS is covered with an m3u8 manifest and MPEG-TS segments; this is not an authenticated, adaptive, or live IPTV stream.",
      dimensions: {
        h264: { status: "covered", encoder: f.h264Encoder, container: "MP4" },
        hevc: f.hevc ? { status: "covered", encoder: f.hevcEncoder, container: "MP4" } : { status: "not-generated", reason: `No H.265 encoder found in ${ffmpegPath}` },
        hls: startupBenchmarkOnly ? { status: "not-run", reason: "startup-only comparison" } : { status: "covered", fixture: "loopback-hls-mpegts", protocol: "HTTP loopback", playlist: "m3u8", segmentFormat: "MPEG-TS", samplesPerBackend: 1 },
        subtitles: { status: "unavailable", method: "native-child composited pixel capture is not implemented; track selection remains independently verified" },
        endurance: { durationMs: ENDURANCE_DURATION_MS, fixture: "endurance-10s.mp4", fixtureDurationSeconds: 10, scope: "one isolated session per backend, 500ms advancement samples" },
        cpu: { method: "app.getAppMetrics() host PID cpu.percentCPUUsage over the endurance interval", limitations: "host-process measurement, not decoder-only CPU" },
      },
      runs,
      endurance,
      summary,
    };
    mkdirSync(out, { recursive: true });
    mkdirSync(join(reportPath, ".."), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (
      runs.some((run) => !run.ok) ||
      summary.some((item) => item.successfulRuns !== item.sampleCount) ||
      endurance.some((item) => item.status !== "passed")
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
