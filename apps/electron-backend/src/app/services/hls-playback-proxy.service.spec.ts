import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rendererAppPort } from "../constants";
import {
  PlaybackDiagnosticsStore,
  type PlaybackDiagnosticInput,
} from "./playback-diagnostics.service";
import {
  HlsPlaybackProxyService,
  resolveHlsProxyTarget,
  rewriteHlsManifest,
  sanitizeHlsProxyHeaders,
  sanitizeMpegTsProxyHeaders,
} from "./hls-playback-proxy.service";
import { playbackAccountProfiles } from "./playback-account-profile.service";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("HLS proxy rewrites relative, absolute, and key URIs without exposing targets", () => {
  const target = "https://tokenized.example/live/segment.ts?token=secret";
  const rewritten = rewriteHlsManifest(
    '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?auth=secret"\nsegment.ts?token=secret\nhttps://tokenized.example/live/segment.ts?token=secret\n',
    "https://tokenized.example/live/playlist.m3u8?access=secret",
    () => "http://127.0.0.1:9999/hls/opaque/resource",
  );

  assert.equal(
    (rewritten.match(/http:\/\/127\.0\.0\.1:9999/g) ?? []).length,
    3,
  );
  assert.ok(!rewritten.includes("tokenized.example"));
  assert.ok(!rewritten.includes("secret"));
  assert.equal(resolveHlsProxyTarget("data:text/plain,nope", target), null);
  assert.equal(
    resolveHlsProxyTarget("https://user:secret@tokenized.example/segment.ts", target),
    null,
  );
  assert.equal(
    resolveHlsProxyTarget("../next.ts?x=1", target),
    "https://tokenized.example/next.ts?x=1",
  );
});

test("HLS proxy retains supported provider headers", () => {
  assert.deepEqual(
    sanitizeHlsProxyHeaders({
      "User-Agent": " Provider/1.0 ",
      Referer: "https://provider.example/",
      Cookie: "session=secret",
      Authorization: "Bearer token",
      "X-Injected": "bad\r\nvalue",
    }),
    {
      "user-agent": "Provider/1.0",
      referer: "https://provider.example/",
      cookie: "session=secret",
      authorization: "Bearer token",
    },
  );
});

test("records a 401 followed by a redirected manifest refresh and keeps status and secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-hls-diag-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const diagnostics = new PlaybackDiagnosticsStore({ filePath });
  const edgeRequests: Record<string, string | undefined>[] = [];
  const edge = createServer((request, response) => {
    edgeRequests.push({
      userAgent: request.headers["user-agent"],
      referer: request.headers.referer,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
    });
    response.writeHead(200, {
      "content-type": "application/vnd.apple.mpegurl",
      "x-edge-node": "edge-success",
    });
    response.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n");
  });
  const edgeUrl = await listen(edge);
  let sourceRequests = 0;
  const source = createServer((request, response) => {
    sourceRequests += 1;
    if (sourceRequests === 1) {
      response.writeHead(401, {
        "content-type": "text/plain",
        "www-authenticate": 'Basic realm="provider"',
        "x-edge-node": "source-denied",
      });
      response.end("denied");
      return;
    }
    response.writeHead(302, {
      location: `${edgeUrl}/playlist.m3u8?redirectToken=exact-secret`,
    });
    response.end();
  });
  const sourceUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService({
    diagnostics,
    mpegTsRemuxerPath: null,
  });
  let session: Awaited<ReturnType<typeof proxy.createSession>> | undefined;
  try {
    const originalUrl = `${sourceUrl}/playlist.m3u8?sourceToken=exact-source-secret`;
    session = await proxy.createSession({
      url: originalUrl,
      headers: {
        "User-Agent": "Player-UA/7.1",
        Referer: "https://portal.example/live",
        Authorization: "Bearer exact-auth-secret",
        Cookie: "session=exact-cookie-secret",
      },
    });
    const response = await fetch(session.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /#EXTM3U/);
    assert.equal(sourceRequests, 2);
    assert.equal(edgeRequests.length, 1);
    assert.equal(edgeRequests[0]?.userAgent, "Player-UA/7.1");
    assert.equal(edgeRequests[0]?.referer, "https://portal.example/live");
    assert.equal(edgeRequests[0]?.authorization, undefined);
    assert.equal(edgeRequests[0]?.cookie, undefined);

    await proxy.releaseSession(session.id);
    await diagnostics.flush();
    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstResponse = records.find(
      (record) => record.event === "upstream-response" && record.status === 401,
    );
    const refreshedResponse = records.find(
      (record) =>
        record.event === "upstream-response" &&
        record.phase === "manifest-refresh" &&
        record.status === 200,
    );
    assert.equal(firstResponse?.sourceUrl, originalUrl);
    assert.equal(firstResponse?.responseHeaders["www-authenticate"], 'Basic realm="provider"');
    assert.equal(firstResponse?.requestHeaders.authorization, "Bearer exact-auth-secret");
    assert.equal(firstResponse?.requestHeaders.cookie, "session=exact-cookie-secret");
    assert.equal(refreshedResponse?.sourceUrl, originalUrl);
    assert.match(refreshedResponse?.requestUrl ?? "", /_arm_nator_refresh=/);
    assert.equal(
      refreshedResponse?.responseUrl,
      `${edgeUrl}/playlist.m3u8?redirectToken=exact-secret`,
    );
    assert.equal(refreshedResponse?.responseHeaders["x-edge-node"], "edge-success");
    assert.equal(refreshedResponse?.requestHeaders["user-agent"], "Player-UA/7.1");
    assert.equal(
      records.find((record) => record.event === "proxy-session-created")?.activeSessions,
      1,
    );
    assert.equal(
      records.find((record) => record.event === "proxy-session-released")?.activeSessions,
      0,
    );
  } finally {
    if (session) await proxy.releaseSession(session.id);
    await proxy.shutdown();
    await diagnostics.flush();
    await close(source);
    await close(edge);
    await rm(directory, { recursive: true, force: true });
  }
});

test("records the final redirect response URL for a persistent 401 without changing status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-hls-diag-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const diagnostics = new PlaybackDiagnosticsStore({ filePath });
  const edgeRequests: Record<string, string | undefined>[] = [];
  const edge = createServer((request, response) => {
    edgeRequests.push({
      userAgent: request.headers["user-agent"],
      referer: request.headers.referer,
    });
    response.writeHead(401, {
      "content-type": "text/plain",
      "www-authenticate": 'Bearer realm="edge"',
      "x-edge-node": "edge-denied",
    });
    response.end("denied");
  });
  const edgeUrl = await listen(edge);
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `${edgeUrl}/protected.m3u8?edge=secret` });
    response.end();
  });
  const sourceUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService({ diagnostics, mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createSession({
      url: `${sourceUrl}/playlist.m3u8?source=secret`,
      headers: { "User-Agent": "Player-UA/8", Referer: "https://portal.example/" },
    });
    const response = await fetch(session.url);
    assert.equal(response.status, 401);
    await response.text();
    await proxy.releaseSession(session.id);
    await diagnostics.flush();

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const finalAttempt = records.find(
      (record) =>
        record.event === "upstream-response" &&
        record.phase === "manifest-fallback" &&
        record.status === 401,
    );
    assert.equal(finalAttempt?.responseUrl, `${edgeUrl}/protected.m3u8?edge=secret`);
    assert.equal(finalAttempt?.responseHeaders["www-authenticate"], 'Bearer realm="edge"');
    assert.equal(finalAttempt?.requestHeaders["user-agent"], "Player-UA/8");
    assert.equal(finalAttempt?.requestHeaders.referer, "https://portal.example/");
    assert.deepEqual(edgeRequests.at(-1), {
      userAgent: "Player-UA/8",
      referer: "https://portal.example/",
    });
    assert.equal(finalAttempt?.status, response.status);
  } finally {
    await proxy.shutdown();
    await diagnostics.flush();
    await close(source);
    await close(edge);
    await rm(directory, { recursive: true, force: true });
  }
});

