import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  MpegTsRemuxStartupError,
  relayMpegTsWithFfmpeg,
} from "./mpegts-remux-relay";
import { resolveMpegTsRemuxerPath } from "./mpegts-remux-runtime";

const SESSION_IDLE_MS = 15 * 60_000;
const SESSION_SWEEP_MS = 60_000;
const MAX_RESOURCES_PER_SESSION = 4_096;
const HLS_CONTENT_TYPE = /(?:application|audio)\/(?:vnd\.apple\.|x-)?mpegurl/i;
const PROGRESSIVE_VOD_PREFETCH_BYTES = 25 * 1024 * 1024;
const PROGRESSIVE_VOD_MAX_CACHE_BYTES = PROGRESSIVE_VOD_PREFETCH_BYTES * 2;
const PROGRESSIVE_VOD_MAX_CACHEABLE_REQUEST_BYTES = 2 * 1024 * 1024;
const MPEGTS_UPSTREAM_IDLE_MS = 3_000;

export interface HlsProxySession {
  id: string;
  url: string;
}

export interface HlsProxySessionInput {
  url: string;
  headers?: Record<string, string>;
}

export interface ProgressiveVodProxySession {
  id: string;
  url: string;
}

export interface MpegTsProxySession {
  id: string;
  url: string;
}

type ProxyResource = {
  url: string;
  root?: boolean;
  fallbackUrl?: string;
  lastManifest?: { sequence: number; body: string };
  manifestMode?: "live" | "vod" | "unknown";
  progressiveVodCache?: ProgressiveVodCache;
  progressiveVodTotal?: number;
  progressiveVodPrefetch?: Promise<void>;
};
type ProgressiveVodCache = {
  start: number;
  end: number;
  total: number;
  contentType: string | null;
  body: Buffer;
};
type ByteRangeRequest = { start: number; end: number | null };
type ByteRange = { start: number; end: number };
type ProxySession = {
  kind: "hls" | "progressive-vod" | "mpegts";
  headers: Record<string, string>;
  resources: Map<string, ProxyResource>;
  resourceIds: Map<string, string>;
  requests: Set<AbortController>;
  lastUsedAt: number;
};

export interface HlsPlaybackProxyServiceOptions {
  readonly mpegTsRemuxerPath?: string | null;
}

/**
 * Read an upstream range only while it remains within the proxy's bounded
 * cache budget. Some providers ignore a Range header and return a much larger
 * body, so arrayBuffer() would otherwise allow an unbounded allocation.
 */
async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return Buffer.concat(chunks, total);
      }
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function opaqueId(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/** Retain only request headers which providers commonly require for playback. */
export function sanitizeHlsProxyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return sanitizeProxyHeaders(
    headers,
    new Set(["user-agent", "referer", "origin"]),
  );
}

/**
 * Retain the headers needed by raw MPEG-TS providers, including Stalker
 * session credentials. These values stay in the Electron main process and
 * are never sent by the renderer to the provider directly.
 */
export function sanitizeMpegTsProxyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return sanitizeProxyHeaders(
    headers,
    new Set([
      "accept",
      "authorization",
      "cookie",
      "icy-metadata",
      "origin",
      "referer",
      "sn",
      "user-agent",
      "x-user-agent",
    ]),
  );
}

function sanitizeProxyHeaders(
  headers: Record<string, string> | undefined,
  accepted: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (
      accepted.has(normalizedName) &&
      typeof value === "string" &&
      value.trim() &&
      !/[\r\n]/.test(value)
    ) {
      result[normalizedName] = value.trim();
    }
  }
  return result;
}

