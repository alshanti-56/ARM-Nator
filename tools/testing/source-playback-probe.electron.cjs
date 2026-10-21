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
app.on("window-all-closed", () => {});
const watchdog = setTimeout(() => {
  console.error("Source fixture acceptance timed out");
  finish(1);
}, 100000);
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
  const sampler = resolve(
    "libs/providers/xtream/data-access/src/lib/source-playback-sampler.service.ts",
  );
  const api = resolve(
    "libs/providers/xtream/data-access/src/lib/services/xtream-api.service.ts",
  );
  const urls = resolve(
    "libs/providers/xtream/data-access/src/lib/services/xtream-url.service.ts",
  );
  const stalkerSampler = resolve(
    "libs/providers/stalker/data-access/src/lib/source-playback-sampler.service.ts",
  );
  const stalkerContext = resolve(
    "libs/providers/stalker/data-access/src/lib/source-playback-context.service.ts",
  );
  const stalkerRepair = resolve(
    "libs/providers/stalker/data-access/src/lib/stalker-portal-repair.service.ts",
  );
  await build({
    stdin: {
      contents: `import '@angular/compiler';import {SilentMediaSession} from ${JSON.stringify(session)};import {SourcePlaybackConfirmation} from ${JSON.stringify(confirmation)};
 import {createEnvironmentInjector,runInInjectionContext} from '@angular/core';import {of} from 'rxjs';import {DataService,DatabaseService,PlaylistsService,SourcePlaybackRepositoryService} from '@arm-nator/services';import {XtreamSourcePlaybackSamplerService} from ${JSON.stringify(sampler)};import {XtreamApiService} from ${JSON.stringify(api)};import {XtreamUrlService} from ${JSON.stringify(urls)};import {StalkerSourcePlaybackSamplerService} from ${JSON.stringify(stalkerSampler)};import {StalkerSourcePlaybackContextService} from ${JSON.stringify(stalkerContext)};import {StalkerPortalRepairService} from ${JSON.stringify(stalkerRepair)};
 const source={_id:'fixture',serverUrl:location.origin,username:'fixture',password:'fixture'};
 const injector=createEnvironmentInjector([{provide:DataService,useValue:{sendIpcEvent:async(_event,p)=>{const result=await (await fetch((p.macAddress?p.url:p.url+'/player_api.php')+'?'+new URLSearchParams(p.params))).json();return p.macAddress?result:{payload:result};}}},{provide:DatabaseService,useValue:{getSourcePlaybackCandidates:async()=>[],hasXtreamCategories:async()=>false}},{provide:PlaylistsService,useValue:{getPlaylistById:id=>of(id==='portal'?{_id:'portal',portalUrl:location.origin+'/stalker_portal/server/load.php',macAddress:'00:1A:79:00:00:01',isFullStalkerPortal:true,stalkerToken:'fixture'}:source)}},{provide:SourcePlaybackRepositoryService,useValue:{read:async()=>[]}},{provide:StalkerPortalRepairService,useValue:{waitForPendingRepair:async()=>{},applyOverride:s=>s}},{provide:StalkerSourcePlaybackContextService,useFactory:()=>new StalkerSourcePlaybackContextService()},{provide:XtreamApiService,useFactory:()=>new XtreamApiService()},{provide:XtreamUrlService,useValue:{constructLiveUrl:(c,id)=>c.serverUrl+'/live/'+c.username+'/'+c.password+'/'+id+'.mp4',constructVodUrl:(c,d)=>c.serverUrl+'/movie/'+c.username+'/'+c.password+'/'+d.movie_data.stream_id+'.'+d.movie_data.container_extension,constructEpisodeUrl:(c,e)=>c.serverUrl+'/series/'+c.username+'/'+c.password+'/'+e.id+'.'+e.container_extension}}],null);
 const portalSampler=runInInjectionContext(injector,()=>new StalkerSourcePlaybackSamplerService());
 const sampler=runInInjectionContext(injector,()=>new XtreamSourcePlaybackSamplerService());
 async function portalCategory(kind){const signal=new AbortController().signal;const [candidate]=await portalSampler.select('portal',kind,signal);if(!candidate)throw Error('Missing portal candidate');const playback=await portalSampler.resolve('portal',candidate,signal);return {...await run(playback.streamUrl,11000),itemId:candidate.episodeId??candidate.itemId};}
 async function category(kind){const signal=new AbortController().signal;const candidates=await sampler.select('fixture',kind,signal);if(!candidates.length)throw Error('Missing fixture candidate');const playback=await sampler.resolve('fixture',candidates[0],signal);const outcome=await run(playback.streamUrl,11000);return {...outcome,itemId:candidates[0].episodeId??candidates[0].itemId};}

 async function run(path,limit){const video=document.createElement('video');video.style.cssText='position:fixed;left:-10000px;width:2px;height:2px;opacity:.001';document.body.append(video);const controller=new AbortController();const session=new SilentMediaSession({video});const confirm=new SourcePlaybackConfirmation();let frames=0;const result=await new Promise(resolve=>{const timeout=setTimeout(()=>resolve(false),limit);session.failure.then(()=>{clearTimeout(timeout);resolve(false);});session.start({streamUrl:new URL(path,location.origin).href,title:'Local fixture'},controller.signal,s=>{frames=Math.max(frames,s.presentedFrames??0);if(confirm.observe(s)){clearTimeout(timeout);resolve(true);}}).catch(()=>{clearTimeout(timeout);resolve(false);});});controller.abort();await session.close();video.remove();return {played:result,frames};}
 globalThis.runSourceProbeAcceptance=async()=>({video:await run('/video.mp4',11000),metadata:await run('/metadata.mp4',3000),live:await category('live'),movie:await category('movies'),episode:await category('series'),portalLive:await portalCategory('live'),portalMovie:await portalCategory('movies'),portalEpisode:await portalCategory('series')});`,
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
    const requestUrl = new URL(req.url, "http://fixture.test");
    if (requestUrl.pathname === "/stalker_portal/server/load.php") {
      const action = requestUrl.searchParams.get("action"),
        type = requestUrl.searchParams.get("type");
      const payload =
        action === "handshake"
          ? { js: { token: "fixture", random: "fixture" } }
          : action === "get_profile"
            ? { js: { status: 0 } }
            : action === "get_genres" || action === "get_categories"
              ? { js: [{ id: "g", title: "Fixture" }] }
              : action === "get_ordered_list"
                ? {
                    js: {
                      data: requestUrl.searchParams.get("movie_id")
                        ? [
                            {
                              id: "season",
                              name: "Season 1",
                              cmd: "ffmpeg /media/season",
                              series: [1, 2],
                            },
                          ]
                        : [
                            {
                              id: type === "series" ? "show" : "item",
                              name: "Portal sample",
                              cmd: "ffmpeg /media/item",
                              use_http_tmp_link: 1,
                              category_id: "g",
                            },
                          ],
                    },
                  }
                : action === "create_link"
                  ? { js: { cmd: "/fixture-video.mp4" } }
                  : null;
      if (!payload) {
        res.statusCode = 400;
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }
    if (requestUrl.pathname === "/player_api.php") {
      const action = requestUrl.searchParams.get("action");
      const payload =
        action === "get_live_categories" ||
        action === "get_vod_categories" ||
        action === "get_series_categories"
          ? [{ category_id: "1", category_name: "Fixture" }]
          : action === "get_live_streams"
            ? [{ stream_id: 99, name: "Fixture live", category_id: "1" }]
            : action === "get_vod_streams"
              ? [{ stream_id: 77, name: "Fixture movie", category_id: "1" }]
              : action === "get_series"
                ? [{ series_id: 8, name: "Fixture series", category_id: "1" }]
                : action === "get_vod_info"
                  ? {
                      movie_data: { stream_id: 77, container_extension: "mp4" },
                    }
                  : action === "get_series_info"
                    ? {
                        episodes: {
                          1: [
                            {
                              id: "88",
                              title: "Fixture episode",
                              season: 1,
                              episode_num: 1,
                              container_extension: "mp4",
                            },
                          ],
                        },
                      }
                    : null;
      if (payload === null) {
        res.statusCode = 400;
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }
    const body =
      req.url === "/video.mp4" ||
      req.url === "/stalker_portal/fixture-video.mp4" ||
      /^\/(live|movie|series)\/fixture\/fixture\/\d+\.mp4$/.test(req.url)
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
  console.log("Fixture renderer ready; starting decoded playback checks");
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
  assert.equal(result.live.played, true);
  for (const kind of ["portalLive", "portalMovie", "portalEpisode"])
    assert.equal(result[kind].played, true, kind + " must decode");
  assert.equal(result.movie.played, true);
  assert.equal(result.movie.itemId, "77");
  assert.equal(result.episode.played, true);
  assert.equal(result.episode.itemId, "88");
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
  clearTimeout(watchdog);
  window?.destroy();
  server?.closeAllConnections();
  server?.close();
  rmSync(temp, { recursive: true, force: true });
  app.exit(code);
}