test("records network failures with request correlation and does not turn them into a different status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-hls-diag-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const diagnostics = new PlaybackDiagnosticsStore({ filePath });
  const closedServer = createServer();
  const closedUrl = await listen(closedServer);
  await close(closedServer);
  const proxy = new HlsPlaybackProxyService({ diagnostics, mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createSession({ url: `${closedUrl}/offline.m3u8` });
    const response = await fetch(session.url);
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body, "");
    await proxy.releaseSession(session.id);
    await diagnostics.flush();

    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failure = records.find((record) => record.event === "upstream-error");
    assert.equal(failure?.requestUrl, `${closedUrl}/offline.m3u8`);
    assert.equal(failure?.status, undefined);
    assert.equal(failure?.requestId, records[0]?.requestId ?? failure?.requestId);
    assert.equal(typeof failure?.error?.name, "string");
    assert.equal(typeof failure?.error?.message, "string");
    assert.equal(typeof failure?.error?.cause?.code, "string");
  } finally {
    await proxy.shutdown();
    await diagnostics.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

test("records a fetch aborted when its proxy session is released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-hls-diag-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const diagnostics = new PlaybackDiagnosticsStore({ filePath });
  let markUpstreamStarted!: () => void;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });
  const upstream = createServer(() => markUpstreamStarted());
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ diagnostics, mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createSession({ url: `${upstreamUrl}/hanging.m3u8` });
    const clientResponse = fetch(session.url);
    await upstreamStarted;
    proxy.releaseSession(session.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      clientResponse,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("proxy request did not cancel")), 2000);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    await response.arrayBuffer();
    await diagnostics.flush();
    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const cancellation = records.find((record) => record.event === "upstream-error");
    assert.equal(cancellation?.phase, "initial");
    assert.equal(cancellation?.sessionId, session.id);
    assert.equal(cancellation?.error?.name, "AbortError");
  } finally {
    await proxy.shutdown();
    await diagnostics.flush();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test("progressive prefetch has an independent request ID and retains its session/resource correlation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-prefetch-diag-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  let finishPrefetch!: () => void;
  const prefetchRecorded = new Promise<void>((resolve) => {
    finishPrefetch = resolve;
  });
  class ObservedStore extends PlaybackDiagnosticsStore {
    override record(input: PlaybackDiagnosticInput): void {
      super.record(input);
      if (input.event === "upstream-response" && input.phase === "prefetch") {
        finishPrefetch();
      }
    }
  }
  const diagnostics = new ObservedStore({ filePath });
  const upstream = createServer((request, response) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    assert.ok(range);
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), 31);
    response
      .writeHead(206, {
        "content-type": "video/mp4",
        "content-range": `bytes ${start}-${end}/32`,
        "content-length": end - start + 1,
      })
      .end(Buffer.alloc(end - start + 1));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({
    diagnostics,
    mpegTsRemuxerPath: null,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const response = await fetch(session.url, {
      headers: { Range: "bytes=0-15" },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, 16);
    await Promise.race([
      prefetchRecorded,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("prefetch was not recorded")),
          2000,
        );
      }),
    ]);
    await diagnostics.flush();
    const records = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const initial = records.find(
      (record) => record.event === "upstream-response" && record.phase === "initial",
    );
    const prefetch = records.find(
      (record) => record.event === "upstream-response" && record.phase === "prefetch",
    );
    assert.ok(initial?.requestId);
    assert.ok(prefetch?.requestId);
    assert.notEqual(prefetch.requestId, initial.requestId);
    assert.equal(prefetch.sessionId, session.id);
    assert.equal(prefetch.resourceId, initial.resourceId);
    assert.ok(prefetch.resourceId);
    assert.equal(prefetch.sourceUrl, `${upstreamUrl}/movie.mp4`);
    assert.equal(prefetch.resourceKind, "progressive-vod");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await proxy.shutdown();
    await diagnostics.flush();
    await close(upstream);
    await rm(directory, { recursive: true, force: true });
  }
});

test("HLS credentials reach source resources but not another origin or a cross-origin redirect", async () => {
  const foreignHeaders: { cookie?: string; authorization?: string }[] = [];
  const foreign = createServer((request, response) => {
    foreignHeaders.push({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "content-type": "video/mp2t" }).end("foreign");
  });
  const foreignUrl = await listen(foreign);
  const sourcePaths: string[] = [];
  const source = createServer((request, response) => {
    assert.equal(request.headers.cookie, "session=secret");
    assert.equal(request.headers.authorization, "Bearer token");
    sourcePaths.push(request.url ?? "");
    if (request.url === "/playlist.m3u8") {
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nlocal.ts\n#EXTINF:2,\n${foreignUrl}/segment.ts\n#EXTINF:2,\nredirect.ts\n`);
    } else if (request.url === "/redirect.ts") {
      response.writeHead(302, { location: `${foreignUrl}/redirected.ts` }).end();
    } else {
      response.writeHead(200, { "content-type": "video/mp2t" }).end("local");
    }
  });
  const sourceUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${sourceUrl}/playlist.m3u8`,
      headers: { Cookie: "session=secret", Authorization: "Bearer token" },
    });
    const manifest = await (await fetch(session.url)).text();
    const segmentUrls = manifest.split("\n").filter((line) => line.startsWith("http://"));
    assert.equal(segmentUrls.length, 3);
    for (const url of segmentUrls) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.deepEqual(sourcePaths, ["/playlist.m3u8", "/local.ts", "/redirect.ts"]);
    assert.deepEqual(foreignHeaders, [
      { cookie: undefined, authorization: undefined },
      { cookie: undefined, authorization: undefined },
    ]);
  } finally {
    await proxy.shutdown();
    await close(source);
    await close(foreign);
  }
});

for (const seekKind of ["outside", "partly-overlapping"] as const) {
  test(`progressive VOD ${seekKind} seek bypasses an unfinished prefetch`, async () => {
    const prefetchStart = 1024;
    const prefetchEnd = prefetchStart + 25 * 1024 * 1024 - 1;
    const totalBytes = 96 * 1024 * 1024;
    let prefetchResponse: import("node:http").ServerResponse | undefined;
    let markPrefetchStarted!: () => void;
    const prefetchStarted = new Promise<void>((resolve) => {
      markPrefetchStarted = resolve;
    });
    const observedRanges: string[] = [];
    const upstream = createServer((request, response) => {
      const range = request.headers.range ?? "";
      observedRanges.push(range);
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      assert.ok(match);
      const start = Number(match[1]);
      const end = Number(match[2]);
      response.writeHead(206, {
        "content-type": "video/mp4",
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${totalBytes}`,
      });
      if (start === prefetchStart && end === prefetchEnd) {
        prefetchResponse = response;
        response.write(Buffer.from([0x61]));
        markPrefetchStarted();
        return;
      }
      response.end(Buffer.alloc(end - start + 1, 0x62));
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
      const session = await proxy.createProgressiveVodSession({ url: upstreamUrl });
      const initial = await fetch(session.url, { headers: { Range: "bytes=0-1023" } });
      await initial.arrayBuffer();
      await prefetchStarted;
      const seekStart = seekKind === "outside" ? 80 * 1024 * 1024 : prefetchEnd - 511;
      const seekRange = `bytes=${seekStart}-${seekStart + 1023}`;
      const seek = await fetch(session.url, {
        headers: { Range: seekRange },
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(seek.status, 206);
      assert.equal((await seek.arrayBuffer()).byteLength, 1024);
      assert.ok(observedRanges.includes(seekRange));
      assert.equal(prefetchResponse?.writableEnded, false);
    } finally {
      await proxy.shutdown();
      prefetchResponse?.destroy();
      await close(upstream);
    }
  });
}