/** Resolve an HLS URI against the response URL and reject non-network schemes. */
export function resolveHlsProxyTarget(
  value: string,
  responseUrl: string,
): string | null {
  try {
    const url = new URL(value, responseUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Rewrites HLS URI lines and URI attributes to opaque, session-scoped paths.
 * The target URL never reaches the renderer, including after a provider redirect.
 */
export function rewriteHlsManifest(
  manifest: string,
  responseUrl: string,
  makeProxyUrl: (targetUrl: string) => string,
): string {
  const rewrite = (value: string): string => {
    const target = resolveHlsProxyTarget(value, responseUrl);
    return target ? makeProxyUrl(target) : value;
  };

  return manifest
    .split(/(\r?\n)/)
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return part.replace(
          /URI=("([^"]*)"|'([^']*)'|([^,\s]*))/gi,
          (match, _whole, doubleQuoted, singleQuoted, bare) => {
            const value = doubleQuoted ?? singleQuoted ?? bare;
            const rewritten = rewrite(value);
            if (rewritten === value) {
              return match;
            }
            return `URI="${rewritten}"`;
          },
        );
      }
      return part.replace(trimmed, rewrite(trimmed));
    })
    .join("");
}

function isHlsManifest(contentType: string | null, url: string): boolean {
  return (
    HLS_CONTENT_TYPE.test(contentType ?? "") ||
    new URL(url).pathname.toLowerCase().endsWith(".m3u8")
  );
}

function shouldRefreshLiveManifest(status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 406 ||
    status === 410 ||
    status === 429 ||
    status >= 500
  );
}

function detectManifestMode(manifest: string): "live" | "vod" | "unknown" {
  if (
    /#EXT-X-ENDLIST\s*(?:\r?\n|$)/i.test(manifest) ||
    /#EXT-X-PLAYLIST-TYPE\s*:\s*VOD\s*(?:\r?\n|$)/i.test(manifest)
  ) {
    return "vod";
  }
  if (
    /#EXT-X-TARGETDURATION\s*:/i.test(manifest) ||
    /#EXT-X-MEDIA-SEQUENCE\s*:/i.test(manifest) ||
    /#EXTINF\s*:/i.test(manifest)
  ) {
    return "live";
  }
  return "unknown";
}

function addLiveManifestRefreshNonce(url: string): string {
  try {
    const refreshed = new URL(url);
    refreshed.searchParams.set(
      "_arm_nator_refresh",
      `${Date.now()}-${randomBytes(6).toString("hex")}`,
    );
    return refreshed.toString();
  } catch {
    return url;
  }
}

function getHlsMediaSequence(manifest: string): number | null {
  const match = manifest.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function isAllowedRendererOrigin(origin: string | undefined): boolean {
  if (!origin || origin === "null") {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function copyResponseHeaders(
  upstream: Response,
  response: ServerResponse,
  rewritten: boolean,
  preserveContentLength = false,
): void {
  const excluded = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "vary",
  ]);
  upstream.headers.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (
      !excluded.has(normalizedName) &&
      !normalizedName.startsWith("access-control-") &&
      (!rewritten || normalizedName !== "content-encoding") &&
      (preserveContentLength || normalizedName !== "content-length")
    ) {
      response.setHeader(name, value);
    }
  });
}

function parseByteRange(range: string | undefined): ByteRangeRequest | null {
  if (!range) {
    return null;
  }

  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : null;
  if (
    !Number.isSafeInteger(start) ||
    (end !== null && (!Number.isSafeInteger(end) || end < start))
  ) {
    return null;
  }
  return { start, end };
}

function parseContentRange(
  value: string | null,
): (ByteRange & { total: number }) | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value?.trim() ?? "");
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    end < start ||
    total <= end
  ) {
    return null;
  }
  return { start, end, total };
}

export class HlsPlaybackProxyService {
  private readonly sessions = new Map<string, ProxySession>();
  private server: Server | null = null;
  private port: number | null = null;
  private serverStartup: Promise<void> | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly mpegTsRemuxerPath: string | null;
  private readonly sweepTimer = setInterval(
    () => this.sweepExpiredSessions(),
    SESSION_SWEEP_MS,
  );

  constructor(options: HlsPlaybackProxyServiceOptions = {}) {
    this.mpegTsRemuxerPath =
      options.mpegTsRemuxerPath === undefined
        ? resolveMpegTsRemuxerPath()
        : options.mpegTsRemuxerPath;
    this.sweepTimer.unref();
  }

  async createSession(input: HlsProxySessionInput): Promise<HlsProxySession> {
    return this.createProxySession("hls", input);
  }

  async createProgressiveVodSession(
    input: HlsProxySessionInput,
  ): Promise<ProgressiveVodProxySession> {
    return this.createProxySession("progressive-vod", input);
  }

