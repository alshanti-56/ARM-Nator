import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  HlsPlaybackProxyService,
  type AutoPlaybackProxySession,
} from "./hls-playback-proxy.service";
import {
  PlaybackDiagnosticsStore,
  type PlaybackDiagnosticInput,
} from "./playback-diagnostics.service";
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

function tsPackets(): Buffer {
  const body = Buffer.alloc(3 * 188, 0xff);
  for (let offset = 0; offset < body.length; offset += 188) body[offset] = 0x47;
  return body;
}

class CapturedDiagnostics extends PlaybackDiagnosticsStore {
  readonly records: PlaybackDiagnosticInput[] = [];

  constructor() {
    super({ filePath: "/tmp/arm-nator-cookie-challenge-test.jsonl" });
  }

  override record(input: PlaybackDiagnosticInput): void {
    this.records.push(input);
  }
}

function service(options: { startupHeaderTimeoutMs?: number } = {}): HlsPlaybackProxyService {
  return new HlsPlaybackProxyService({ mpegTsRemuxerPath: null, ...options });
}

test("retries one redirecting 401 challenge with the learned CDN cookie and reuses the 200 manifest", async () => {
  const sourceSeen: string[] = [];
  const cdnSeen: Array<{ path: string; cookie: string; authorization: string }> = [];
  let sourceRedirects = 0;
  let manifestRequests = 0;
  let challengeBodyClosed = false;
  let challengeClosedBeforeRetry = false;
  const source = createServer((request, response) => {
    sourceRedirects += 1;
    sourceSeen.push(`${request.headers.cookie ?? ""}|${request.headers.authorization ?? ""}`);
    response.writeHead(302, { location: `${cookieScopedCdnUrl}/manifest.m3u8` });
    response.end();
  });
  const cdn = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    cdnSeen.push({
      path,
      cookie: request.headers.cookie ?? "",
      authorization: request.headers.authorization ?? "",
    });
    if (path === "/manifest.m3u8") {
      manifestRequests += 1;
      if (manifestRequests === 2) challengeClosedBeforeRetry = challengeBodyClosed;
      if (manifestRequests === 1) {
        response.once("close", () => { challengeBodyClosed = true; });
        response.writeHead(401, {
          "content-type": "application/vnd.apple.mpegurl",
          "set-cookie": "cdn_session=valid; Path=/; HttpOnly",
        });
        response.write("held challenge body");
        return;
      }
      response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
      response.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST\n',
      );
      return;
    }
    if (path === "/key.bin") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from("key"));
      return;
    }
    if (path === "/segment.ts") {
      response.writeHead(200, { "content-type": "video/mp2t" });
      response.end(tsPackets());
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const cdnUrl = await listen(cdn);
  const cookieScopedCdnUrl = cdnUrl.replace("127.0.0.1", "localhost");
  const sourceUrl = await listen(source);
  const diagnostics = new CapturedDiagnostics();
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null, diagnostics });
  let session: AutoPlaybackProxySession | undefined;
  try {
    session = await proxy.createAutoSession(
      `${sourceUrl}/start`,
      { cookie: "account=private", authorization: "Bearer private" },
      false,
      "challenge-success",
    );
    assert.equal(session.format, "hls");
    assert.equal(sourceRedirects, 2, "the retry starts again from the original provider URL");
    assert.equal(manifestRequests, 2, "one challenge and one successful manifest request");
    assert.equal(challengeClosedBeforeRetry, true, "the first upstream body is canceled before opening the retry");
    assert.deepEqual(sourceSeen, [
      "account=private|Bearer private",
      "account=private|Bearer private",
    ]);
    assert.deepEqual(cdnSeen.slice(0, 2), [
      { path: "/manifest.m3u8", cookie: "", authorization: "" },
      { path: "/manifest.m3u8", cookie: "cdn_session=valid", authorization: "" },
    ]);

    const manifestResponse = await fetch(session.url);
    const manifest = await manifestResponse.text();
    assert.equal(manifestResponse.status, 200);
    assert.match(manifest, /#EXTM3U/);
    assert.equal(manifestRequests, 2, "the warmed response is consumed without a third manifest GET");
    const localUris = [...manifest.matchAll(/(?:URI=")?(http:\/\/127\.0\.0\.1:\d+\/[^"\s]+)(?:")?/g)]
      .map((match) => match[1]);
    assert.equal(localUris.length, 2);
    for (const uri of localUris) {
      const response = await fetch(uri);
      await response.arrayBuffer();
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      cdnSeen.filter(({ path }) => path === "/segment.ts" || path === "/key.bin")
        .map(({ path, cookie, authorization }) => ({ path, cookie, authorization })),
      [
        { path: "/key.bin", cookie: "cdn_session=valid", authorization: "" },
        { path: "/segment.ts", cookie: "cdn_session=valid", authorization: "" },
      ],
    );
    assert.equal(cdnSeen.filter(({ path }) => path === "/manifest.m3u8").length, 2);
    assert.ok(diagnostics.records.some((record) =>
      record.event === "upstream-response" && record.phase === "auto-cookie-challenge-retry",
    ));
  } finally {
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
    await close(cdn);
  }
});

for (const challenge of [
  { name: "plain 401", setCookie: undefined },
  { name: "invalid Set-Cookie without an applicable learned cookie", setCookie: "__Host-invalid=x; Path=/" },
]) {
  test(`does not retry ${challenge.name}`, async () => {
    let requests = 0;
    const source = createServer((_request, response) => {
      requests += 1;
      response.writeHead(401, {
        "content-type": "application/vnd.apple.mpegurl",
        ...(challenge.setCookie ? { "set-cookie": challenge.setCookie } : {}),
      });
      response.end("denied");
    });
    const sourceUrl = await listen(source);
    const proxy = service();
    try {
      await assert.rejects(
        proxy.createAutoSession(`${sourceUrl}/manifest`, undefined, false),
        (error: unknown) => error instanceof MediaInspectionError && error.code === "http-error" && error.status === 401,
      );
      assert.equal(requests, 1);
      assert.equal(proxy.sessionCount, 0);
    } finally {
      await proxy.shutdown();
      await close(source);
    }
  });
}

test("stops after the second 401 challenge", async () => {
  let requests = 0;
  const source = createServer((_request, response) => {
    requests += 1;
    response.writeHead(401, {
      "content-type": "application/vnd.apple.mpegurl",
      "set-cookie": `cdn_session=value${requests}; Path=/`,
    });
    response.end("denied");
  });
  const sourceUrl = await listen(source);
  const proxy = service();
  try {
    await assert.rejects(
      proxy.createAutoSession(`${sourceUrl}/manifest`, undefined, false),
      (error: unknown) => error instanceof MediaInspectionError && error.code === "http-error" && error.status === 401,
    );
    assert.equal(requests, 2);
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("keeps the original response-header deadline across the challenge retry", async () => {
  let requests = 0;
  const source = createServer((_request, response) => {
    requests += 1;
    const requestNumber = requests;
    setTimeout(() => {
      if (requestNumber === 1) {
        response.writeHead(401, {
          "content-type": "application/vnd.apple.mpegurl",
          "set-cookie": "cdn_session=valid; Path=/",
        });
        response.end("challenge");
      } else {
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        response.end("#EXTM3U\n");
      }
    }, 160);
  });
  const sourceUrl = await listen(source);
  const proxy = service({ startupHeaderTimeoutMs: 250 });
  try {
    await assert.rejects(
      proxy.createAutoSession(`${sourceUrl}/manifest`, undefined, false),
      (error: unknown) => error instanceof MediaInspectionError && error.code === "startup-timeout",
    );
    assert.equal(requests, 2, "retry began under the same deadline and did not receive a fresh 250 ms budget");
    assert.equal(proxy.sessionCount, 0);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("retains a failed cleanup attempt so cancel can retry draining the 401 response", async () => {
  let responseClosed!: () => void;
  const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
  let requests = 0;
  const source = createServer((_request, response) => {
    requests += 1;
    response.on("close", responseClosed);
    response.writeHead(401, {
      "content-type": "application/vnd.apple.mpegurl",
    });
    response.write("held challenge body");
  });
  const sourceUrl = await listen(source);
  class FailOneCleanupAckProxy extends HlsPlaybackProxyService {
    private rejectFirst = true;

    override async releaseSessionAndWait(id: string): Promise<void> {
      if (this.rejectFirst) {
        this.rejectFirst = false;
        throw new Error("injected cleanup acknowledgement failure");
      }
      await super.releaseSessionAndWait(id);
    }
  }
  const proxy = new FailOneCleanupAckProxy({ mpegTsRemuxerPath: null });
  try {
    await assert.rejects(proxy.createAutoSession(`${sourceUrl}/manifest`, undefined, false, "retry-cleanup"));
    assert.equal(proxy.sessionCount, 1, "the failed acknowledgement leaves the real proxy session owned");
    await proxy.cancelAutoSession("retry-cleanup");
    assert.equal(proxy.sessionCount, 0);
    await closed;
    assert.equal(requests, 1);
  } finally {
    await proxy.shutdown();
    await close(source);
  }
});

test("keeps attempt ownership while the release operation still owns a removed session", async () => {
  const source = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "video/mp2t" });
    response.end(tsPackets());
  });
  const sourceUrl = await listen(source);
  const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null, releaseTeardownTimeoutMs: 10_000 });
  let session: AutoPlaybackProxySession | undefined;
  let finishDrain = () => undefined;
  let releasePending: Promise<void> | undefined;
  try {
    session = await proxy.createAutoSession(`${sourceUrl}/live`, undefined, true, "pending-release");
    const internals = proxy as unknown as {
      autoAttempts: Map<string, unknown>;
      releaseOperations: Map<string, Promise<void>>;
      sessions: Map<string, { activeHandlers: Set<Promise<void>> }>;
    };
    const ownedSession = internals.sessions.get(session.id);
    assert.ok(ownedSession);
    const activeDrain = new Promise<void>((resolve) => { finishDrain = resolve; });
    ownedSession.activeHandlers.add(activeDrain);

    releasePending = proxy.releaseSessionAndWait(session.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(proxy.sessionCount, 0);
    assert.ok(internals.releaseOperations.has(session.id));
    assert.ok(internals.autoAttempts.has("pending-release"), "attempt remains reachable while release owns cleanup");

    finishDrain();
    await releasePending;
    assert.equal(internals.releaseOperations.has(session.id), false);
    assert.equal(internals.autoAttempts.has("pending-release"), false);
  } finally {
    finishDrain();
    await releasePending?.catch(() => undefined);
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});