test("MPEG-TS proxy retains authenticated provider headers without hop-by-hop headers", () => {
  assert.deepEqual(
    sanitizeMpegTsProxyHeaders({
      Cookie: "mac=secret",
      Authorization: "Bearer secret",
      "X-User-Agent": "MAG200",
      SN: "serial",
      Accept: "*/*",
      Range: "bytes=0-",
      Connection: "keep-alive",
      "X-Injected": "bad\r\nvalue",
    }),
    {
      cookie: "mac=secret",
      authorization: "Bearer secret",
      "x-user-agent": "MAG200",
      sn: "serial",
      accept: "*/*",
    },
  );
});

test("HLS proxy serializes concurrent server startup", async () => {
  const proxy = new HlsPlaybackProxyService();
  try {
    const [first, second] = await Promise.all([
      proxy.createSession({ url: "http://127.0.0.1:1/first.m3u8" }),
      proxy.createSession({ url: "http://127.0.0.1:1/second.m3u8" }),
    ]);
    assert.equal(new URL(first.url).origin, new URL(second.url).origin);
  } finally {
    await proxy.shutdown();
  }
});

test("HLS proxy rejects a session racing with shutdown", async () => {
  const proxy = new HlsPlaybackProxyService();
  const creating = proxy.createSession({
    url: "http://127.0.0.1:1/racing.m3u8",
  });
  const shuttingDown = proxy.shutdown();

  await assert.rejects(creating, /shutting down/);
  await shuttingDown;
  assert.equal(proxy.sessionCount, 0);
  await assert.rejects(
    proxy.createSession({ url: "http://127.0.0.1:1/after.m3u8" }),
    /shutting down/,
  );
});