  async createMpegTsSession(
    input: HlsProxySessionInput,
  ): Promise<MpegTsProxySession> {
    return this.createProxySession("mpegts", input);
  }

  private async createProxySession(
    kind: ProxySession["kind"],
    input: HlsProxySessionInput,
  ): Promise<HlsProxySession> {
    if (this.shuttingDown) {
      throw new Error("The playback proxy is shutting down.");
    }
    if (!isHttpUrl(input.url)) {
      throw new Error(
        "A playback proxy session requires an HTTP(S) source URL.",
      );
    }
    await this.ensureServer();
    if (this.shuttingDown || this.port === null) {
      throw new Error("The playback proxy is shutting down.");
    }
    const id = opaqueId();
    const rootId = opaqueId(16);
    const session: ProxySession = {
      kind,
      headers:
        kind === "mpegts"
          ? sanitizeMpegTsProxyHeaders(input.headers)
          : sanitizeHlsProxyHeaders(input.headers),
      resources: new Map([
        [rootId, { url: input.url, root: true, fallbackUrl: input.url }],
      ]),
      resourceIds: new Map([[input.url, rootId]]),
      requests: new Set(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(id, session);
    const route =
      kind === "hls" ? "hls" : kind === "progressive-vod" ? "media" : "stream";
    return {
      id,
      url: `http://127.0.0.1:${this.port}/${route}/${id}/${rootId}`,
    };
  }

  releaseSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    for (const request of session.requests) request.abort();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    for (const id of this.sessions.keys()) this.releaseSession(id);
    clearInterval(this.sweepTimer);
    const startup = this.serverStartup;
    if (startup) await startup.catch(() => undefined);
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Test-only visibility into lifecycle without exposing source URLs. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.port !== null) return;
    if (!this.serverStartup) {
      const startup = this.startServer();
      this.serverStartup = startup;
      void startup
        .finally(() => {
          if (this.serverStartup === startup) this.serverStartup = null;
        })
        .catch(() => undefined);
    }
    await this.serverStartup;
  }

