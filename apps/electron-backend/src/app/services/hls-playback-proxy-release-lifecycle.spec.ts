import assert from "node:assert/strict";
import { createServer, get, ServerResponse, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { HlsPlaybackProxyService } from "./hls-playback-proxy.service";
import {
  PlaybackDiagnosticsStore,
  type PlaybackDiagnosticInput,
} from "./playback-diagnostics.service";

class CapturedDiagnostics extends PlaybackDiagnosticsStore {
  readonly records: PlaybackDiagnosticInput[] = [];

  override record(input: PlaybackDiagnosticInput): void {
    this.records.push(input);
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("release drains a warmed progressive handler when the downstream closes at body EOF", async () => {
  const body = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(body);
  const source = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "video/mp4",
      "content-length": body.length,
    });
    response.end(body);
  });
  const sourceUrl = await listen(source);
  const diagnostics = new CapturedDiagnostics();
  const proxy = new HlsPlaybackProxyService({
    mpegTsRemuxerPath: null,
    releaseTeardownTimeoutMs: 150,
    diagnostics,
  });
  let session: { id: string; url: string } | undefined;
  let restoreEnd: (() => void) | undefined;

  try {
    session = await proxy.createAutoSession(`${sourceUrl}/movie.mp4`, undefined, false);
    const internals = proxy as unknown as {
      sessions: Map<string, { activeHandlers: Set<Promise<void>>; requests: Set<AbortController> }>;
    };
    const ownedSession = internals.sessions.get(session.id);
    assert.ok(ownedSession);
    const targetPath = new URL(session.url).pathname;
    const originalEnd = ServerResponse.prototype.end;
    let forcedClose = false;
    let markClientClosed!: () => void;
    const clientClosed = new Promise<void>((resolve) => { markClientClosed = resolve; });
    const patchedEnd = function (
      this: ServerResponse,
      ...args: Parameters<typeof originalEnd>
    ): ServerResponse {
      if (this.req?.url === targetPath && !forcedClose) {
        forcedClose = true;
        // Inject a real socket close at the point the upstream body reaches
        // EOF, before Node can emit ServerResponse's finish event.
        this.destroy();
        return this;
      }
      return originalEnd.apply(this, args);
    };
    ServerResponse.prototype.end = patchedEnd;
    restoreEnd = () => { ServerResponse.prototype.end = originalEnd; };

    const playerRequest: ClientRequest = get(session.url, { headers: { origin: "null" } });
    playerRequest.once("response", (response) => {
      response.resume();
      response.once("error", () => undefined);
      response.once("close", markClientClosed);
    });
    playerRequest.once("error", () => undefined);
    playerRequest.once("close", () => {
      if (forcedClose) markClientClosed();
    });
    let closeTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        clientClosed,
        new Promise<never>((_resolve, reject) => {
          closeTimeout = setTimeout(() => reject(new Error("Timed out waiting for the real downstream socket to close.")), 2_000);
          closeTimeout.unref();
        }),
      ]);
    } finally {
      if (closeTimeout !== undefined) clearTimeout(closeTimeout);
    }
    assert.equal(forcedClose, true, "the proxy forwarded the complete warmed MP4 body before the reset");

    await assert.doesNotReject(
      proxy.releaseSessionAndWait(session.id),
      "release should settle the local handler after the downstream socket closes",
    );
    assert.equal(proxy.sessionCount, 0);
    assert.equal(ownedSession.activeHandlers.size, 0, "the ended/closed response no longer owns a local handler");
    assert.equal(ownedSession.requests.size, 0, "release drains the local upstream request controller");
    const confirmed = diagnostics.records.find((record) => record.event === "proxy-session-release-confirmed");
    assert.equal(confirmed?.sourceUrl, `${sourceUrl}/movie.mp4`);
    assert.equal(confirmed?.details, "activeHandlers=0");
    playerRequest.destroy();
  } finally {
    restoreEnd?.();
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});