test("HLS proxy pins a successful redirect for live playlist refreshes", async () => {
  let redirects = 0;
  let playlistRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/start.m3u8") {
      redirects += 1;
      response.writeHead(302, { location: `/node-${redirects}.m3u8` }).end();
      return;
    }
    if (request.url?.startsWith("/node-")) {
      playlistRequests += 1;
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${playlistRequests}\n`);
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
    });
    const first = await fetch(session.url);
    const second = await fetch(session.url);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(redirects, 1);
    assert.equal(playlistRequests, 2);
    assert.match(await second.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy refreshes an expired redirect token for live playlists", async () => {
  let redirects = 0;
  let firstTokenRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/start.m3u8") {
      redirects += 1;
      response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
      return;
    }
    if (request.url === "/token-1.m3u8") {
      firstTokenRequests += 1;
      if (firstTokenRequests > 1) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
      return;
    }
    if (request.url === "/token-2.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
    });
    assert.equal((await fetch(session.url)).status, 200);
    const refreshed = await fetch(session.url);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    assert.equal(redirects, 2);
    assert.equal(firstTokenRequests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy refreshes a redirect token after a transient upstream failure", async () => {
  let redirects = 0;
  let firstTokenRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/start.m3u8") {
      redirects += 1;
      response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
      return;
    }
    if (request.url === "/token-1.m3u8") {
      firstTokenRequests += 1;
      if (firstTokenRequests > 1) {
        response.writeHead(509).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
      return;
    }
    if (request.url === "/token-2.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
    });
    assert.equal((await fetch(session.url)).status, 200);
    const refreshed = await fetch(session.url);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    assert.equal(redirects, 2);
    assert.equal(firstTokenRequests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy refreshes a redirect token after an expired-token 406", async () => {
  let redirects = 0;
  let firstTokenRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/start.m3u8") {
      redirects += 1;
      response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
      return;
    }
    if (request.url === "/token-1.m3u8") {
      firstTokenRequests += 1;
      if (firstTokenRequests > 1) {
        response.writeHead(406).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
      return;
    }
    if (request.url === "/token-2.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
    });
    assert.equal((await fetch(session.url)).status, 200);
    const refreshed = await fetch(session.url);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    assert.equal(redirects, 2);
    assert.equal(firstTokenRequests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy refreshes a redirect token after an expired-token 403", async () => {
  let redirects = 0;
  let firstTokenRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/start.m3u8") {
      redirects += 1;
      response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
      return;
    }
    if (request.url === "/token-1.m3u8") {
      firstTokenRequests += 1;
      if (firstTokenRequests > 1) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
      return;
    }
    if (request.url === "/token-2.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
    });
    assert.equal((await fetch(session.url)).status, 200);
    const refreshed = await fetch(session.url);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    assert.equal(redirects, 2);
    assert.equal(firstTokenRequests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy cache-busts an unredirected live URL after an expired-token 403", async () => {
  let playlistRequests = 0;
  let refreshRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url?.startsWith("/live.m3u8")) {
      playlistRequests += 1;
      if (
        new URL(request.url, "http://127.0.0.1").searchParams.has(
          "_arm_nator_refresh",
        )
      ) {
        refreshRequests += 1;
        response.writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl",
        });
        response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n");
        return;
      }
      if (playlistRequests === 1) {
        response.writeHead(200, {
          "content-type": "application/vnd.apple.mpegurl",
        });
        response.end("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
        return;
      }
      response.writeHead(403).end();
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/live.m3u8`,
    });
    assert.equal((await fetch(session.url)).status, 200);
    const refreshed = await fetch(session.url);
    assert.equal(refreshed.status, 200);
    assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    assert.equal(refreshRequests, 1);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy does not pass a regressed live media sequence to HLS.js", async () => {
  let playlistRequests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/live.m3u8") {
      playlistRequests += 1;
      const sequence = playlistRequests === 1 ? 10 : 9;
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n`);
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/live.m3u8`,
    });
    const first = await fetch(session.url);
    const second = await fetch(session.url);
    assert.equal(await first.text(), "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n");
    assert.equal(await second.text(), "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n");
    assert.equal(playlistRequests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy scopes resources to a session, forwards headers, emits CORS, and releases cleanly", async () => {
  const observed: Array<{
    path: string;
    userAgent?: string;
    referer?: string;
    range?: string;
    cacheControl?: string;
    pragma?: string;
  }> = [];
  const upstream = createServer((request, response) => {
    observed.push({
      path: request.url ?? "",
      userAgent: request.headers["user-agent"],
      referer: request.headers.referer,
      range: request.headers.range,
      cacheControl: request.headers["cache-control"],
      pragma: request.headers.pragma,
    });
    if (request.url === "/start.m3u8") {
      response.writeHead(302, { location: "/tokenized/manifest" }).end();
      return;
    }
    if (request.url === "/tokenized/manifest") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?access=secret"\nchunk.ts?access=secret\nchunk.ts?access=secret\n',
      );
      return;
    }
    if (request.url?.startsWith("/tokenized/chunk.ts")) {
      response.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 0-2/3",
      });
      response.end("ts!");
      return;
    }
    if (request.url?.startsWith("/tokenized/key.bin")) {
      response
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end("key");
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/start.m3u8`,
      headers: {
        "User-Agent": "Provider/1.0",
        Referer: "https://provider.example/",
      },
    });
    const manifest = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}` },
    });
    assert.equal(manifest.status, 200);
    assert.equal(
      manifest.headers.get("access-control-allow-origin"),
      `http://localhost:${rendererAppPort}`,
    );
    const body = await manifest.text();
    assert.ok(!body.includes("tokenized"));
    assert.ok(!body.includes("secret"));
    const chunkUrls = body
      .split("\n")
      .filter((line) => line.startsWith("http://"));
    assert.equal(chunkUrls.length, 2);
    assert.equal(new Set(chunkUrls).size, 1);
    const chunkUrl = chunkUrls[0];
    assert.ok(chunkUrl);
    const chunk = await fetch(chunkUrl, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-2" },
    });
    assert.equal(chunk.status, 206);
    assert.equal(await chunk.text(), "ts!");
    assert.deepEqual(observed.at(-1), {
      path: "/tokenized/chunk.ts?access=secret",
      userAgent: "Provider/1.0",
      referer: "https://provider.example/",
      range: "bytes=0-2",
      cacheControl: "no-cache",
      pragma: "no-cache",
    });
    assert.equal(observed[0]?.cacheControl, "no-cache");
    assert.equal(observed[0]?.pragma, "no-cache");

    const denied = await fetch(session.url, {
      headers: { Origin: "https://untrusted.example" },
    });
    assert.equal(denied.status, 403);
    proxy.releaseSession(session.id);
    assert.equal(proxy.sessionCount, 0);
    assert.equal((await fetch(session.url)).status, 404);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy keeps segment URLs usable throughout a session after a large playlist refresh", async () => {
  let start = 0;
  let count = 5_000;
  const upstream = createServer((request, response) => {
    if (request.url === "/live.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end(
        `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${start}\n` +
          Array.from(
            { length: count },
            (_, index) => `#EXTINF:2,\nsegment-${start + index}.ts\n`,
          ).join(""),
      );
      return;
    }
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end(request.url);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({ url: `${upstreamUrl}/live.m3u8` });
    const manifest = await fetch(session.url);
    assert.equal(manifest.status, 200);
    const segmentUrls = (await manifest.text())
      .split("\n")
      .filter((line) => line.startsWith("http://"));
    assert.equal(segmentUrls.length, 5_000);
    for (const index of [0, 4_999]) {
      const segment = await fetch(segmentUrls[index]);
      assert.equal(segment.status, 200);
      assert.equal(await segment.text(), `/segment-${index}.ts`);
    }

    start = 5_000;
    count = 1;
    await (await fetch(session.url)).text();
    const previousSegment = await fetch(segmentUrls[0]);
    assert.equal(previousSegment.status, 200);
    assert.equal(await previousSegment.text(), "/segment-0.ts");

    proxy.releaseSession(session.id);
    assert.equal(proxy.sessionCount, 0);
    assert.equal((await fetch(segmentUrls[0])).status, 404);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("HLS proxy carries source and CDN cookies across redirect hops and child resources", async () => {
  const sourceRequests: Array<{
    path: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  const cdnRequests: Array<{
    path: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  let cdnUrl = "";
  const cdn = createServer((request, response) => {
    const path = request.url ?? "";
    cdnRequests.push({
      path,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    const cookies = request.headers.cookie ?? "";
    if (path === "/playlist.m3u8" && cookies.includes("source-grant=accepted")) {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        "set-cookie": "cdn-session=ready; Path=/",
      });
      response.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nsegment.ts\n',
      );
      return;
    }
    if (
      cookies.includes("source-redirect=one") &&
      cookies.includes("source-grant=accepted") &&
      cookies.includes("cdn-session=ready")
    ) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(path === "/segment.ts" ? "segment" : "key");
      return;
    }
    response.writeHead(401).end("missing playback cookie");
  });
  const cdnBaseUrl = await listen(cdn);
  cdnUrl = `${cdnBaseUrl}/playlist.m3u8`;
  const source = createServer((request, response) => {
    const path = request.url ?? "";
    sourceRequests.push({
      path,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    const cookies = request.headers.cookie ?? "";
    if (path === "/start.m3u8") {
      response.writeHead(302, {
        location: "/challenge",
        "set-cookie": "source-redirect=one; Path=/",
      }).end();
      return;
    }
    if (path === "/challenge" && cookies.includes("source-redirect=one")) {
      response.writeHead(302, {
        location: cdnUrl,
        "set-cookie": "source-grant=accepted; Path=/",
      }).end();
      return;
    }
    response.writeHead(401).end("missing source cookie");
  });
  const sourceUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createSession({
      url: `${sourceUrl}/start.m3u8`,
      headers: {
        Cookie: "provider-session=manual",
        Authorization: "Bearer source-only",
      },
    });
    const manifestResponse = await fetch(session.url);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.text();
    const resourceUrls = manifest
      .split("\n")
      .flatMap((line) => {
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        return uri ? [uri] : line.startsWith("http://") ? [line] : [];
      });
    assert.equal(resourceUrls.length, 2);
    for (const url of resourceUrls) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    }

    assert.deepEqual(sourceRequests.map((request) => request.path), [
      "/start.m3u8",
      "/challenge",
    ]);
    assert.ok(sourceRequests.every((request) =>
      request.cookie?.includes("provider-session=manual"),
    ));
    assert.ok(sourceRequests.every((request) =>
      request.authorization === "Bearer source-only",
    ));
    assert.equal(cdnRequests.length, 3);
    assert.ok(cdnRequests.every((request) =>
      !request.cookie?.includes("provider-session=manual"),
    ));
    assert.ok(cdnRequests.every((request) => request.authorization === undefined));
    assert.ok(cdnRequests[0]?.cookie?.includes("source-grant=accepted"));
    assert.ok(cdnRequests[1]?.cookie?.includes("cdn-session=ready"));
    assert.ok(cdnRequests[2]?.cookie?.includes("cdn-session=ready"));
  } finally {
    await proxy.shutdown();
    await close(source);
    await close(cdn);
  }
});

test("HLS manifest refresh reuses a cookie set by the original 401 response", async () => {
  const requests: Array<{ path: string; cookie?: string }> = [];
  const upstream = createServer((request, response) => {
    const path = request.url ?? "";
    const cookie = request.headers.cookie;
    requests.push({ path, cookie });
    if (cookie?.includes("refresh-session=ready")) {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
      return;
    }
    response.writeHead(401, {
      "set-cookie": "refresh-session=ready; Path=/",
    }).end("challenge");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/live.m3u8`,
    });
    const response = await fetch(session.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /#EXT-X-ENDLIST/);
    assert.equal(requests.length, 2);
    assert.ok(requests[0]?.cookie === undefined);
    assert.ok(requests[1]?.path.includes("_arm_nator_refresh="));
    assert.ok(requests[1]?.cookie?.includes("refresh-session=ready"));
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("playback cookies stay isolated between sessions and are cleared on release", async () => {
  const requests: Array<{ path: string; cookie?: string }> = [];
  const upstream = createServer((request, response) => {
    const path = request.url ?? "";
    const cookie = request.headers.cookie;
    requests.push({ path, cookie });
    if (path === "/seed.m3u8") {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
        "set-cookie": "session-cookie=first; Path=/",
      });
      response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
      return;
    }
    if (cookie?.includes("session-cookie=first")) {
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end("#EXTM3U\n#EXT-X-ENDLIST\n");
      return;
    }
    response.writeHead(401).end("session cookie missing");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const first = await proxy.createSession({
      url: `${upstreamUrl}/seed.m3u8`,
    });
    assert.equal((await fetch(first.url)).status, 200);

    const isolated = await proxy.createSession({
      url: `${upstreamUrl}/check.m3u8`,
    });
    assert.equal((await fetch(isolated.url)).status, 401);
    assert.ok(
      requests
        .filter((request) => request.path.startsWith("/check.m3u8"))
        .every((request) => !request.cookie?.includes("session-cookie=first")),
    );

    proxy.releaseSession(first.id);
    const fresh = await proxy.createSession({
      url: `${upstreamUrl}/check.m3u8`,
    });
    assert.equal((await fetch(fresh.url)).status, 401);
    assert.ok(
      requests
        .filter((request) => request.path.startsWith("/check.m3u8"))
        .every((request) => !request.cookie?.includes("session-cookie=first")),
    );
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD ranges and prefetch reuse cookies without forwarding source credentials", async () => {
  const originalRequests: Array<{
    range?: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  const protectedRequests: Array<{
    range?: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  let markPrefetchStarted!: () => void;
  const prefetchStarted = new Promise<void>((resolve) => {
    markPrefetchStarted = resolve;
  });
  const protectedMedia = createServer((request, response) => {
    protectedRequests.push({
      range: request.headers.range,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    if (request.headers.range === "bytes=4-7") markPrefetchStarted();
    if (!request.headers.cookie?.includes("range-gate=ready")) {
      response.writeHead(401).end("cookie required");
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": length,
      "content-range": `bytes ${start}-${end}/8`,
    });
    response.end(Buffer.alloc(length, 0x61));
  });
  const protectedBaseUrl = await listen(protectedMedia);
  const original = createServer((request, response) => {
    originalRequests.push({
      range: request.headers.range,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    response.writeHead(302, {
      location: `${protectedBaseUrl}/protected.mp4`,
      "set-cookie": "range-gate=ready; Path=/",
    }).end();
  });
  const originalBaseUrl = await listen(original);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${originalBaseUrl}/movie.mp4`,
      headers: {
        Cookie: "provider-session=source-only",
        Authorization: "Bearer source-only",
      },
    });
    const response = await fetch(session.url, {
      headers: { Range: "bytes=0-3" },
    });
    assert.equal(response.status, 206);
    assert.equal(await response.arrayBuffer().then((body) => body.byteLength), 4);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        prefetchStarted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("range prefetch did not start")),
            2000,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    assert.ok(
      originalRequests.every((request) =>
        request.cookie?.includes("provider-session=source-only"),
      ),
    );
    assert.ok(
      originalRequests.every(
        (request) => request.authorization === "Bearer source-only",
      ),
    );
    assert.ok(
      protectedRequests.every((request) =>
        request.cookie?.includes("range-gate=ready"),
      ),
    );
    assert.ok(
      protectedRequests.every(
        (request) =>
          !request.cookie?.includes("provider-session=source-only") &&
          request.authorization === undefined,
      ),
    );
    assert.deepEqual(
      protectedRequests.map((request) => request.range),
      ["bytes=0-3", "bytes=4-7"],
    );
  } finally {
    await proxy.shutdown();
    await close(original);
    await close(protectedMedia);
  }
});

