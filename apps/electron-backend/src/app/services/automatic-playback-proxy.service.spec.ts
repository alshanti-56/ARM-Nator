import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  PlaybackDiagnosticsStore,
  type PlaybackDiagnosticInput,
} from "./playback-diagnostics.service";
import {
  HlsPlaybackProxyService,
  type AutoPlaybackProxySession,
} from "./hls-playback-proxy.service";
import { MediaInspectionError } from "./media-response-inspection";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function mpegTsPackets(count = 3): Buffer {
  const body = Buffer.alloc(count * 188, 0xff);
  for (let offset = 0; offset < body.length; offset += 188) body[offset] = 0x47;
  return body;
}

function service(options: { startupHeaderTimeoutMs?: number; startupPrefixTimeoutMs?: number } = {}): HlsPlaybackProxyService {
  return new HlsPlaybackProxyService({
    mpegTsRemuxerPath: null,
    ...options,
  });
}

class CapturedDiagnostics extends PlaybackDiagnosticsStore {
  readonly records: PlaybackDiagnosticInput[] = [];

  constructor() {
    super({ filePath: "/tmp/arm-nator-auto-inspection-test.jsonl" });
  }

  override record(input: PlaybackDiagnosticInput): void {
    this.records.push(input);
  }
}

test("extensionless HLS is prepared with one upstream GET and serves that same response locally", async () => {
  let upstreamGets = 0;
  const source = createServer((_request, response) => {
    upstreamGets += 1;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts\n");
  });
  const sourceUrl = await listen(source);
  const diagnostics = new CapturedDiagnostics();
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null, diagnostics });
  try {
    const session = await proxy.createAutoSession(`${sourceUrl}/stream/token`, undefined, false);
    assert.equal(session.format, "hls");
    assert.equal(session.container, "hls");
    assert.equal(new URL(session.url).pathname.split("/")[1], "hls");

    const response = await fetch(session.url);
    assert.equal(response.status, 200);
    const manifest = await response.text();
    assert.match(manifest, /#EXTM3U/);
    assert.match(manifest, /http:\/\/127\.0\.0\.1:\d+\/hls\//);
    assert.equal(upstreamGets, 1);
    const inspection = diagnostics.records.find((record) => record.event === "auto-media-inspected");
    assert.equal(inspection?.status, 200);
    assert.equal(inspection?.sessionId, session.id);
    assert.equal(inspection?.details, "format=hls;container=hls");
    await proxy.releaseSessionAndWait(session.id);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("a TS signature overrides a misleading MP4 MIME type and URL", async () => {
  let upstreamGets = 0;
  const body = mpegTsPackets();
  const source = createServer((_request, response) => {
    upstreamGets += 1;
    response.writeHead(200, { "content-type": "video/mp4" });
    response.end(body);
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  try {
    const session = await proxy.createAutoSession(`${sourceUrl}/film.mp4`, undefined, false);
    assert.equal(session.format, "mpegts");
    assert.equal(session.container, "mpegts");
    assert.equal(new URL(session.url).pathname.split("/")[1], "stream");
    const response = await fetch(session.url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.equal(upstreamGets, 1);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("a Range bytes=0- startup request reuses the prepared full MP4 response", async () => {
  let upstreamGets = 0;
  const body = Buffer.from("\0\0\0\x18ftypisom-an-entire-movie");
  const source = createServer((_request, response) => {
    upstreamGets += 1;
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  try {
    const session = await proxy.createAutoSession(`${sourceUrl}/opaque`, undefined, false);
    assert.equal(session.format, "progressive");
    assert.equal(session.container, "mp4");
    const response = await fetch(session.url, { headers: { Range: "bytes=0-" } });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.equal(upstreamGets, 1);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

for (const status of [401, 403]) {
  test(`automatic preparation rejects HTTP ${status} without returning a player session`, async () => {
    let upstreamGets = 0;
    const source = createServer((_request, response) => {
      upstreamGets += 1;
      response.writeHead(status, { "content-type": "application/vnd.apple.mpegurl" });
      response.end("#EXTM3U\n");
    });
    const sourceUrl = await listen(source);
    const diagnostics = new CapturedDiagnostics();
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null, diagnostics });
    try {
      await assert.rejects(
        proxy.createAutoSession(`${sourceUrl}/stream`, undefined, true),
        (error: unknown) =>
          error instanceof MediaInspectionError &&
          error.code === "http-error" &&
          error.status === status,
      );
      assert.equal(proxy.sessionCount, 0);
      assert.equal(upstreamGets, 1);
      const inspection = diagnostics.records.find((record) => record.event === "auto-media-inspected");
      assert.equal(inspection?.status, status);
      assert.equal(inspection?.details, "format=unknown;reason=http-error");
    } finally {
      await proxy.shutdown();
      await close(source);
    }
  });
}

test("automatic preparation rejects HTML login responses even when MIME and URL claim TS", async () => {
  const source = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end("<!doctype html><html><body>Sign in</body></html>");
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  try {
    await assert.rejects(
      proxy.createAutoSession(`${sourceUrl}/live.ts`, undefined, true),
      (error: unknown) =>
        error instanceof MediaInspectionError &&
        error.code === "html-response" &&
        error.status === 200,
    );
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("automatic preparation creates a DASH proxy and serves registered children", async () => {
  const manifest = '<?xml version="1.0"?><MPD type="static"><BaseURL>segments/</BaseURL></MPD>';
  const segment = Buffer.from([4, 5, 6, 7]);
  const source = createServer((request, response) => {
    if (request.url === "/manifest") {
      response.writeHead(200, { "content-type": "application/dash+xml" });
      response.end(manifest);
      return;
    }
    if (request.url === "/segments/chunk-1.m4s") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(segment);
      return;
    }
    response.writeHead(404).end();
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  let session: AutoPlaybackProxySession | undefined;
  try {
    session = await proxy.createAutoSession(`${sourceUrl}/manifest`, undefined, false);
    assert.equal(session.format, "dash");
    assert.equal(session.container, "dash");
    assert.equal(proxy.sessionCount, 1);

    const manifestResponse = await fetch(session.url);
    assert.equal(manifestResponse.status, 200);
    assert.equal(await manifestResponse.text(), manifest);

    const child = proxy.registerDashResource(
      session.id,
      `${sourceUrl}/segments/chunk-1.m4s`,
      "segment",
    );
    const childResponse = await fetch(child);
    assert.equal(childResponse.status, 200);
    assert.deepEqual(Buffer.from(await childResponse.arrayBuffer()), segment);
  } finally {
    if (session) await proxy.releaseSessionAndWait(session.id);
    await proxy.shutdown();
    await close(source);
  }
});

test("automatic preparation times out a stalled response header", async () => {
  let requestClosed!: () => void;
  const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
  const source = createServer((_request, response) => response.once("close", requestClosed));
  const sourceUrl = await listen(source);
  const proxy = service({ startupHeaderTimeoutMs: 60 });
  try {
    await assert.rejects(
      proxy.createAutoSession(`${sourceUrl}/hang`, undefined, true),
      (error: unknown) =>
        error instanceof MediaInspectionError &&
        error.code === "startup-timeout" &&
        error.status === null,
    );
    await closed;
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("automatic preparation cancels a stalled body prefix at its deadline", async () => {
  let requestClosed!: () => void;
  const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
  const source = createServer((_request, response) => {
    response.once("close", requestClosed);
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("unknown body prefix");
  });
  const sourceUrl = await listen(source);
  const proxy = service({ startupPrefixTimeoutMs: 60 });
  try {
    await assert.rejects(
      proxy.createAutoSession(`${sourceUrl}/opaque`, undefined, true),
      (error: unknown) =>
        error instanceof MediaInspectionError &&
        error.code === "startup-timeout" &&
        error.status === 200,
    );
    await closed;
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("cancelAutoSession aborts inspection before createAutoSession resolves", async () => {
  let requestClosed!: () => void;
  let hasClosed = false;
  const closed = new Promise<void>((resolve) => { requestClosed = resolve; });
  let requestSeen!: () => void;
  const seen = new Promise<void>((resolve) => { requestSeen = resolve; });
  const source = createServer((_request, response) => {
    requestSeen();
    response.once("close", () => {
      hasClosed = true;
      requestClosed();
    });
  });
  const sourceUrl = await listen(source);
  const proxy = service({ startupHeaderTimeoutMs: 5_000 });
  try {
    const preparing = proxy.createAutoSession(`${sourceUrl}/hang`, undefined, true, "attempt-1");
    await seen;
    await proxy.cancelAutoSession("attempt-1");
    await assert.rejects(preparing, (error: unknown) =>
      error instanceof MediaInspectionError && error.code === "cancelled",
    );
    await closed;
    assert.equal(hasClosed, true);
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("same-origin redirect cookies survive the prepared request and remain session scoped", async () => {
  const seen: string[] = [];
  const source = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const profile = url.pathname.split("/")[1];
    seen.push(`${profile}:${request.headers.cookie ?? ""}`);
    if (url.pathname.endsWith("/start")) {
      response.writeHead(302, {
        location: `/${profile}/playlist`,
        "set-cookie": `redirect=${profile}; Path=/`,
      });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end("#EXTM3U\n#EXTINF:2,\nsegment.ts\n");
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  const sessions: AutoPlaybackProxySession[] = [];
  try {
    for (const profile of ["alpha", "beta"]) {
      const session = await proxy.createAutoSession(
        `${sourceUrl}/${profile}/start`,
        { Cookie: `account=${profile}` },
        false,
      );
      sessions.push(session);
      assert.equal(session.format, "hls");
    }
    for (const session of sessions) {
      const response = await fetch(session.url);
      assert.match(await response.text(), /#EXTM3U/);
    }
    assert.deepEqual(seen, [
      "alpha:account=alpha",
      "alpha:redirect=alpha; account=alpha",
      "beta:account=beta",
      "beta:redirect=beta; account=beta",
    ]);
  } finally {
    for (const session of sessions) await proxy.releaseSessionAndWait(session.id);
    await proxy.shutdown();
    await close(source);
  }
});

test("releaseSessionAndWait drains an active local handler before a replacement request", async () => {
  let downstreamStarted!: () => void;
  const started = new Promise<void>((resolve) => { downstreamStarted = resolve; });
  const source = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.write(mpegTsPackets());
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  let session: AutoPlaybackProxySession | undefined;
  let replacement: AutoPlaybackProxySession | undefined;
  try {
    session = await proxy.createAutoSession(`${sourceUrl}/live`, undefined, true);
    const internals = proxy as unknown as {
      sessions: Map<string, { activeHandlers: Set<Promise<void>>; requests: Set<AbortController> }>;
    };
    const preparedSession = internals.sessions.get(session.id);
    assert.ok(preparedSession);
    const client = fetch(session.url).then(async (response) => {
      downstreamStarted();
      await response.arrayBuffer();
    }).catch(() => undefined);
    await started;
    assert.equal(preparedSession.activeHandlers.size, 1);
    await proxy.releaseSessionAndWait(session.id);
    assert.equal(preparedSession.activeHandlers.size, 0, "release waits for the local stream handler to settle");
    assert.equal(preparedSession.requests.size, 0, "release drains every local upstream read controller");
    assert.equal(proxy.sessionCount, 0);
    replacement = await proxy.createAutoSession(`${sourceUrl}/replacement`, undefined, true);
    await client;
  } finally {
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    if (replacement) await proxy.releaseSessionAndWait(replacement.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});

test("disconnecting the local client aborts the warmed upstream response", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const source = createServer((_request, response) => {
    response.once("close", upstreamClosed);
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.write(mpegTsPackets());
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  let session: AutoPlaybackProxySession | undefined;
  try {
    session = await proxy.createAutoSession(`${sourceUrl}/live`, undefined, false);
    const playerResponse = await fetch(session.url);
    await playerResponse.body?.cancel();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Timed out waiting for the warmed upstream to close after client disconnect.")), 2_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  } finally {
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});

test("releaseSessionAndWait cancels an unused warmed media response", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
  const source = createServer((_request, response) => {
    response.once("close", upstreamClosed);
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.write(mpegTsPackets());
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  let session: AutoPlaybackProxySession | undefined;
  try {
    session = await proxy.createAutoSession(`${sourceUrl}/live`, undefined, true);
    await proxy.releaseSessionAndWait(session.id);
    await closed;
    assert.equal(proxy.sessionCount, 0);
  } finally {
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});