  private async startServer(): Promise<void> {
    const server = createServer(
      (request, response) => void this.handleRequest(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Unable to start the local HLS proxy.");
    }
    this.server = server;
    this.port = address.port;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = request.headers.origin;
    if (!isAllowedRendererOrigin(origin)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader(
      "Access-Control-Allow-Origin",
      origin === "null" ? "null" : (origin ?? "*"),
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Range, Accept, Content-Type",
    );
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Length, Content-Range, Content-Type",
    );
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }

    const match = request.url?.match(
      /^(\/hls|\/media|\/stream)\/([a-f0-9]{48})\/([a-f0-9]{32})$/,
    );
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const [, route, sessionId, resourceId] = match;
    const session = this.sessions.get(sessionId);
    const resource = session?.resources.get(resourceId);
    const expectedKind =
      route === "/hls"
        ? "hls"
        : route === "/media"
          ? "progressive-vod"
          : "mpegts";
    if (!session || !resource || session.kind !== expectedKind) {
      response.writeHead(404).end();
      return;
    }
    session.lastUsedAt = Date.now();
    const controller = new AbortController();
    session.requests.add(controller);
    const abort = () => controller.abort();
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const requestedRange =
        session.kind === "progressive-vod"
          ? parseByteRange(request.headers.range)
          : null;
      if (session.kind === "mpegts") {
        await this.handleMpegTsStreamRequest(
          request,
          response,
          session,
          resource,
          controller,
        );
        return;
      }
      if (requestedRange && request.method === "GET") {
        await this.waitForProgressiveVodPrefetch(resource, requestedRange);
        if (
          this.serveProgressiveVodCache(
            session,
            resource,
            requestedRange,
            response,
          )
        ) {
          return;
        }
      }
      const upstreamRange =
        session.kind === "progressive-vod" && requestedRange?.end === null
          ? `bytes=${requestedRange.start}-${Math.min(
              (resource.progressiveVodTotal ?? Number.MAX_SAFE_INTEGER) - 1,
              requestedRange.start + PROGRESSIVE_VOD_PREFETCH_BYTES - 1,
            )}`
          : request.headers.range;
      let upstream = await fetch(resource.url, {
        method: request.method,
        headers: this.upstreamHeaders(session.headers, upstreamRange),
        redirect: "follow",
        signal: controller.signal,
      });
      if (
        session.kind === "progressive-vod" &&
        requestedRange &&
        request.method === "GET" &&
        (requestedRange.end === null ||
          requestedRange.end - requestedRange.start + 1 <=
            PROGRESSIVE_VOD_MAX_CACHEABLE_REQUEST_BYTES)
      ) {
        const contentRange = parseContentRange(
          upstream.headers.get("content-range"),
        );
        const coversRequestedRange =
          upstream.status === 206 &&
          contentRange !== null &&
          contentRange.start <= requestedRange.start &&
          contentRange.end >= (requestedRange.end ?? requestedRange.start);
        const narrowRangeRejected =
          upstream.status >= 400 && upstream.status < 500;
        if (!coversRequestedRange && narrowRangeRejected) {
          await upstream.body?.cancel().catch(() => undefined);
          const expandedEnd = Math.min(
            (resource.progressiveVodTotal ?? Number.MAX_SAFE_INTEGER) - 1,
            requestedRange.start + PROGRESSIVE_VOD_PREFETCH_BYTES - 1,
          );
          upstream = await fetch(resource.url, {
            method: "GET",
            headers: this.upstreamHeaders(
              session.headers,
              `bytes=${requestedRange.start}-${expandedEnd}`,
            ),
            redirect: "follow",
            signal: controller.signal,
          });
        }
      }
      if (
        session.kind === "progressive-vod" &&
        requestedRange &&
        request.method === "GET" &&
        (upstream.status === 408 ||
          upstream.status === 429 ||
          upstream.status >= 500)
      ) {
        await upstream.body?.cancel().catch(() => undefined);
        upstream = await fetch(resource.url, {
          method: "GET",
          headers: this.upstreamHeaders(session.headers, upstreamRange),
          redirect: "follow",
          signal: controller.signal,
        });
      }
      if (
        session.kind === "hls" &&
        resource.manifestMode !== "vod" &&
        shouldRefreshLiveManifest(upstream.status) &&
        resource.fallbackUrl
      ) {
        await upstream.body?.cancel().catch(() => undefined);
        const refreshUrls = [
          addLiveManifestRefreshNonce(resource.fallbackUrl),
          resource.fallbackUrl,
        ];
        for (const refreshUrl of refreshUrls) {
          upstream = await fetch(refreshUrl, {
            method: request.method,
            headers: this.upstreamHeaders(
              session.headers,
              request.headers.range,
            ),
            redirect: "follow",
            signal: controller.signal,
          });
          if (
            !shouldRefreshLiveManifest(upstream.status) ||
            refreshUrl === refreshUrls.at(-1)
          ) {
            break;
          }
          await upstream.body?.cancel().catch(() => undefined);
        }
      }
      if (session.kind === "hls" && upstream.ok && isHttpUrl(upstream.url)) {
        // Keep live-playlist refreshes on the same redirected backend.
        // Re-resolving the Xtream URL can move between nodes whose
        // media sequences are out of order, which HLS.js treats as a
        // fatal level-parsing error. Progressive VOD is deliberately
        // different: Xtream providers often put a one-request token
        // in the redirect, so every range must resolve from the
        // original URL again.
        resource.url = upstream.url;
      }
      if (
        session.kind === "hls" &&
        isHlsManifest(
          upstream.headers.get("content-type"),
          upstream.url || resource.url,
        ) &&
        request.method === "GET"
      ) {
        const manifest = await upstream.text();
        const manifestMode = detectManifestMode(manifest);
        if (manifestMode !== "unknown") {
          resource.manifestMode = manifestMode;
        }
        const sequence = getHlsMediaSequence(manifest);
        const previous = resource.lastManifest;
        const body =
          resource.manifestMode === "live" &&
          sequence !== null &&
          previous &&
          sequence < previous.sequence
            ? previous.body
            : rewriteHlsManifest(
                manifest,
                upstream.url || resource.url,
                (target) => {
                  const childId = this.addResource(session, target);
                  return `http://127.0.0.1:${this.port}/hls/${sessionId}/${childId}`;
                },
              );
        if (
          resource.manifestMode === "live" &&
          sequence !== null &&
          (!previous || sequence >= previous.sequence)
        ) {
          resource.lastManifest = { sequence, body };
        }
        copyResponseHeaders(upstream, response, true);
        response.writeHead(upstream.status);
        response.end(body);
        return;
      }
      const progressiveOpenRange =
        session.kind === "progressive-vod" &&
        requestedRange?.end === null &&
        request.method === "GET" &&
        upstream.status === 206 &&
        upstream.body
          ? parseContentRange(upstream.headers.get("content-range"))
          : null;
      if (
        progressiveOpenRange &&
        progressiveOpenRange.start <= requestedRange.start &&
        progressiveOpenRange.end >= requestedRange.start
      ) {
        resource.progressiveVodTotal = progressiveOpenRange.total;
        // Chromium sends open-ended ranges for progressive MP4 playback.
        // Some providers close those responses before the advertised
        // Content-Length is delivered. Do not forward that promise on
        // the streaming path; chunked transfer lets the media element
        // observe the actual bytes and request the next range.
        copyResponseHeaders(upstream, response, false);
        response.setHeader(
          "Content-Range",
          `bytes ${progressiveOpenRange.start}-${progressiveOpenRange.end}/${progressiveOpenRange.total}`,
        );
        const [clientStream, cacheStream] = (
          upstream.body as ReadableStream<Uint8Array>
        ).tee();
        // Chromium may cancel the first open-ended response after it
        // has learned the MP4 tail offset. Keep the finite upstream
        // read alive so the overlapping follow-up range can use the
        // local cache instead of hitting the provider again.
        request.off("aborted", abort);
        response.off("close", abort);
        const cachePromise = (async () => {
          const reader = cacheStream.getReader();
          const chunks: Buffer[] = [];
          let cachedBytes = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              if (cachedBytes >= PROGRESSIVE_VOD_PREFETCH_BYTES) {
                continue;
              }
              const remaining = PROGRESSIVE_VOD_PREFETCH_BYTES - cachedBytes;
              const copy = Buffer.from(value).subarray(0, remaining);
              chunks.push(copy);
              cachedBytes += copy.length;
            }
            const expectedBytes =
              progressiveOpenRange.end - progressiveOpenRange.start + 1;
            if (cachedBytes === expectedBytes) {
              this.storeProgressiveVodCache(
                session,
                resource,
                progressiveOpenRange,
                upstream.headers.get("content-type"),
                Buffer.concat(chunks),
                true,
                true,
              );
            }
          } finally {
            reader.releaseLock();
          }
        })();
        response.writeHead(upstream.status);
        const clientPromise = new Promise<void>((resolve, reject) => {
          const body = Readable.fromWeb(clientStream as never);
          body.once("error", reject);
          response.once("error", reject);
          response.once("close", resolve);
          response.once("finish", resolve);
          body.pipe(response);
        });
        const [clientResult] = await Promise.allSettled([
          clientPromise,
          cachePromise,
        ]);
        if (clientResult.status === "rejected") {
          throw clientResult.reason;
        }
        return;
      }
      copyResponseHeaders(
        upstream,
        response,
        false,
        session.kind === "progressive-vod",
      );

      if (
        session.kind === "progressive-vod" &&
        requestedRange &&
        request.method === "GET" &&
        upstream.status === 206 &&
        upstream.body &&
        (requestedRange.end === null ||
          requestedRange.end - requestedRange.start + 1 <=
            PROGRESSIVE_VOD_MAX_CACHEABLE_REQUEST_BYTES)
      ) {
        const body = await readResponseBodyBounded(
          upstream,
          PROGRESSIVE_VOD_MAX_CACHE_BYTES,
        );
        if (!body) {
          response.removeHeader("content-length");
          response.removeHeader("content-range");
          response.writeHead(502).end();
          return;
        }
        const contentRange = parseContentRange(
          upstream.headers.get("content-range"),
        );
        if (contentRange) {
          resource.progressiveVodTotal = contentRange.total;
        }
        if (
          contentRange &&
          contentRange.start <= requestedRange.start &&
          body.length === contentRange.end - contentRange.start + 1
        ) {
          const clientEnd = requestedRange.end ?? contentRange.end;
          if (clientEnd > contentRange.end) {
            response.writeHead(502).end();
            return;
          }
          const offset = requestedRange.start - contentRange.start;
          const clientBody = body.subarray(
            offset,
            offset + clientEnd - requestedRange.start + 1,
          );
          response.setHeader("Content-Length", clientBody.length);
          response.setHeader(
            "Content-Range",
            `bytes ${requestedRange.start}-${clientEnd}/${contentRange.total}`,
          );
          response.writeHead(upstream.status);
          response.end(clientBody);
          this.storeProgressiveVodCache(
            session,
            resource,
            contentRange,
            upstream.headers.get("content-type"),
            body,
          );
          return;
        }
        response.writeHead(upstream.status);
        response.end(body);
        return;
      }
      response.writeHead(upstream.status);
      if (request.method === "HEAD" || !upstream.body) {
        response.end();
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const body = Readable.fromWeb(upstream.body as never);
        body.once("error", reject);
        response.once("error", reject);
        response.once("finish", resolve);
        body.pipe(response);
      });
    } catch (error) {
      if (!response.headersSent && !controller.signal.aborted)
        response.writeHead(502);
      if (!response.writableEnded) response.end();
      void error;
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      session.requests.delete(controller);
    }
  }

  private upstreamHeaders(
    headers: Record<string, string>,
    range: string | undefined,
  ): Record<string, string> {
    return {
      ...headers,
      "cache-control": "no-cache",
      pragma: "no-cache",
      ...(range ? { range } : {}),
    };
  }

  /**
   * Keep one renderer response and one FFmpeg output muxer alive while the
   * authenticated upstream is reopened behind it. The relay drops partial TS
   * packets at connection boundaries; FFmpeg regenerates timing, PSI tables,
   * and continuity counters before bytes reach mpegts.js. If the portable
   * remuxer is unavailable, preserve EOF and let the renderer's watchdog use
   * its clean-remount fallback.
   */
  private async handleMpegTsStreamRequest(
    request: IncomingMessage,
    response: ServerResponse,
    session: ProxySession,
    resource: ProxyResource,
    controller: AbortController,
  ): Promise<void> {
    const upstream = await fetch(resource.url, {
      method: request.method,
      headers: this.upstreamHeaders(session.headers, request.headers.range),
      redirect: "follow",
      signal: controller.signal,
    });
    if (request.method === "HEAD" || !upstream.body) {
      copyResponseHeaders(upstream, response, false);
      response.writeHead(upstream.status);
      response.end();
      return;
    }

    if (upstream.ok && this.mpegTsRemuxerPath) {
      try {
        const relayResult = await relayMpegTsWithFfmpeg({
          ffmpegPath: this.mpegTsRemuxerPath,
          firstUpstream: upstream,
          reopenUpstream: (signal) =>
            fetch(resource.url, {
              method: request.method,
              headers: this.upstreamHeaders(
                session.headers,
                request.headers.range,
              ),
              redirect: "follow",
              signal,
            }),
          output: response,
          signal: controller.signal,
          onActivity: () => {
            session.lastUsedAt = Date.now();
          },
          onStarted: () => {
            response.setHeader("Content-Type", "video/mp2t");
            response.removeHeader("Content-Length");
            response.removeHeader("Content-Range");
            response.writeHead(200);
          },
          onUpstreamConnected: (connection) => {
            if (connection > 1) {
              console.info(
                `[MPEG-TS relay] Reopened upstream connection ${connection}.`,
              );
            }
          },
        });
        if (relayResult.stderr) {
          const summary = `[MPEG-TS relay] FFmpeg exited after ${relayResult.upstreamConnections} upstream connection(s), produced=${relayResult.outputBytes} byte(s), delivered=${relayResult.rendererBytes} byte(s), rendererDisconnected=${relayResult.rendererDisconnected}`;
          if (
            relayResult.rendererDisconnected &&
            relayResult.rendererBytes > 0
          ) {
            const diagnosticLines = relayResult.stderr
              .split(/\r?\n/)
              .filter(Boolean).length;
            console.info(
              `${summary}; recovered ${diagnosticLines} provider-stream warning line(s).`,
            );
          } else {
            console.warn(`${summary}: ${relayResult.stderr}`);
          }
        }
        if (!response.writableEnded && !response.destroyed) {
          response.end();
        }
        return;
      } catch (error) {
        if (!(error instanceof MpegTsRemuxStartupError)) {
          throw error;
        }
        // The upstream body is untouched when process startup fails, so the
        // raw EOF-preserving fallback can still serve this request.
      }
    }

    copyResponseHeaders(upstream, response, false);
    response.writeHead(upstream.status);
    await this.pipeMpegTsBody(upstream.body, response, session);
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }

  private pipeMpegTsBody(
    upstreamBody: ReadableStream<Uint8Array>,
    response: ServerResponse,
    session: ProxySession,
  ): Promise<number> {
    const body = Readable.fromWeb(upstreamBody as never);
    return new Promise<number>((resolve, reject) => {
      let streamedBytes = 0;
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        body.off("data", onData);
        body.off("end", onEnd);
        body.off("error", onError);
        response.off("error", onError);
        response.off("close", onClose);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(streamedBytes);
      };
      const onData = (chunk: Buffer | Uint8Array | string) => {
        streamedBytes += Buffer.byteLength(chunk);
        session.lastUsedAt = Date.now();
        armIdleTimer();
      };
      const onEnd = () => finish();
      const onError = (error: Error) => finish(error);
      const onIdle = () => {
        body.unpipe(response);
        body.destroy();
        finish();
      };
      const armIdleTimer = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(onIdle, MPEGTS_UPSTREAM_IDLE_MS);
      };
      const onClose = () => {
        body.unpipe(response);
        body.destroy();
        finish();
      };

      body.on("data", onData);
      body.once("end", onEnd);
      body.once("error", onError);
      response.once("error", onError);
      response.once("close", onClose);
      armIdleTimer();
      body.pipe(response, { end: false });
    });
  }

  private async waitForProgressiveVodPrefetch(
    resource: ProxyResource,
    requestedRange: ByteRangeRequest,
  ): Promise<void> {
    const cache = resource.progressiveVodCache;
    if (
      cache &&
      requestedRange.start >= cache.start &&
      (requestedRange.end === null || requestedRange.end <= cache.end)
    ) {
      return;
    }
    await resource.progressiveVodPrefetch?.catch(() => undefined);
  }

  private serveProgressiveVodCache(
    session: ProxySession,
    resource: ProxyResource,
    requestedRange: ByteRangeRequest,
    response: ServerResponse,
  ): boolean {
    const cache = resource.progressiveVodCache;
    if (
      !cache ||
      requestedRange.start < cache.start ||
      requestedRange.start > cache.end ||
      (requestedRange.end !== null && requestedRange.end > cache.end)
    ) {
      return false;
    }

    const offset = requestedRange.start - cache.start;
    const responseEnd = requestedRange.end ?? cache.end;
    const length = responseEnd - requestedRange.start + 1;
    const body = cache.body.subarray(offset, offset + length);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Length", body.length);
    response.setHeader(
      "Content-Range",
      `bytes ${requestedRange.start}-${responseEnd}/${cache.total}`,
    );
    if (cache.contentType) {
      response.setHeader("Content-Type", cache.contentType);
    }
    response.writeHead(206);
    response.end(body);
    this.storeProgressiveVodCache(
      session,
      resource,
      cache,
      cache.contentType,
      cache.body,
      false,
    );
    return true;
  }

  private storeProgressiveVodCache(
    session: ProxySession,
    resource: ProxyResource,
    range: ByteRange & { total: number },
    contentType: string | null,
    body: Buffer,
    prefetchNext = true,
    preserveExistingWindow = false,
  ): void {
    const incomingCache: ProgressiveVodCache = {
      start: range.start,
      end: range.end,
      total: range.total,
      contentType,
      body,
    };
    const existingCache = resource.progressiveVodCache;
    const isAdjacent =
      !existingCache ||
      (existingCache.total === incomingCache.total &&
        incomingCache.start <= existingCache.end + 1 &&
        incomingCache.end >= existingCache.start - 1);
    if (
      preserveExistingWindow &&
      existingCache &&
      !isAdjacent &&
      !(
        incomingCache.start < existingCache.start &&
        incomingCache.start <= PROGRESSIVE_VOD_PREFETCH_BYTES
      )
    ) {
      return;
    }
    const mergedStart = existingCache
      ? Math.min(existingCache.start, incomingCache.start)
      : incomingCache.start;
    const mergedEnd = existingCache
      ? Math.max(existingCache.end, incomingCache.end)
      : incomingCache.end;
    if (
      existingCache &&
      existingCache.total === incomingCache.total &&
      incomingCache.start <= existingCache.end + 1 &&
      incomingCache.end >= existingCache.start - 1 &&
      mergedEnd - mergedStart + 1 <= PROGRESSIVE_VOD_MAX_CACHE_BYTES
    ) {
      const mergedBody = Buffer.alloc(mergedEnd - mergedStart + 1);
      existingCache.body.copy(mergedBody, existingCache.start - mergedStart);
      incomingCache.body.copy(mergedBody, incomingCache.start - mergedStart);
      resource.progressiveVodCache = {
        start: mergedStart,
        end: mergedEnd,
        total: incomingCache.total,
        contentType: incomingCache.contentType ?? existingCache.contentType,
        body: mergedBody,
      };
    } else {
      resource.progressiveVodCache = incomingCache;
    }
    const nextStart = range.end + 1;
    if (
      !prefetchNext ||
      nextStart >= range.total ||
      resource.progressiveVodPrefetch
    ) {
      return;
    }

    const nextEnd = Math.min(
      range.total - 1,
      nextStart + PROGRESSIVE_VOD_PREFETCH_BYTES - 1,
    );
    const controller = new AbortController();
    session.requests.add(controller);
    const prefetch = fetch(resource.url, {
      method: "GET",
      headers: this.upstreamHeaders(
        session.headers,
        `bytes=${nextStart}-${nextEnd}`,
      ),
      redirect: "follow",
      signal: controller.signal,
    })
      .then(async (upstream) => {
        if (!upstream.ok || upstream.status !== 206 || !upstream.body) {
          await upstream.body?.cancel().catch(() => undefined);
          return;
        }
        const contentRange = parseContentRange(
          upstream.headers.get("content-range"),
        );
        if (!contentRange || contentRange.start !== nextStart) {
          await upstream.body.cancel().catch(() => undefined);
          return;
        }
        const prefetchedBody = await readResponseBodyBounded(
          upstream,
          PROGRESSIVE_VOD_MAX_CACHE_BYTES,
        );
        if (!prefetchedBody) {
          return;
        }
        if (
          prefetchedBody.length !==
          contentRange.end - contentRange.start + 1
        ) {
          return;
        }
        this.storeProgressiveVodCache(
          session,
          resource,
          contentRange,
          upstream.headers.get("content-type"),
          prefetchedBody,
          false,
        );
      })
      .catch(() => undefined)
      .finally(() => {
        session.requests.delete(controller);
        resource.progressiveVodPrefetch = undefined;
      });
    resource.progressiveVodPrefetch = prefetch;
  }

  private addResource(session: ProxySession, url: string): string {
    const existingId = session.resourceIds.get(url);
    if (existingId && session.resources.has(existingId)) {
      return existingId;
    }
    while (session.resources.size >= MAX_RESOURCES_PER_SESSION) {
      const oldest = [...session.resources.entries()].find(
        ([, resource]) => !resource.root,
      );
      if (!oldest) break;
      session.resources.delete(oldest[0]);
      if (session.resourceIds.get(oldest[1].url) === oldest[0]) {
        session.resourceIds.delete(oldest[1].url);
      }
    }
    const id = opaqueId(16);
    session.resources.set(id, { url });
    session.resourceIds.set(url, id);
    return id;
  }

  private sweepExpiredSessions(): void {
    const oldestAllowed = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.requests.size === 0 && session.lastUsedAt < oldestAllowed) {
        this.releaseSession(id);
      }
    }
  }
}

export const hlsPlaybackProxy = new HlsPlaybackProxyService();