test("MPEG-TS redirect cookies work while source credentials stay on the source origin", async () => {
  const sourceRequests: Array<{
    path: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  const cdnRequests: Array<{
    path: string;
    cookie?: string;
    authorization?: string;
  }> = [];
  let sourceBaseUrl = "";
  const cdn = createServer((request, response) => {
    cdnRequests.push({
      path: request.url ?? "",
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    if (request.url === "/redirect.ts") {
      if (request.headers.cookie?.includes("mpegts-gate=ready")) {
        response.writeHead(302, { location: `${sourceBaseUrl}/final.ts` }).end();
      } else {
        response.writeHead(401).end("cookie required");
      }
      return;
    }
    if (request.headers.cookie?.includes("mpegts-gate=ready")) {
      response.writeHead(200, { "content-type": "video/mp2t" }).end("unexpected");
      return;
    }
    response.writeHead(401).end("cookie required");
  });
  const cdnBaseUrl = await listen(cdn);
  const source = createServer((request, response) => {
    sourceRequests.push({
      path: request.url ?? "",
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
    });
    if (request.url === "/final.ts") {
      response.writeHead(200, { "content-type": "video/mp2t" }).end("stream");
      return;
    }
    response.writeHead(302, {
      location: `${cdnBaseUrl}/redirect.ts`,
      "set-cookie": "mpegts-gate=ready; Path=/",
    }).end();
  });
  sourceBaseUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createMpegTsSession({
      url: `${sourceBaseUrl}/stream.ts`,
      headers: {
        Cookie: "provider-session=source-only",
        Authorization: "Bearer source-only",
      },
    });
    const response = await fetch(session.url, { headers: { Range: "bytes=0-5" } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "stream");
    assert.ok(sourceRequests[0]?.cookie?.includes("provider-session=source-only"));
    assert.equal(sourceRequests[0]?.authorization, "Bearer source-only");
    assert.ok(cdnRequests[0]?.cookie?.includes("mpegts-gate=ready"));
    assert.ok(!cdnRequests[0]?.cookie?.includes("provider-session=source-only"));
    assert.equal(cdnRequests[0]?.authorization, undefined);
    assert.equal(sourceRequests[1]?.path, "/final.ts");
    assert.ok(!sourceRequests[1]?.cookie?.includes("provider-session=source-only"));
    assert.equal(sourceRequests[1]?.authorization, undefined);
  } finally {
    await proxy.shutdown();
    await close(source);
    await close(cdn);
  }
});

test("MPEG-TS proxy forwards Stalker credentials and streams the raw response", async () => {
  const observed: Record<string, string | undefined>[] = [];
  const upstream = createServer((request, response) => {
    observed.push({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      userAgent: request.headers["user-agent"],
      xUserAgent: request.headers["x-user-agent"],
      serial: request.headers.sn,
      range: request.headers.range,
    });
    response.writeHead(200, {
      "content-type": "video/mp2t",
      "transfer-encoding": "chunked",
    });
    response.write("ts");
    setTimeout(() => response.end("!"), 5);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createMpegTsSession({
      url: upstreamUrl,
      headers: {
        Cookie: "mac=secret",
        Authorization: "Bearer secret",
        "User-Agent": "MAG200",
        "X-User-Agent": "MAG200",
        SN: "serial",
      },
    });
    const response = await fetch(session.url, {
      headers: {
        Origin: `http://localhost:${rendererAppPort}`,
        Range: "bytes=0-",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      `http://localhost:${rendererAppPort}`,
    );
    const reader = response.body?.getReader();
    assert.ok(reader);
    let body = "";
    while (body.length < 3) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      body += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();
    assert.equal(body, "ts!");
    assert.deepEqual(observed[0], {
      cookie: "mac=secret",
      authorization: "Bearer secret",
      userAgent: "MAG200",
      xUserAgent: "MAG200",
      serial: "serial",
      range: "bytes=0-",
    });
    proxy.releaseSession(session.id);
    assert.equal((await fetch(session.url)).status, 404);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("automatic MPEG-TS inspection uses the pinned client instead of global fetch", async () => {
  const media = Buffer.alloc(64 * 1024, 0x47);
  const upstream = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp2t",
      "content-length": String(media.length),
    });
    response.end(media);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  const originalFetch = globalThis.fetch;
  let session: Awaited<ReturnType<typeof proxy.createAutoSession>> | undefined;
  try {
    globalThis.fetch = (() => {
      throw new Error("Automatic playback used Electron's global fetch.");
    }) as typeof globalThis.fetch;
    session = await proxy.createAutoSession(upstreamUrl);
    globalThis.fetch = originalFetch;

    const response = await fetch(session.url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), media);
  } finally {
    globalThis.fetch = originalFetch;
    if (session) await proxy.releaseSession(session.id);
    await proxy.shutdown();
    await close(upstream);
  }
});

test("MPEG-TS proxy preserves EOF and opens a fresh upstream on the next request", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end(`part-${requests}\n`);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createMpegTsSession({ url: upstreamUrl });
    const first = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}` },
    });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "part-1\n");
    const second = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}` },
    });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "part-2\n");
    assert.equal(requests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("MPEG-TS proxy ends an upstream that stops producing bytes", async () => {
  let requests = 0;
  const upstream = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "video/mp2t" });
    if (requests === 1) {
      response.write("part-1\n");
      return;
    }
    response.end(`part-${requests}\n`);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  try {
    const session = await proxy.createMpegTsSession({ url: upstreamUrl });
    const first = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}` },
    });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "part-1\n");
    const second = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}` },
    });
    assert.equal(second.status, 200);
    assert.equal(await second.text(), "part-2\n");
    assert.equal(requests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("playback proxy does not sweep a session with an active request", async () => {
  const proxy = new HlsPlaybackProxyService();
  try {
    const created = await proxy.createMpegTsSession({
      url: "http://127.0.0.1:1/live.ts",
    });
    const internals = proxy as unknown as {
      sessions: Map<
        string,
        {
          lastUsedAt: number;
          requests: Set<AbortController>;
        }
      >;
      sweepExpiredSessions(): void;
    };
    const session = internals.sessions.get(created.id);
    assert.ok(session);
    session.lastUsedAt = 0;
    const activeRequest = new AbortController();
    session.requests.add(activeRequest);

    internals.sweepExpiredSessions();
    assert.equal(proxy.sessionCount, 1);

    session.requests.delete(activeRequest);
    internals.sweepExpiredSessions();
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
  }
});

test("HLS proxy does not apply live sequence pinning to an ended VOD playlist", async () => {
  let requests = 0;
  const upstream = createServer((request, response) => {
    if (request.url === "/vod.m3u8") {
      requests += 1;
      response.writeHead(200, {
        "content-type": "application/vnd.apple.mpegurl",
      });
      response.end(
        `#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MEDIA-SEQUENCE:${requests === 1 ? 10 : 9}\n#EXT-X-ENDLIST\n`,
      );
      return;
    }
    response.writeHead(404).end();
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createSession({
      url: `${upstreamUrl}/vod.m3u8`,
    });
    const first = await fetch(session.url);
    const second = await fetch(session.url);
    assert.match(await first.text(), /MEDIA-SEQUENCE:10/);
    assert.match(await second.text(), /MEDIA-SEQUENCE:9/);
    assert.equal(requests, 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD proxy preserves browser ranges and prefetches the next range privately", async () => {
  const prefetchBytes = 25 * 1024 * 1024;
  const totalBytes = 64 * 1024 * 1024;
  const observedRanges: string[] = [];
  const upstream = createServer((request, response) => {
    if (request.headers.range) {
      observedRanges.push(request.headers.range);
    }
    const range = request.headers.range ?? "bytes=0-0";
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": length,
      "content-range": `bytes ${start}-${end}/${totalBytes}`,
      "content-type": "video/mp4",
    });
    response.end(Buffer.alloc(length, 0x61));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-65535" },
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes 0-65535/${totalBytes}`,
    );
    assert.equal(response.headers.get("content-length"), "65536");
    assert.equal((await response.arrayBuffer()).byteLength, 65536);

    const next = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=65536-131071" },
    });
    assert.equal(next.status, 206);
    assert.equal(
      next.headers.get("content-range"),
      `bytes 65536-131071/${totalBytes}`,
    );
    assert.equal((await next.arrayBuffer()).byteLength, 65536);
    assert.deepEqual(observedRanges, [
      "bytes=0-65535",
      `bytes=65536-${65536 + prefetchBytes - 1}`,
    ]);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD re-resolves one-request redirect tokens for later ranges", async () => {
  let redirectCount = 0;
  const usedTokens = new Set<string>();
  const upstream = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://upstream.test");
    if (requestUrl.pathname === "/movie.mp4" && !requestUrl.search) {
      redirectCount += 1;
      response
        .writeHead(302, {
          location: `/movie.mp4?token=${redirectCount}`,
        })
        .end();
      return;
    }

    const token = requestUrl.searchParams.get("token");
    if (!token || usedTokens.has(token)) {
      response.writeHead(406).end();
      return;
    }
    usedTokens.add(token);

    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": length,
      "content-range": `bytes ${start}-${end}/16777216`,
      "content-type": "video/mp4",
    });
    response.end(Buffer.alloc(length, 0x64));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const first = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-65535" },
    });
    assert.equal(first.status, 206);
    await first.arrayBuffer();

    const second = await fetch(session.url, {
      headers: {
        Origin: `http://localhost:${rendererAppPort}`,
        Range: "bytes=9000000-9065535",
      },
    });
    assert.equal(second.status, 206);
    assert.equal(
      second.headers.get("content-range"),
      "bytes 9000000-9065535/16777216",
    );
    await second.arrayBuffer();
    assert.ok(redirectCount >= 2);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD proxy widens a rejected narrow upstream range but returns the exact browser range", async () => {
  const prefetchBytes = 25 * 1024 * 1024;
  const totalBytes = 64 * 1024 * 1024;
  const observedRanges: string[] = [];
  const upstream = createServer((request, response) => {
    const range = request.headers.range ?? "";
    observedRanges.push(range);
    if (range === "bytes=0-65535") {
      response.writeHead(406).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": length,
      "content-range": `bytes ${start}-${end}/${totalBytes}`,
      "content-type": "video/mp4",
    });
    response.end(Buffer.alloc(length, 0x62));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-65535" },
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes 0-65535/${totalBytes}`,
    );
    assert.equal(response.headers.get("content-length"), "65536");
    assert.equal((await response.arrayBuffer()).byteLength, 65536);
    assert.deepEqual(observedRanges.slice(0, 2), [
      "bytes=0-65535",
      `bytes=0-${prefetchBytes - 1}`,
    ]);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD proxy converts open-ended browser ranges into finite cacheable ranges", async () => {
  const prefetchBytes = 25 * 1024 * 1024;
  const totalBytes = 64 * 1024 * 1024;
  const observedRanges: string[] = [];
  const upstream = createServer((request, response) => {
    const range = request.headers.range ?? "";
    observedRanges.push(range);
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const length = end - start + 1;
    response.writeHead(206, {
      "accept-ranges": "bytes",
      "content-length": length,
      "content-range": `bytes ${start}-${end}/${totalBytes}`,
      "content-type": "video/mp4",
    });
    response.end(Buffer.alloc(length, 0x63));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=65536-" },
    });
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes 65536-${65536 + prefetchBytes - 1}/${totalBytes}`,
    );
    assert.equal(response.headers.get("content-length"), null);
    assert.equal((await response.arrayBuffer()).byteLength, prefetchBytes);
    assert.equal(observedRanges[0], `bytes=65536-${65536 + prefetchBytes - 1}`);

    const overlap = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=70000-" },
    });
    assert.equal(overlap.status, 206);
    const overlapRange = overlap.headers.get("content-range") ?? "";
    const overlapMatch = new RegExp(`^bytes 70000-(\\d+)/${totalBytes}$`).exec(
      overlapRange,
    );
    assert.ok(overlapMatch);
    const overlapEnd = Number(overlapMatch[1]);
    assert.ok(
      [65536 + prefetchBytes - 1, 65536 + prefetchBytes * 2 - 1].includes(
        overlapEnd,
      ),
    );
    assert.equal(
      (await overlap.arrayBuffer()).byteLength,
      overlapEnd - 70000 + 1,
    );

    const tail = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=50000000-" },
    });
    assert.equal(tail.status, 206);
    assert.equal(
      tail.headers.get("content-range"),
      `bytes 50000000-${65536 + prefetchBytes * 2 - 1}/${totalBytes}`,
    );
    await tail.arrayBuffer();
    assert.ok(
      observedRanges.includes(
        `bytes=${65536 + prefetchBytes}-${65536 + prefetchBytes * 2 - 1}`,
      ),
    );
    assert.ok(
      !observedRanges.some((range) => range.startsWith("bytes=70000-")),
    );
    assert.ok(
      !observedRanges.some((range) => range.startsWith("bytes=50000000-")),
    );
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("native movie relay reads successive finite upstream ranges without ending playback", async () => {
  const chunkBytes = 25 * 1024 * 1024;
  const total = chunkBytes * 2 + 17;
  const ranges: string[] = [];
  const upstream = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    assert.ok(match);
    ranges.push(request.headers.range!);
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), total - 1);
    response.writeHead(206, {
      "content-type": "video/mp4", "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${total}`,
    });
    response.end(Buffer.alloc(end - start + 1, 0x61));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({ url: `${upstreamUrl}/movie.mp4` });
    const response = await fetch(session.url + "/continuous", {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-" },
    });
    assert.equal(response.headers.get("content-range"), `bytes 0-${total - 1}/${total}`);
    assert.equal(response.headers.get("content-length"), String(total));
    assert.equal((await response.arrayBuffer()).byteLength, total);
    assert.deepEqual(ranges, [
      `bytes=0-${chunkBytes - 1}`, `bytes=${chunkBytes}-${chunkBytes * 2 - 1}`,
      `bytes=${chunkBytes * 2}-${total - 1}`,
    ]);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD retains a 502 response when upstream fails before sending headers", async () => {
  const upstream = createServer((_request, response) => response.destroy());
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({ url: `${upstreamUrl}/movie.mp4` });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-" },
    });
    assert.equal(response.status, 502);
    await response.arrayBuffer();
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD continues a dropped upstream body at its exact byte offset", async () => {
  const bytes = Buffer.alloc(256 * 1024, 0x6a);
  const ranges: string[] = [];
  const upstream = createServer((request, response) => {
    const range = request.headers.range ?? "";
    ranges.push(range);
    const start = Number(/^bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    const end = bytes.length - 1;
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
      etag: '"movie-v1"',
    });
    if (ranges.length === 1) {
      response.write(bytes.subarray(0, 65536), () => response.destroy());
    } else {
      assert.equal(request.headers["if-range"], '"movie-v1"');
      response.end(bytes.subarray(start));
    }
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({ url: `${upstreamUrl}/movie.mp4` });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-" },
    });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.equal(ranges[1], `bytes=65536-${bytes.length - 1}`);
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("progressive VOD proxy rejects an upstream range larger than its cache budget", async () => {
  const oversizedLength = 50 * 1024 * 1024 + 1;
  const upstream = createServer((_request, response) => {
    response.writeHead(206, {
      "content-length": oversizedLength,
      "content-range": `bytes 0-${oversizedLength - 1}/${oversizedLength}`,
      "content-type": "video/mp4",
    });
    response.end(Buffer.alloc(oversizedLength, 0x65));
  });
  const upstreamUrl = await listen(upstream);
  const proxy = new HlsPlaybackProxyService();
  try {
    const session = await proxy.createProgressiveVodSession({
      url: `${upstreamUrl}/movie.mp4`,
    });
    const response = await fetch(session.url, {
      headers: { Origin: `http://localhost:${rendererAppPort}`, Range: "bytes=0-65535" },
    });
    assert.equal(response.status, 502);
    await response.arrayBuffer();
  } finally {
    await proxy.shutdown();
    await close(upstream);
  }
});

