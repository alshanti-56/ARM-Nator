import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { rendererAppPort } from "../constants";
import {
  HlsPlaybackProxyService,
  resolveHlsProxyTarget,
  rewriteHlsManifest,
  sanitizeHlsProxyHeaders,
  sanitizeMpegTsProxyHeaders,
} from "./hls-playback-proxy.service";

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
    resolveHlsProxyTarget("../next.ts?x=1", target),
    "https://tokenized.example/next.ts?x=1",
  );
});

test("HLS proxy only retains safe provider headers", () => {
  assert.deepEqual(
    sanitizeHlsProxyHeaders({
      "User-Agent": " Provider/1.0 ",
      Referer: "https://provider.example/",
      Cookie: "session=secret",
      "X-Injected": "bad\r\nvalue",
    }),
    { "user-agent": "Provider/1.0", referer: "https://provider.example/" },
  );
});

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