test("release drains the progressive tee after a paused-client disconnect", async () => {
  const prefix = Buffer.alloc(8 * 1024);
  Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(prefix);
  const totalBytes = 8 * 1024 * 1024;
  let markUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => { markUpstreamClosed = resolve; });
  const source = createServer((_request, response) => {
    response.once("close", markUpstreamClosed);
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-range": `bytes 0-${totalBytes - 1}/${totalBytes}`,
    });
    response.write(prefix);
  });
  const sourceUrl = await listen(source);
  const diagnostics = new CapturedDiagnostics();
  const proxy = new HlsPlaybackProxyService({
    mpegTsRemuxerPath: null,
    releaseTeardownTimeoutMs: 500,
    diagnostics,
  });
  let session: { id: string; url: string } | undefined;
  let restoreFromWeb: (() => void) | undefined;
  const unexpectedRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => { unexpectedRejections.push(reason); };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    session = await proxy.createProgressiveVodSession({ url: `${sourceUrl}/movie.mp4`, isLive: false });
    const internals = proxy as unknown as {
      sessions: Map<string, { activeHandlers: Set<Promise<void>>; requests: Set<AbortController> }>;
    };
    const ownedSession = internals.sessions.get(session.id);
    assert.ok(ownedSession);
    let localBodyClosed = false;
    let markLocalBodyClosed!: () => void;
    const localBodyClose = new Promise<void>((resolve) => { markLocalBodyClosed = resolve; });
    const originalFromWeb = Readable.fromWeb;
    const patchedFromWeb = function (stream: Parameters<typeof Readable.fromWeb>[0]) {
      const body = originalFromWeb.call(Readable, stream as never);
      body.once("close", () => {
        localBodyClosed = true;
        markLocalBodyClosed();
      });
      return body;
    } as typeof Readable.fromWeb;
    Readable.fromWeb = patchedFromWeb;
    restoreFromWeb = () => { Readable.fromWeb = originalFromWeb; };

    let markClientClosed!: () => void;
    const clientClosed = new Promise<void>((resolve) => { markClientClosed = resolve; });
    const playerRequest: ClientRequest = get(session.url, {
      headers: { origin: "null", range: "bytes=0-" },
    });
    playerRequest.once("response", (response: IncomingMessage) => {
      response.once("error", () => undefined);
      response.once("close", markClientClosed);
      response.once("data", () => {
        response.pause();
        response.destroy();
      });
    });
    playerRequest.once("error", () => undefined);

    await withTimeout(clientClosed, "Timed out waiting for the paused downstream socket to close.");
    const release = proxy.releaseSessionAndWait(session.id);
    let acknowledgedBeforeReadableClosed = false;
    const observedRelease = release.then(() => {
      acknowledgedBeforeReadableClosed = !localBodyClosed;
    });
    await withTimeout(
      Promise.all([upstreamClosed, localBodyClose, observedRelease]).then(() => undefined),
      "Timed out waiting for both provider and local readable cleanup.",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(acknowledgedBeforeReadableClosed, false, "release ACK follows the actual local readable close");
    assert.equal(ownedSession.activeHandlers.size, 0);
    assert.equal(ownedSession.requests.size, 0);
    assert.equal(unexpectedRejections.length, 0, "cancellation errors remain handled through readable close");
    const confirmed = diagnostics.records.find((record) => record.event === "proxy-session-release-confirmed");
    assert.equal(confirmed?.sourceUrl, `${sourceUrl}/movie.mp4`);
    assert.equal(confirmed?.details, "activeHandlers=0");
    playerRequest.destroy();
  } finally {
    restoreFromWeb?.();
    process.off("unhandledRejection", onUnhandledRejection);
    if (session) await proxy.releaseSessionAndWait(session.id).catch(() => undefined);
    await proxy.shutdown();
    await close(source);
  }
});