test("DASH proxy preserves MPD bytes and isolates selected account headers across redirects and resources", async () => {
  const rootRequests: Array<Record<string, string | undefined>> = [];
  const edgeRequests: Array<{ path: string; headers: Record<string, string | undefined> }> = [];
  const licenseRootRequests: Array<{ body: Buffer; headers: Record<string, string | undefined> }> = [];
  const licenseRequests: Array<{ body: Buffer; headers: Record<string, string | undefined> }> = [];
  const edge = createServer((request, response) => {
    edgeRequests.push({
      path: request.url ?? "",
      headers: {
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
        sn: request.headers.sn,
        "x-user-agent": request.headers["x-user-agent"],
        range: request.headers.range,
      },
    });
    if ((request.url ?? "").startsWith("/manifest.mpd")) {
      response.writeHead(200, { "content-type": "application/dash+xml" });
      response.end(mpdBytes);
      return;
    }
    if (request.url === "/chunk-7.m4s") {
      response.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": "bytes 2-5/8",
        "content-length": "4",
        "retry-after": "12",
      });
      response.end(Buffer.from([2, 3, 4, 5]));
      return;
    }
    response.writeHead(404).end();
  });
  const edgeUrl = await listen(edge);
  const root = createServer((request, response) => {
    rootRequests.push({
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      sn: request.headers.sn,
      "x-user-agent": request.headers["x-user-agent"],
    });
    response.writeHead(302, { location: `${edgeUrl}/manifest.mpd` }).end();
  });
  const rootUrl = await listen(root);
  const foreignLicense = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      licenseRequests.push({
        body: Buffer.concat(chunks),
        headers: {
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          sn: request.headers.sn,
          "x-license-token": request.headers["x-license-token"],
        },
      });
      response.writeHead(201, {
        "content-type": "application/octet-stream",
        "content-length": "4",
      });
      response.end(Buffer.from([9, 8, 7, 6]));
    });
  });
  const foreignLicenseUrl = await listen(foreignLicense);
  const license = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      licenseRootRequests.push({
        body: Buffer.concat(chunks),
        headers: {
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
          sn: request.headers.sn,
          "x-license-token": request.headers["x-license-token"],
        },
      });
      response.writeHead(307, { location: `${foreignLicenseUrl}/license-final` });
      response.end();
    });
  });
  const licenseUrl = await listen(license);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
  const accountA = `dash-account-a-${crypto.randomUUID()}`;
  const accountB = `dash-account-b-${crypto.randomUUID()}`;
  const mpdBytes = '<?xml version="1.0"?><MPD><Period><SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$Number$.m4s"/></Period></MPD>';
  const sessions: Array<{ id: string; url: string }> = [];
  try {
    for (const [accountRef, suffix] of [[accountA, "a"], [accountB, "b"]] as const) {
      playbackAccountProfiles.replacePortalHeaders(accountRef, {
        Cookie: `mac=mac-${suffix}`,
        Authorization: `Bearer portal-${suffix}`,
        SN: `serial-${suffix}`,
        "X-User-Agent": `MAG/${suffix}`,
        "User-Agent": `MAG/${suffix}`,
        Origin: rootUrl,
        Referer: rootUrl,
      });
      playbackAccountProfiles.captureLoginCookies(
        accountRef,
        rootUrl,
        [`api-cookie-${suffix}=api-${suffix}; Path=/; HttpOnly`],
      );
    }

    const ordinary = await proxy.createDashSession({ url: `${rootUrl}/redirect.mpd` });
    sessions.push(ordinary);
    const ordinaryManifest = await fetch(ordinary.url);
    assert.equal(ordinaryManifest.status, 200);
    assert.equal(await ordinaryManifest.text(), mpdBytes);

    const selectedA = await proxy.createDashSession({
      url: `${rootUrl}/redirect.mpd`,
      requestPolicy: {
        accountRef: accountA,
        loginCookies: true,
        portalCredentials: true,
        licenseProxy: true,
      },
    });
    sessions.push(selectedA);
    const selectedAManifest = await fetch(selectedA.url);
    assert.equal(selectedAManifest.status, 200);
    assert.equal(await selectedAManifest.text(), mpdBytes);

    const selectedB = await proxy.createDashSession({
      url: `${rootUrl}/redirect.mpd`,
      requestPolicy: {
        accountRef: accountB,
        loginCookies: true,
        portalCredentials: true,
      },
    });
    sessions.push(selectedB);
    const selectedBManifest = await fetch(selectedB.url);
    assert.equal(selectedBManifest.status, 200);
    assert.equal(await selectedBManifest.text(), mpdBytes);

    const resourceA = proxy.registerDashResource(
      selectedA.id,
      `${edgeUrl}/chunk-7.m4s`,
      "segment",
    );
    const rangeA = await fetch(resourceA, { headers: { Range: "bytes=2-5" } });
    assert.equal(rangeA.status, 206);
    assert.equal(rangeA.headers.get("content-range"), "bytes 2-5/8");
    assert.equal(rangeA.headers.get("retry-after"), "12");
    assert.deepEqual(Buffer.from(await rangeA.arrayBuffer()), Buffer.from([2, 3, 4, 5]));

    const resourceB = proxy.registerDashResource(
      selectedB.id,
      `${edgeUrl}/chunk-7.m4s`,
      "segment",
    );
    const rangeB = await fetch(resourceB, { headers: { Range: "bytes=2-5" } });
    assert.equal(rangeB.status, 206);
    await rangeB.arrayBuffer();

    const licenseRelay = proxy.registerDashLicense(
      selectedA.id,
      `${licenseUrl}/license`,
      {
        Authorization: "Bearer license-only",
        Cookie: "license-cookie=selected",
        "X-License-Token": "configured",
      },
    );
    const licenseBody = Buffer.from([1, 3, 5, 7]);
    const licenseResponse = await fetch(licenseRelay, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: licenseBody,
    });
    assert.equal(licenseResponse.status, 201);
    assert.deepEqual(Buffer.from(await licenseResponse.arrayBuffer()), Buffer.from([9, 8, 7, 6]));

    assert.deepEqual(rootRequests.slice(0, 3), [
      { cookie: undefined, authorization: undefined, sn: undefined, "x-user-agent": undefined },
      {
        cookie: "mac=mac-a; api-cookie-a=api-a",
        authorization: "Bearer portal-a",
        sn: "serial-a",
        "x-user-agent": "MAG/a",
      },
      {
        cookie: "mac=mac-b; api-cookie-b=api-b",
        authorization: "Bearer portal-b",
        sn: "serial-b",
        "x-user-agent": "MAG/b",
      },
    ]);
    assert.deepEqual(edgeRequests.slice(0, 3).map((entry) => entry.headers), [
      {
        cookie: undefined,
        authorization: undefined,
        sn: undefined,
        "x-user-agent": undefined,
        range: undefined,
      },
      {
        cookie: "mac=mac-a; api-cookie-a=api-a",
        authorization: "Bearer portal-a",
        sn: "serial-a",
        "x-user-agent": "MAG/a",
        range: undefined,
      },
      {
        cookie: "mac=mac-b; api-cookie-b=api-b",
        authorization: "Bearer portal-b",
        sn: "serial-b",
        "x-user-agent": "MAG/b",
        range: undefined,
      },
    ]);
    assert.equal(edgeRequests[3]?.headers.range, "bytes=2-5");
    assert.equal(edgeRequests[3]?.headers.authorization, "Bearer portal-a");
    assert.equal(edgeRequests[4]?.headers.authorization, "Bearer portal-b");
    assert.deepEqual(licenseRootRequests, [{
      body: licenseBody,
      headers: {
        authorization: "Bearer license-only",
        cookie: "license-cookie=selected",
        sn: undefined,
        "x-license-token": "configured",
      },
    }]);
    assert.deepEqual(licenseRequests, [{
      body: licenseBody,
      headers: {
        authorization: undefined,
        cookie: undefined,
        sn: undefined,
        "x-license-token": "configured",
      },
    }]);
    assert.deepEqual(
      await (async () => {
        const result = await fetch(ordinary.url);
        await result.arrayBuffer();
        return rootRequests.at(-1);
      })(),
      { cookie: undefined, authorization: undefined, sn: undefined, "x-user-agent": undefined },
    );
  } finally {
    for (const session of sessions) await proxy.releaseSessionAndWait(session.id);
    playbackAccountProfiles.clear(accountA);
    playbackAccountProfiles.clear(accountB);
    await proxy.shutdown();
    await close(root);
    await close(edge);
    await close(license);
    await close(foreignLicense);
  }
});

for (const isLive of [true, false]) {
  test(`MPEG-TS ${isLive ? "launch failure falls back to raw bytes" : "VOD preserves ranges and EOF with a remuxer configured"}`, async () => {
    let requests = 0;
    const upstream = createServer((request, response) => {
      requests += 1;
      assert.equal(request.headers.authorization, "Bearer secret");
      assert.equal(request.headers.range, "bytes=2-4");
      response.writeHead(206, {
        "content-type": "video/mp2t",
        "content-range": "bytes 2-4/5",
        "content-length": "3",
      });
      response.end("ts!");
    });
    const url = await listen(upstream);
    // Node is executable but cannot run FFmpeg arguments. VOD must never launch it.
    const proxy = new HlsPlaybackProxyService({
      mpegTsRemuxerPath: isLive ? "/nonexistent/arm-nator-ffmpeg" : process.execPath,
    });
    try {
      const session = await proxy.createMpegTsSession({
        url, isLive, headers: { Authorization: "Bearer secret" },
      });
      const response = await fetch(session.url, {
        headers: { Range: "bytes=2-4" },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get("content-range"), "bytes 2-4/5");
      assert.equal(await response.text(), "ts!");
      assert.equal(requests, 1);
    } finally {
      await proxy.shutdown();
      await close(upstream);
    }
  });
}
