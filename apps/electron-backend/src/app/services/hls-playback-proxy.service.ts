import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { fetch as undiciFetch } from "undici";
import { CookieJar } from "tough-cookie";
import type {
  PlaybackRequestPolicy,
  PlaybackResourceKind,
} from "@arm-nator/shared/interfaces";
import {
  MpegTsRemuxStartupError,
  relayMpegTsWithFfmpeg,
} from "./mpegts-remux-relay";
import { resolveMpegTsRemuxerPath } from "./mpegts-remux-runtime";
import { withFetchDiagnostics } from "./fetch-wire-diagnostics";
import { recoverProgressiveResponse } from "./progressive-response-recovery";
import { PlaybackCookieSession } from "./playback-cookie-session";
import {
  playbackAccountProfiles,
  type PlaybackPortalCredentials,
} from "./playback-account-profile.service";
import {
  inspectResponseForMedia,
  MediaInspectionError,
  type AutoPlaybackFormat,
  type InspectedMediaContainer,
} from "./media-response-inspection";
import {
  playbackDiagnostics,
  type PlaybackDiagnosticHeaders,
  type PlaybackDiagnosticsStore,
} from "./playback-diagnostics.service";

const SESSION_IDLE_MS = 15 * 60_000;
const SESSION_SWEEP_MS = 60_000;
const HLS_CONTENT_TYPE = /(?:application|audio)\/(?:vnd\.apple\.|x-)?mpegurl/i;
const PROGRESSIVE_VOD_PREFETCH_BYTES = 25 * 1024 * 1024;
const PROGRESSIVE_VOD_MAX_CACHE_BYTES = PROGRESSIVE_VOD_PREFETCH_BYTES * 2;
const PROGRESSIVE_VOD_MAX_CACHEABLE_REQUEST_BYTES = 2 * 1024 * 1024;
const MPEGTS_UPSTREAM_IDLE_MS = 3_000;
const AUTO_WARM_RESPONSE_TTL_MS = 30_000;
const DEFAULT_AUTO_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_RELEASE_TEARDOWN_TIMEOUT_MS = 5_000;
const MAX_DASH_LICENSE_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_DASH_RESOURCES_PER_SESSION = 4096;
const DASH_UPSTREAM_URI_HEADER = "x-arm-nator-upstream-uri";
const DASH_REQUEST_ID_HEADER = "x-arm-nator-request-id";
const DASH_RESOURCE_KIND_HEADER = "x-arm-nator-resource-kind";

function fetchProviderUpstream(requestUrl: URL, init: RequestInit): Promise<Response> {
  // Electron 44's Node 24 global fetch crashes if an HTTP/1 socket reaches EOF
  // while its response parser is paused. The pinned Undici client includes the
  // upstream fix; its Fetch types are separate from Electron's DOM globals.
  return undiciFetch(
    requestUrl.toString(),
    init as unknown as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}

export interface HlsProxySession {
  id: string;
  url: string;
}

export interface HlsProxySessionInput {
  url: string;
  headers?: Record<string, string>;
  isLive?: boolean;
  requestPolicy?: PlaybackRequestPolicy;
  /** Electron WebContents that owns this session; omitted only in unit tests. */
  ownerId?: number;
}

export interface ProgressiveVodProxySession {
  id: string;
  url: string;
}

export interface MpegTsProxySession {
  id: string;
  url: string;
}

export interface DashProxySession {
  id: string;
  url: string;
}

export interface AutoPlaybackProxySession {
  id: string;
  url: string;
  format: AutoPlaybackFormat;
  container?: InspectedMediaContainer;
  mimeType?: string;
  videoCodecs?: readonly string[];
  audioCodecs?: readonly string[];
  audioOnly?: boolean;
  encrypted?: boolean;
  processingMode?: "direct" | "proxy" | "remux" | "convert";
}

type ProxyResource = {
  url: string;
  isManifest?: boolean;
  resourceKind?: PlaybackResourceKind;
  isLicense?: boolean;
  licenseHeaders?: Record<string, string>;
  fallbackUrl?: string;
  lastManifest?: { sequence: number; body: string };
  manifestMode?: "live" | "vod" | "unknown";
  progressiveVodCache?: ProgressiveVodCache;
  progressiveVodTotal?: number;
  progressiveVodPrefetch?: Promise<void>;
  progressiveVodPrefetchRange?: ByteRange;
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
  kind: "hls" | "progressive-vod" | "mpegts" | "dash";
  isLive: boolean;
  sourceUrl: string;
  headers: Record<string, string>;
  sourceOrigin: string;
  requestPolicy: PlaybackRequestPolicy;
  ownerId?: number;
  loginCookieJar?: CookieJar;
  portalCredentials?: PlaybackPortalCredentials;
  portalHeaders?: Record<string, string>;
  resources: Map<string, ProxyResource>;
  resourceIds: Map<string, string>;
  requests: Set<AbortController>;
  activeHandlers: Set<Promise<void>>;
  warmedResponse?: {
    resourceId: string;
    sourceUrl: string;
    method: "GET";
    range: undefined;
    response: Response;
    controller: AbortController;
    requestDiagnostics: ProxyRequestDiagnostics;
    expiresTimer: ReturnType<typeof setTimeout>;
  };
  warmedResponseCleanup?: Promise<void>;
  cookies: PlaybackCookieSession;
  lastUsedAt: number;
};

type ProxyRequestDiagnostics = {
  requestId: string;
  sessionId: string;
  resourceId: string;
  sourceUrl: string;
  resourceKind: string;
  phase: string;
  upstreamErrorRecorded: boolean;
};

type AutoPlaybackAttempt = {
  attemptId?: string;
  ownerId?: number;
  cancelled: boolean;
  sessionId?: string;
  controller?: AbortController;
  promise?: Promise<AutoPlaybackProxySession>;
};

export interface HlsPlaybackProxyServiceOptions {
  readonly mpegTsRemuxerPath?: string | null;
  readonly diagnostics?: PlaybackDiagnosticsStore | null;
  /** Test-only startup deadlines; the application uses the bounded 15 second defaults. */
  readonly startupHeaderTimeoutMs?: number;
  readonly startupPrefixTimeoutMs?: number;
  /** Test-only teardown deadline; production teardown has a bounded 5 second deadline. */
  readonly releaseTeardownTimeoutMs?: number;
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

/**
 * Destroy a bridged Fetch body and wait for Node's local readable to close.
 * Readable.fromWeb() can emit its cancellation error asynchronously, so keep a
 * listener installed until the terminal close event instead of acknowledging
 * cleanup immediately after destroy().
 */
function destroyReadableAndWait(body: Readable): Promise<Error | undefined> {
  if (body.closed) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let failure: Error | undefined;
    const cleanup = () => {
      body.off("error", onError);
      body.off("close", onClose);
    };
    const onError = (error: Error) => { failure ??= error; };
    const onClose = () => {
      cleanup();
      resolve(failure);
    };
    body.on("error", onError);
    body.once("close", onClose);
    if (body.closed) {
      onClose();
    } else if (!body.destroyed) {
      body.destroy();
    }
  });
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function opaqueId(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

/** Retain only supported playback headers; credentials are scoped to the source origin. */
export function sanitizeHlsProxyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return sanitizeProxyHeaders(
    headers,
    new Set([
      "user-agent",
      "referer",
      "origin",
      "authorization",
      "cookie",
      "sn",
      "x-user-agent",
    ]),
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
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
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

function isDashManifestUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".mpd");
  } catch {
    return false;
  }
}

function mergeCookieHeaders(
  preferred: string | undefined,
  fallback: string | undefined,
): string | undefined {
  const cookies = new Map<string, string>();
  for (const header of [fallback, preferred]) {
    for (const pair of header?.split(";") ?? []) {
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (name) cookies.set(name, `${name}=${value}`);
    }
  }
  const value = [...cookies.values()].join("; ");
  return value || undefined;
}

function allUnexpiredCookieHeader(jar: CookieJar | undefined): string | undefined {
  if (!jar) return undefined;
  const now = Date.now();
  const pairs = jar.serializeSync().cookies.flatMap((cookie) => {
    if (!cookie.key || typeof cookie.value !== "string") return [];
    const expires = cookie.expires;
    const expiresAt = expires === undefined || expires === "Infinity"
      ? Number.POSITIVE_INFINITY
      : typeof expires === "number"
        ? expires
        : Date.parse(String(expires));
    if (Number.isFinite(expiresAt) && expiresAt <= now) return [];
    return [`${cookie.key}=${cookie.value}`];
  });
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function sanitizeLicenseHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const forbidden = new Set([
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (
      /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) &&
      !forbidden.has(normalizedName) &&
      typeof value === "string" &&
      !/[\r\n]/.test(value)
    ) {
      result[normalizedName] = value;
    }
  }
  return result;
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
  preserveContentLength = false,
): void {
  const encoded = upstream.headers.has("content-encoding");
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
      normalizedName !== "content-encoding" &&
      ((preserveContentLength && !encoded) ||
        normalizedName !== "content-length")
    ) {
      response.setHeader(name, value);
    }
  });
}

async function readIncomingBodyBounded(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | null> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      chunks.length = 0;
      request.resume();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
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
  private readonly diagnostics: PlaybackDiagnosticsStore | undefined;
  private readonly startupHeaderTimeoutMs: number;
  private readonly startupPrefixTimeoutMs: number;
  private readonly releaseTeardownTimeoutMs: number;
  private readonly autoAttempts = new Map<string, AutoPlaybackAttempt>();
  private readonly releaseOperations = new Map<string, Promise<void>>();
  private readonly releaseContexts = new Map<string, ProxySession>();
  private readonly unsubscribeAccountInvalidation: () => void;
  private readonly sweepTimer = setInterval(
    () => this.sweepExpiredSessions(),
    SESSION_SWEEP_MS,
  );

  constructor(options: HlsPlaybackProxyServiceOptions = {}) {
    this.mpegTsRemuxerPath =
      options.mpegTsRemuxerPath === undefined
        ? resolveMpegTsRemuxerPath()
        : options.mpegTsRemuxerPath;
    this.diagnostics = options.diagnostics ?? undefined;
    this.startupHeaderTimeoutMs = options.startupHeaderTimeoutMs ?? DEFAULT_AUTO_STARTUP_TIMEOUT_MS;
    this.startupPrefixTimeoutMs = options.startupPrefixTimeoutMs ?? DEFAULT_AUTO_STARTUP_TIMEOUT_MS;
    this.releaseTeardownTimeoutMs = options.releaseTeardownTimeoutMs ?? DEFAULT_RELEASE_TEARDOWN_TIMEOUT_MS;
    this.unsubscribeAccountInvalidation = playbackAccountProfiles.onInvalidated(
      (accountRef) => {
        for (const [id, session] of this.sessions) {
          if (
            accountRef === undefined ||
            session.requestPolicy.accountRef === accountRef
          ) {
            this.releaseSession(id);
          }
        }
      },
    );
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

  async createDashSession(input: HlsProxySessionInput): Promise<DashProxySession> {
    return this.createProxySession("dash", input);
  }

  registerDashResource(
    sessionId: string,
    targetUrl: string,
    resourceKind: PlaybackResourceKind = "unknown",
    ownerId?: number,
  ): string {
    const session = this.requireDashSession(sessionId, ownerId);
    if (
      !["manifest", "playlist", "segment", "encryption-key", "license", "unknown"]
        .includes(resourceKind)
    ) {
      throw new Error("The DASH resource kind is invalid.");
    }
    if (!isHttpUrl(targetUrl)) {
      throw new Error("A DASH proxy resource must use an HTTP(S) URL.");
    }
    const key = `dash:${resourceKind}:${targetUrl}`;
    const existingId = session.resourceIds.get(key);
    if (existingId && session.resources.has(existingId)) {
      return this.localDashUrl(sessionId, existingId);
    }
    if (session.resources.size >= MAX_DASH_RESOURCES_PER_SESSION) {
      const rootId = session.resourceIds.get(session.sourceUrl);
      const evictable = [...session.resources.entries()].find(([id, resource]) =>
        id !== rootId &&
        !resource.isLicense &&
        resource.resourceKind !== "manifest" &&
        resource.resourceKind !== "playlist"
      );
      if (!evictable) {
        throw new Error("The DASH proxy resource registry is full.");
      }
      const [evictedId] = evictable;
      session.resources.delete(evictedId);
      for (const [key, id] of session.resourceIds) {
        if (id === evictedId) session.resourceIds.delete(key);
      }
    }
    const resourceId = opaqueId(16);
    session.resourceIds.set(key, resourceId);
    session.resources.set(resourceId, {
      url: targetUrl,
      resourceKind,
      isManifest: resourceKind === "manifest" || resourceKind === "playlist",
    });
    return this.localDashUrl(sessionId, resourceId);
  }

  registerDashLicense(
    sessionId: string,
    licenseUrl: string,
    licenseHeaders?: Record<string, string>,
    ownerId?: number,
  ): string {
    const session = this.requireDashSession(sessionId, ownerId);
    if (session.requestPolicy.licenseProxy !== true) {
      throw new Error("The DASH license relay was not selected for this playback attempt.");
    }
    if (!isHttpUrl(licenseUrl)) {
      throw new Error("A DASH license endpoint must use an HTTP(S) URL.");
    }
    const resourceId = opaqueId(16);
    session.resources.set(resourceId, {
      url: licenseUrl,
      resourceKind: "license",
      isLicense: true,
      licenseHeaders: sanitizeLicenseHeaders(licenseHeaders),
    });
    return this.localDashUrl(sessionId, resourceId);
  }

  assertSessionOwner(sessionId: string, ownerId: number): void {
    const session = this.sessions.get(sessionId) ?? this.releaseContexts.get(sessionId);
    if (!session) {
      throw new Error("Playback proxy session does not exist.");
    }
    this.assertOwner(session.ownerId, ownerId, `playback proxy session ${sessionId}`);
  }

  assertAttemptOwner(attemptId: string, ownerId: number): void {
    const attempt = this.autoAttempts.get(attemptId);
    if (!attempt) return;
    this.assertOwner(attempt.ownerId, ownerId, `automatic playback attempt ${attemptId}`);
  }

  private requireDashSession(sessionId: string, ownerId?: number): ProxySession {
    const session = this.sessions.get(sessionId);
    if (!session || session.kind !== "dash") {
      throw new Error("DASH proxy session does not exist.");
    }
    if (ownerId !== undefined) {
      this.assertOwner(session.ownerId, ownerId, `DASH proxy session ${sessionId}`);
    }
    return session;
  }

  private assertOwner(expectedOwnerId: number | undefined, actualOwnerId: number | undefined, label: string): void {
    if (expectedOwnerId !== undefined && expectedOwnerId !== actualOwnerId) {
      throw new Error(`${label} belongs to another renderer.`);
    }
  }

  private localDashUrl(sessionId: string, resourceId: string): string {
    if (this.port === null) {
      throw new Error("The DASH proxy is not available.");
    }
    return `http://127.0.0.1:${this.port}/dash/${sessionId}/${resourceId}`;
  }

  createAutoSession(
    url: string,
    headers?: Record<string, string>,
    isLive = true,
    attemptId?: string,
    requestPolicy?: PlaybackRequestPolicy,
    ownerId?: number,
  ): Promise<AutoPlaybackProxySession> {
    if (attemptId && this.autoAttempts.has(attemptId)) {
      return Promise.reject(new Error("An automatic playback attempt with this ID is already active."));
    }
    const attempt: AutoPlaybackAttempt = { attemptId, ownerId, cancelled: false };
    if (attemptId) this.autoAttempts.set(attemptId, attempt);
    const operation = this.prepareAutoSession(
      url,
      headers,
      isLive,
      attempt,
      requestPolicy,
    ).then(
      (result) => {
        attempt.sessionId = result.id;
        return result;
      },
      (error: unknown) => {
        if (attemptId) {
          const mappedAttempt = this.autoAttempts.get(attemptId);
          const sessionId = attempt.sessionId;
          const cleanupStillOwned = sessionId !== undefined &&
            (this.sessions.has(sessionId) || this.releaseOperations.has(sessionId));
          if (cleanupStillOwned) {
            if (mappedAttempt === undefined || mappedAttempt === attempt) {
              this.autoAttempts.set(attemptId, attempt);
            }
          } else if (mappedAttempt === attempt) {
            this.autoAttempts.delete(attemptId);
          }
        }
        throw error;
      },
    );
    attempt.promise = operation;
    return operation;
  }

  async cancelAutoSession(attemptId: string, ownerId?: number): Promise<void> {
    const attempt = this.autoAttempts.get(attemptId);
    if (!attempt) return;
    this.assertOwner(attempt.ownerId, ownerId, `automatic playback attempt ${attemptId}`);
    attempt.cancelled = true;
    attempt.controller?.abort();
    await attempt.promise?.then(() => undefined, () => undefined);
    if (attempt.sessionId) await this.releaseSessionAndWait(attempt.sessionId);
    const cleanupStillOwned = attempt.sessionId !== undefined &&
      (this.sessions.has(attempt.sessionId) || this.releaseOperations.has(attempt.sessionId));
    if (cleanupStillOwned) {
      throw new Error(`Automatic playback attempt ${attemptId} still owns a proxy session cleanup.`);
    }
    if (this.autoAttempts.get(attemptId) === attempt) this.autoAttempts.delete(attemptId);
  }

  private async prepareAutoSession(
    url: string,
    headers: Record<string, string> | undefined,
    isLive: boolean,
    attempt: AutoPlaybackAttempt,
    requestPolicy?: PlaybackRequestPolicy,
  ): Promise<AutoPlaybackProxySession> {
    const provisional = await this.createProxySession("mpegts", {
      url,
      headers,
      isLive,
      requestPolicy,
      ownerId: attempt.ownerId,
    });
    attempt.sessionId = provisional.id;
    const session = this.sessions.get(provisional.id);
    const rootId = session?.resourceIds.get(url);
    const resource = rootId && session?.resources.get(rootId);
    if (!session || !rootId || !resource) {
      throw new Error("Unable to prepare the automatic playback proxy session.");
    }
    if (attempt.cancelled) {
      await this.releaseSessionAndWait(provisional.id);
      throw new MediaInspectionError("cancelled", null, "Media inspection was cancelled.");
    }

    const controller = new AbortController();
    attempt.controller = controller;
    session.requests.add(controller);
    let finishInspection!: () => void;
    const inspectionFinished = new Promise<void>((resolve) => { finishInspection = resolve; });
    session.activeHandlers.add(inspectionFinished);
    let inspectionFinishedSignaled = false;
    const completeInspection = () => {
      if (inspectionFinishedSignaled) return;
      inspectionFinishedSignaled = true;
      session.activeHandlers.delete(inspectionFinished);
      finishInspection();
    };
    const requestDiagnostics: ProxyRequestDiagnostics = {
      requestId: opaqueId(16),
      sessionId: provisional.id,
      resourceId: rootId,
      sourceUrl: session.sourceUrl,
      resourceKind: "auto-inspection",
      phase: "auto-inspection",
      upstreamErrorRecorded: false,
    };
    let headerTimedOut = false;
    let inspectionRecorded = false;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    const headerTimeout = new Promise<never>((_resolve, reject) => {
      headerTimer = setTimeout(() => {
        headerTimedOut = true;
        const error = new MediaInspectionError(
          "startup-timeout",
          null,
          `The source did not return response headers within ${this.startupHeaderTimeoutMs} ms.`,
        );
        controller.abort(error);
        reject(error);
      }, this.startupHeaderTimeoutMs);
      headerTimer.unref?.();
    });

    let upstream: Response | undefined;
    try {
      const fetchStartupResponse = (phase: string): Promise<Response> => this.fetchUpstream(
        requestDiagnostics,
        phase,
        url,
        {
          method: "GET",
          headers: this.upstreamHeaders(session, url, undefined),
          redirect: "follow",
          signal: controller.signal,
        },
      );
      upstream = await Promise.race([fetchStartupResponse("auto-inspection"), headerTimeout]);
      if (upstream.status === 401) {
        const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
        const setCookieHeaders = getSetCookie?.call(upstream.headers);
        const responseUrl = upstream.url || url;
        const learnedCookie = setCookieHeaders?.length
          ? await Promise.race([
            session.cookies.getCookieHeader(responseUrl, false),
            headerTimeout,
          ])
          : undefined;
        if (learnedCookie && !attempt.cancelled && this.sessions.has(provisional.id)) {
          await Promise.race([
            upstream.body?.cancel() ?? Promise.resolve(),
            headerTimeout,
          ]);
          if (attempt.cancelled || !this.sessions.has(provisional.id)) {
            throw new MediaInspectionError("cancelled", upstream.status, "Media inspection was cancelled.");
          }
          upstream = await Promise.race([
            fetchStartupResponse("auto-cookie-challenge-retry"),
            headerTimeout,
          ]);
        }
      }
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      headerTimer = undefined;

      const inspected = await inspectResponseForMedia(upstream, url, {
        prefixTimeoutMs: this.startupPrefixTimeoutMs,
        signal: controller.signal,
        onTimeout: () => controller.abort(),
      });
      if (attempt.cancelled || !this.sessions.has(provisional.id)) {
        await inspected.response.body?.cancel().catch(() => undefined);
        throw new MediaInspectionError("cancelled", inspected.response.status, "Media inspection was cancelled.");
      }

      session.kind = inspected.media.format === "hls"
        ? "hls"
        : inspected.media.format === "mpegts"
          ? "mpegts"
          : inspected.media.format === "dash"
            ? "dash"
          : "progressive-vod";
      session.headers = session.kind === "mpegts"
        ? sanitizeMpegTsProxyHeaders(headers)
        : sanitizeHlsProxyHeaders(headers);
      resource.isManifest = inspected.media.format === "hls";
      if (inspected.media.format === "dash") {
        resource.resourceKind = "manifest";
      }
      this.recordAutoInspection(
        session,
        requestDiagnostics,
        inspected.media.format,
        inspected.media.container,
        inspected.response.status,
      );
      inspectionRecorded = true;
      session.warmedResponse = {
        resourceId: rootId,
        sourceUrl: url,
        method: "GET",
        range: undefined,
        response: inspected.response,
        controller,
        requestDiagnostics,
        expiresTimer: setTimeout(() => {
          void this.discardWarmedResponse(session);
        }, AUTO_WARM_RESPONSE_TTL_MS),
      };
      session.warmedResponse.expiresTimer.unref?.();
      const route = session.kind === "hls"
        ? "hls"
        : session.kind === "progressive-vod"
          ? "media"
          : session.kind === "dash"
            ? "dash"
            : "stream";
      completeInspection();
      return {
        id: provisional.id,
        url: provisional.url.replace(/\/(?:hls|media|stream)\//, `/${route}/`),
        format: inspected.media.format,
        ...(inspected.media.container ? { container: inspected.media.container } : {}),
        ...(inspected.media.mimeType ? { mimeType: inspected.media.mimeType } : {}),
        ...(inspected.media.videoCodecs ? { videoCodecs: inspected.media.videoCodecs } : {}),
        ...(inspected.media.audioCodecs ? { audioCodecs: inspected.media.audioCodecs } : {}),
        ...(inspected.media.audioOnly !== undefined ? { audioOnly: inspected.media.audioOnly } : {}),
        ...(inspected.media.encrypted !== undefined ? { encrypted: inspected.media.encrypted } : {}),
        processingMode:
          inspected.media.format === "mpegts" && isLive && this.mpegTsRemuxerPath
            ? "remux"
            : "proxy",
      };
    } catch (error) {
      completeInspection();
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      if (error instanceof MediaInspectionError && !inspectionRecorded) {
        this.recordAutoInspection(
          session,
          requestDiagnostics,
          error.format ?? "unknown",
          undefined,
          error.status,
          error.code,
        );
      }
      if (upstream?.body) void upstream.body.cancel().catch(() => undefined);
      await this.releaseSessionAndWait(provisional.id);
      if (attempt.cancelled && !(error instanceof MediaInspectionError && error.code === "unsupported-dash")) {
        throw new MediaInspectionError("cancelled", error instanceof MediaInspectionError ? error.status : null, "Media inspection was cancelled.", { cause: error });
      }
      if (headerTimedOut) {
        throw new MediaInspectionError("startup-timeout", null, `The source did not return response headers within ${this.startupHeaderTimeoutMs} ms.`, { cause: error });
      }
      throw error;
    } finally {
      completeInspection();
      if (headerTimer !== undefined) clearTimeout(headerTimer);
      if (!session.warmedResponse || session.warmedResponse.controller !== controller) {
        session.requests.delete(controller);
      }
      if (attempt.controller === controller && !session.warmedResponse) {
        attempt.controller = undefined;
      }
    }
  }

  private recordAutoInspection(
    session: ProxySession,
    context: ProxyRequestDiagnostics,
    format: AutoPlaybackFormat,
    container: InspectedMediaContainer | undefined,
    status: number | null,
    reason?: string,
  ): void {
    this.diagnostics?.record({
      event: "auto-media-inspected",
      requestId: context.requestId,
      sourceUrl: session.sourceUrl,
      status: status ?? undefined,
      sessionId: context.sessionId,
      resourceId: context.resourceId,
      phase: "auto-inspection",
      transport: "electron-main-fetch",
      resourceKind: "auto-inspection",
      activeSessions: this.sessions.size,
      details: [
        `format=${format}`,
        ...(container ? [`container=${container}`] : []),
        ...(reason ? [`reason=${reason}`] : []),
      ].join(";"),
    });
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
    const sourceOrigin = new URL(input.url).origin;
    const headers =
      kind === "mpegts"
        ? sanitizeMpegTsProxyHeaders(input.headers)
        : sanitizeHlsProxyHeaders(input.headers);
    const profile = input.requestPolicy?.accountRef
      ? playbackAccountProfiles.snapshot(input.requestPolicy.accountRef)
      : {};
    const session: ProxySession = {
      kind,
      isLive: input.isLive ?? true,
      sourceUrl: input.url,
      sourceOrigin,
      headers,
      requestPolicy: { ...input.requestPolicy },
      ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
      ...(input.requestPolicy?.loginCookies && profile.cookies
        ? { loginCookieJar: profile.cookies }
        : {}),
      ...(input.requestPolicy?.portalCredentials && profile.portalCredentials
        ? { portalCredentials: profile.portalCredentials }
        : {}),
      ...(input.requestPolicy?.portalCredentials && profile.portalHeaders
        ? { portalHeaders: profile.portalHeaders }
        : {}),
      cookies: new PlaybackCookieSession(sourceOrigin, headers.cookie),
      resources: new Map([
        [
          rootId,
          {
            url: input.url,
            fallbackUrl: input.url,
            isManifest:
              (kind === "hls" && isHlsManifest(null, input.url)) ||
              (kind === "dash" && isDashManifestUrl(input.url)),
            ...(kind === "dash" ? { resourceKind: "manifest" as const } : {}),
          },
        ],
      ]),
      resourceIds: new Map([[input.url, rootId]]),
      requests: new Set(),
      activeHandlers: new Set(),
      lastUsedAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.diagnostics?.record({
      event: "proxy-session-created",
      operation: "session-create",
      sessionId: id,
      resourceId: rootId,
      sourceUrl: session.sourceUrl,
      requestHeaders: { ...session.headers },
      transport: "electron-main-fetch",
      resourceKind: kind,
      activeSessions: this.sessions.size,
    });
    const route =
      kind === "hls"
        ? "hls"
        : kind === "progressive-vod"
          ? "media"
          : kind === "dash"
            ? "dash"
            : "stream";
    return {
      id,
      url: `http://127.0.0.1:${this.port}/${route}/${id}/${rootId}`,
    };
  }

  releaseSession(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.releaseContexts.set(id, session);
    session.cookies.dispose();
    session.loginCookieJar?.removeAllCookiesSync();
    session.portalCredentials = undefined;
    this.diagnostics?.record({
      event: "proxy-session-released",
      operation: "session-release",
      sessionId: id,
      resourceId: session.resources.keys().next().value,
      sourceUrl: session.sourceUrl,
      requestHeaders: { ...session.headers },
      transport: "electron-main-fetch",
      resourceKind: session.kind,
      activeSessions: this.sessions.size,
    });
    const teardown = this.teardownSession(session);
    this.releaseOperations.set(id, teardown);
    void teardown.then(() => {
      if (this.releaseOperations.get(id) === teardown) this.releaseOperations.delete(id);
      if (this.releaseContexts.get(id) === session) {
        this.recordReleaseDiagnostic("proxy-session-release-confirmed", id, session);
        this.releaseContexts.delete(id);
      }
      for (const [attemptId, attempt] of this.autoAttempts) {
        if (attempt.sessionId === id) this.autoAttempts.delete(attemptId);
      }
    }, (error: unknown) => {
      this.recordReleaseDiagnostic("proxy-release-failed", id, session, error);
    });
  }

  async releaseSessionAndWait(id: string, ownerId?: number): Promise<void> {
    if (ownerId !== undefined && (this.sessions.has(id) || this.releaseContexts.has(id))) {
      this.assertSessionOwner(id, ownerId);
    }
    if (this.sessions.has(id)) this.releaseSession(id);
    const teardown = this.releaseOperations.get(id);
    if (!teardown) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      await Promise.race([
        teardown,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              timedOut = true;
              reject(new Error(`Timed out waiting for playback proxy session ${id} to stop.`));
            },
            this.releaseTeardownTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      const session = this.releaseContexts.get(id);
      if (timedOut && session) {
        this.recordReleaseDiagnostic("proxy-release-timeout", id, session, error, this.releaseTeardownTimeoutMs);
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private recordReleaseDiagnostic(
    event: string,
    sessionId: string,
    session: ProxySession,
    error?: unknown,
    timeoutMs?: number,
  ): void {
    this.diagnostics?.record({
      event,
      operation: "session-release",
      sessionId,
      resourceId: session.resources.keys().next().value,
      sourceUrl: session.sourceUrl,
      phase: "release",
      transport: "electron-main-fetch",
      resourceKind: session.kind,
      activeSessions: this.sessions.size,
      details: [
        `activeHandlers=${session.activeHandlers.size}`,
        ...(timeoutMs === undefined ? [] : [`timeoutMs=${timeoutMs}`]),
      ].join(";"),
      ...(error === undefined ? {} : { error }),
    });
  }

  private async teardownSession(session: ProxySession): Promise<void> {
    const warm = session.warmedResponse;
    session.warmedResponse = undefined;
    if (warm) clearTimeout(warm.expiresTimer);
    for (const request of session.requests) request.abort();
    let cancelWarm: Promise<void> | undefined;
    try {
      cancelWarm = warm?.response.body?.cancel().catch(() => undefined);
    } catch (error) {
      cancelWarm = Promise.reject(error);
    }
    const results = await Promise.allSettled([
      ...(cancelWarm ? [cancelWarm] : []),
      ...(session.warmedResponseCleanup ? [session.warmedResponseCleanup] : []),
      ...session.activeHandlers,
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
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
    await Promise.allSettled(
      [...this.sessions.keys()].map((id) => this.releaseSessionAndWait(id)),
    );
    clearInterval(this.sweepTimer);
    this.unsubscribeAccountInvalidation();
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
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      request.headers["access-control-request-headers"] ??
        "Range, Accept, Content-Type, Authorization",
    );
    response.setHeader(
      "Access-Control-Expose-Headers",
      `Accept-Ranges, Content-Length, Content-Range, Content-Type, Retry-After, ${DASH_UPSTREAM_URI_HEADER}, ${DASH_REQUEST_ID_HEADER}, ${DASH_RESOURCE_KIND_HEADER}`,
    );
    response.setHeader("Vary", "Origin");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.method !== "POST"
    ) {
      response.writeHead(405).end();
      return;
    }

    const match = request.url?.match(
      /^(\/hls|\/media|\/stream|\/dash)\/([a-f0-9]{48})\/([a-f0-9]{32})(\/continuous)?$/,
    );
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    const [, route, sessionId, resourceId] = match;
    if (match[4] && route !== "/media") {
      response.writeHead(404).end();
      return;
    }
    const session = this.sessions.get(sessionId);
    const resource = session?.resources.get(resourceId);
    const expectedKind =
      route === "/hls"
        ? "hls"
        : route === "/media"
          ? "progressive-vod"
          : route === "/dash"
            ? "dash"
            : "mpegts";
    if (!session || !resource || session.kind !== expectedKind) {
      response.writeHead(404).end();
      return;
    }
    if (
      request.method === "POST" &&
      (session.kind !== "dash" || !resource.isLicense)
    ) {
      response.writeHead(405).end();
      return;
    }
    const warmedResponse = this.takeWarmedResponse(session, resourceId, request);
    const requestDiagnostics: ProxyRequestDiagnostics = warmedResponse?.requestDiagnostics ?? {
      requestId: opaqueId(16),
      sessionId,
      resourceId,
      sourceUrl: session.sourceUrl,
      resourceKind:
        session.kind === "hls"
          ? resource.isManifest || isHlsManifest(null, resource.url)
            ? "hls-manifest"
            : "hls-resource"
          : session.kind === "dash"
            ? resource.resourceKind ?? "unknown"
            : session.kind,
      phase: "initial",
      upstreamErrorRecorded: false,
    };
    let finishHandler!: () => void;
    const handlerFinished = new Promise<void>((resolve) => { finishHandler = resolve; });
    session.activeHandlers.add(handlerFinished);
    session.lastUsedAt = Date.now();
    const controller = new AbortController();
    session.requests.add(controller);
    const warmedController = warmedResponse?.controller;
    const abort = () => {
      controller.abort();
      warmedController?.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      if (!warmedResponse && session.warmedResponse) {
        await this.discardWarmedResponse(session);
      } else if (!warmedResponse && session.warmedResponseCleanup) {
        await session.warmedResponseCleanup;
      }
      const requestedRange =
        session.kind === "progressive-vod"
          ? parseByteRange(request.headers.range)
          : null;
      const continuous = !!match[4] && (!requestedRange || requestedRange.end === null);
      if (session.kind === "mpegts") {
        await this.handleMpegTsStreamRequest(
          request,
          response,
          session,
          resource,
          controller,
          requestDiagnostics,
          warmedResponse?.response,
        );
        return;
      }
      if (session.kind === "dash") {
        await this.handleDashResourceRequest(
          request,
          response,
          session,
          resource,
          controller,
          requestDiagnostics,
        );
        return;
      }
      if (requestedRange && request.method === "GET" && !continuous) {
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
      let upstream = warmedResponse?.response ?? await this.fetchUpstream(
          requestDiagnostics,
          "initial",
          resource.url,
          {
            method: request.method,
            headers: this.upstreamHeaders(session, resource.url, upstreamRange),
            redirect: "follow",
            signal: controller.signal,
          },
        );
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
          upstream = await this.fetchUpstream(
            requestDiagnostics,
            "range-retry",
            resource.url,
            {
              method: "GET",
              headers: this.upstreamHeaders(
                session,
                resource.url,
                `bytes=${requestedRange.start}-${expandedEnd}`,
              ),
              redirect: "follow",
              signal: controller.signal,
            },
          );
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
        upstream = await this.fetchUpstream(
          requestDiagnostics,
          "range-retry",
          resource.url,
          {
            method: "GET",
            headers: this.upstreamHeaders(session, resource.url, upstreamRange),
            redirect: "follow",
            signal: controller.signal,
          },
        );
      }
      if (session.kind === "progressive-vod" && request.method === "GET") {
        upstream = this.recoverProgressiveUpstream(upstream, requestDiagnostics, session, resource, controller.signal, continuous);
      }
      let usedSuccessfulLiveManifestFallback = false;
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
          upstream = await this.fetchUpstream(
            requestDiagnostics,
            refreshUrl === refreshUrls[0]
              ? "manifest-refresh"
              : "manifest-fallback",
            refreshUrl,
            {
              method: request.method,
              headers: this.upstreamHeaders(
                session,
                refreshUrl,
                request.headers.range,
              ),
              redirect: "follow",
              signal: controller.signal,
            },
          );
          if (
            !shouldRefreshLiveManifest(upstream.status) ||
            refreshUrl === refreshUrls.at(-1)
          ) {
            break;
          }
          await upstream.body?.cancel().catch(() => undefined);
        }
        usedSuccessfulLiveManifestFallback = upstream.ok;
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
        (resource.isManifest ||
          isHlsManifest(
            upstream.headers.get("content-type"),
            upstream.url || resource.url,
          )) &&
        request.method === "GET"
      ) {
        resource.isManifest = true;
        const manifest = await upstream.text();
        const manifestMode = detectManifestMode(manifest);
        if (manifestMode !== "unknown") {
          resource.manifestMode = manifestMode;
        }
        const sequence = getHlsMediaSequence(manifest);
        const previous = resource.lastManifest;
        const resetAfterFallback =
          usedSuccessfulLiveManifestFallback &&
          resource.manifestMode === "live" &&
          sequence !== null &&
          previous !== undefined &&
          sequence < previous.sequence;
        if (resetAfterFallback) {
          // A successful fallback can land on an encoder that restarted at a
          // lower media sequence, even when its URL is unchanged. Drop only
          // the cached comparison point for this response; ordinary lower
          // sequences still reuse the last known-good manifest.
          resource.lastManifest = undefined;
        }
        const previousForComparison = resetAfterFallback
          ? undefined
          : previous;
        const previousToReuse =
          resource.manifestMode === "live" &&
          sequence !== null &&
          previousForComparison &&
          sequence < previousForComparison.sequence
            ? previousForComparison
            : undefined;
        const body = previousToReuse
          ? previousToReuse.body
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
          (resetAfterFallback ||
            !previous ||
            sequence >= previous.sequence)
        ) {
          resource.lastManifest = { sequence, body };
        }
        copyResponseHeaders(upstream, response);
        response.writeHead(upstream.status);
        response.end(body);
        return;
      }
      const progressiveOpenRange =
        !continuous &&
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
        copyResponseHeaders(upstream, response);
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
            while (cachedBytes < PROGRESSIVE_VOD_PREFETCH_BYTES) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              const remaining = PROGRESSIVE_VOD_PREFETCH_BYTES - cachedBytes;
              const copy = Buffer.from(value.subarray(0, remaining));
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
                requestDiagnostics,
              );
            }
          } finally {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        })();
        response.writeHead(upstream.status);
        const clientPromise = new Promise<void>((resolve, reject) => {
          const body = Readable.fromWeb(clientStream as never);
          let settled = false;
          let terminating = false;
          const cleanup = () => {
            body.off("error", fail);
            response.off("error", fail);
            response.off("close", close);
            response.off("finish", finish);
          };
          const complete = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          };
          const close = () => {
            if (settled || terminating) return;
            terminating = true;
            body.unpipe(response);
            void destroyReadableAndWait(body).then((destroyError) => {
              if (settled) return;
              if (destroyError) {
                settled = true;
                cleanup();
                reject(destroyError);
              } else {
                complete();
              }
            });
          };
          const fail = (error: Error) => {
            if (settled || terminating) return;
            terminating = true;
            body.unpipe(response);
            void destroyReadableAndWait(body).then((destroyError) => {
              if (settled) return;
              settled = true;
              cleanup();
              reject(error ?? destroyError);
            });
          };
          const finish = () => {
            if (!terminating) complete();
          };
          body.once("error", fail);
          response.once("error", fail);
          response.once("close", close);
          response.once("finish", finish);
          if (response.destroyed) {
            close();
            return;
          }
          if (response.writableFinished) {
            complete();
            return;
          }
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
        session.kind === "progressive-vod",
      );

      if (
        session.kind === "progressive-vod" &&
        !continuous &&
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
          const clientEnd = Math.min(
            requestedRange.end ?? contentRange.end,
            contentRange.total - 1,
          );
          if (clientEnd > contentRange.end) {
            response.removeHeader("content-length");
            response.removeHeader("content-range");
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
            true,
            false,
            requestDiagnostics,
          );
          return;
        }
        if (contentRange) {
          response.removeHeader("content-length");
          response.removeHeader("content-range");
          response.writeHead(502).end();
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
        let settled = false;
        let terminating = false;
        const cleanup = () => {
          body.off("error", fail);
          body.off("close", bodyClose);
          response.off("error", fail);
          response.off("close", responseClose);
          response.off("finish", finish);
        };
        const complete = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (error: Error) => {
          if (settled || terminating) return;
          terminating = true;
          body.unpipe(response);
          void destroyReadableAndWait(body).then((destroyError) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error ?? destroyError);
          });
        };
        const responseClose = () => {
          if (settled || terminating) return;
          terminating = true;
          body.unpipe(response);
          void destroyReadableAndWait(body).then((destroyError) => {
            if (settled) return;
            if (destroyError) {
              settled = true;
              cleanup();
              reject(destroyError);
            } else {
              complete();
            }
          });
        };
        const bodyClose = () => {
          if (!body.readableEnded && !response.destroyed && !response.writableFinished) {
            fail(new Error("Playback response body closed before reaching EOF."));
          }
        };
        const finish = () => {
          if (!terminating) complete();
        };
        body.once("error", fail);
        body.once("close", bodyClose);
        response.once("error", fail);
        response.once("close", responseClose);
        response.once("finish", finish);
        if (response.destroyed) {
          responseClose();
          return;
        }
        if (response.writableFinished) {
          complete();
          return;
        }
        body.pipe(response);
      });
    } catch (error) {
      if (!requestDiagnostics.upstreamErrorRecorded) {
        this.diagnostics?.record({
          event: "proxy-request-error",
          requestId: requestDiagnostics.requestId,
          sessionId: requestDiagnostics.sessionId,
          resourceId: requestDiagnostics.resourceId,
          sourceUrl: requestDiagnostics.sourceUrl,
          requestUrl: resource.url,
          requestHeaders: this.upstreamHeaders(session, resource.url, request.headers.range),
          phase: requestDiagnostics.phase,
          transport: "electron-main-fetch",
          resourceKind: requestDiagnostics.resourceKind,
          activeSessions: this.sessions.size,
          error,
        });
      }
      const responseStarted = response.headersSent;
      if (!responseStarted && !controller.signal.aborted && !response.destroyed) {
        response.removeHeader("content-length");
        response.removeHeader("content-range");
        response.writeHead(502);
      }
      if (responseStarted && session.kind === "progressive-vod" && !response.writableEnded) {
        // A truncated movie is a network failure, not a successful EOF.
        response.destroy();
      } else if (!response.writableEnded && !response.destroyed) response.end();
      void error;
    } finally {
      request.off("aborted", abort);
      response.off("close", abort);
      session.requests.delete(controller);
      if (warmedController) session.requests.delete(warmedController);
      session.activeHandlers.delete(handlerFinished);
      finishHandler();
    }
  }

  private takeWarmedResponse(
    session: ProxySession,
    resourceId: string,
    request: IncomingMessage,
  ): NonNullable<ProxySession["warmedResponse"]> | undefined {
    const warmed = session.warmedResponse;
    if (!warmed || warmed.resourceId !== resourceId) return undefined;
    const resource = session.resources.get(resourceId);
    if (resource?.url !== warmed.sourceUrl || request.method !== warmed.method) return undefined;
    const range = request.headers.range?.trim();
    const exactRequest = !range;
    const compatibleInitialRange =
      session.kind === "progressive-vod" &&
      warmed.response.status === 200 &&
      parseByteRange(range)?.start === 0 &&
      parseByteRange(range)?.end === null;
    if (!exactRequest && !compatibleInitialRange) return undefined;
    session.warmedResponse = undefined;
    clearTimeout(warmed.expiresTimer);
    return warmed;
  }

  private async discardWarmedResponse(session: ProxySession): Promise<void> {
    const warmed = session.warmedResponse;
    if (!warmed) {
      await session.warmedResponseCleanup;
      return;
    }
    session.warmedResponse = undefined;
    clearTimeout(warmed.expiresTimer);
    const cleanup = (async () => {
      warmed.controller.abort();
      await warmed.response.body?.cancel().catch(() => undefined);
      session.requests.delete(warmed.controller);
    })();
    session.warmedResponseCleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (session.warmedResponseCleanup === cleanup) session.warmedResponseCleanup = undefined;
    }
  }

  private recoverProgressiveUpstream(
    upstream: Response,
    context: ProxyRequestDiagnostics,
    session: ProxySession,
    resource: ProxyResource,
    signal: AbortSignal,
    continuous = false,
  ): Response {
    const phase = `${context.phase}-continuation`;
    return recoverProgressiveResponse(upstream, signal, async (range, validator) => {
      const headers = this.upstreamHeaders(session, resource.url, range);
      if (validator) headers["if-range"] = validator;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), DEFAULT_AUTO_STARTUP_TIMEOUT_MS);
      try {
        // Revisit the provider URL so one-use redirect tokens can be reacquired.
        return await this.fetchUpstream(context, phase, resource.url, {
          method: "GET", headers, redirect: "follow",
          signal: AbortSignal.any([signal, deadline.signal]),
        });
      } finally {
        clearTimeout(timer);
      }
    }, continuous);
  }

  private async fetchUpstream(
    context: ProxyRequestDiagnostics,
    phase: string,
    requestUrl: string,
    init: RequestInit & { headers: Record<string, string> },
    useAccountPolicy = true,
    explicitCredentialOrigin?: string,
  ): Promise<Response> {
    context.phase = phase;
    context.upstreamErrorRecorded = false;
    const startedAt = Date.now();
    try {
      const session = this.sessions.get(context.sessionId);
      const response = await this.fetchWithPlaybackCookies(
        requestUrl,
        init,
        session?.sourceOrigin,
        useAccountPolicy ? session?.cookies : undefined,
        useAccountPolicy ? session?.loginCookieJar : undefined,
        useAccountPolicy ? session?.portalCredentials : undefined,
        useAccountPolicy ? session?.portalHeaders : undefined,
        useAccountPolicy ? session?.requestPolicy : undefined,
        explicitCredentialOrigin,
        this.diagnostics
          ? (event) => {
            this.diagnostics?.record({
              ...event,
              sourceUrl: context.sourceUrl,
              requestId: context.requestId,
              sessionId: context.sessionId,
              resourceId: context.resourceId,
              phase,
              transport: "electron-main-fetch",
              resourceKind: context.resourceKind,
              activeSessions: this.sessions.size,
            });
          }
          : undefined,
      );
      this.diagnostics?.record({
        event: "upstream-response",
        requestId: context.requestId,
        sourceUrl: context.sourceUrl,
        requestUrl,
        responseUrl: response.url,
        requestHeaders: { ...init.headers },
        responseHeaders: this.responseHeaders(response.headers),
        status: response.status,
        details: response.statusText,
        durationMs: Date.now() - startedAt,
        sessionId: context.sessionId,
        resourceId: context.resourceId,
        phase,
        transport: "electron-main-fetch",
        resourceKind: context.resourceKind,
        activeSessions: this.sessions.size,
      });
      return response;
    } catch (error) {
      context.upstreamErrorRecorded = true;
      this.diagnostics?.record({
        event: "upstream-error",
        requestId: context.requestId,
        sourceUrl: context.sourceUrl,
        requestUrl,
        requestHeaders: { ...init.headers },
        durationMs: Date.now() - startedAt,
        sessionId: context.sessionId,
        resourceId: context.resourceId,
        phase,
        transport: "electron-main-fetch",
        resourceKind: context.resourceKind,
        activeSessions: this.sessions.size,
        error,
      });
      throw error;
    }
  }

  private async fetchWithPlaybackCookies(
    requestUrl: string,
    init: RequestInit & { headers: Record<string, string> },
    sourceOrigin: string | undefined,
    cookies: PlaybackCookieSession | undefined,
    loginCookieJar: CookieJar | undefined,
    portalCredentials: PlaybackPortalCredentials | undefined,
    portalHeaders: Record<string, string> | undefined,
    requestPolicy: PlaybackRequestPolicy | undefined,
    explicitCredentialOrigin: string | undefined,
    observe?: Parameters<typeof withFetchDiagnostics>[1],
  ): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "POST") {
      throw new TypeError("Playback proxy supports GET, HEAD, and POST requests only.");
    }
    const redirectMode = init.redirect ?? "follow";
    const initial = new URL(requestUrl);
    if (!isHttpUrl(initial.toString())) {
      throw new TypeError("Playback proxy targets must be HTTP(S) URLs without userinfo.");
    }
    let currentUrl = initial;
    let currentMethod = method;
    let currentBody = init.body;
    const baseHeaders = { ...init.headers };
    if (requestPolicy?.portalCredentials === true && portalHeaders) {
      Object.assign(baseHeaders, portalHeaders);
    }
    let forwardManualCredentials =
      (sourceOrigin !== undefined && currentUrl.origin === sourceOrigin) ||
      (explicitCredentialOrigin !== undefined &&
        currentUrl.origin === explicitCredentialOrigin);
    let redirectCount = 0;
    while (true) {
      const headers = { ...baseHeaders };
      delete headers.cookie;
      if (!forwardManualCredentials && requestPolicy?.portalCredentials !== true) {
        delete headers.authorization;
      }
      if (requestPolicy?.portalCredentials === true && portalCredentials && !headers.authorization) {
        headers.authorization = `Basic ${Buffer.from(
          `${portalCredentials.username}:${portalCredentials.password}`,
          "utf8",
        ).toString("base64")}`;
      }
      const accountCookieHeader = requestPolicy?.loginCookies === true
        ? allUnexpiredCookieHeader(loginCookieJar)
        : undefined;
      const selectedPortalCookieHeader = requestPolicy?.portalCredentials === true
        ? portalHeaders?.cookie
        : undefined;
      const playbackCookieHeader = await cookies?.getCookieHeader(
        currentUrl.toString(),
        forwardManualCredentials,
      );
      const configuredLicenseCookie = explicitCredentialOrigin !== undefined && forwardManualCredentials
        ? baseHeaders.cookie
        : undefined;
      const cookieHeader = mergeCookieHeaders(
        mergeCookieHeaders(playbackCookieHeader, accountCookieHeader),
        mergeCookieHeaders(selectedPortalCookieHeader, configuredLicenseCookie),
      );
      if (cookieHeader) headers.cookie = cookieHeader;
      const response = await (observe
        ? withFetchDiagnostics(
            () => fetchProviderUpstream(currentUrl, {
              ...init,
              method: currentMethod,
              ...(currentMethod === "GET" || currentMethod === "HEAD"
                ? { body: undefined }
                : { body: currentBody }),
              headers,
              redirect: "manual",
            }),
            observe,
          )
        : fetchProviderUpstream(currentUrl, {
            ...init,
            method: currentMethod,
            ...(currentMethod === "GET" || currentMethod === "HEAD"
              ? { body: undefined }
              : { body: currentBody }),
            headers,
            redirect: "manual",
          }));
      const getSetCookie = (
        response.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie;
      const setCookieHeaders = getSetCookie?.call(response.headers);
      if (setCookieHeaders?.length) {
        await cookies?.storeSetCookieHeaders(
          currentUrl.toString(),
          setCookieHeaders,
        );
      }

      const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
      const location = response.headers.get("location");
      if (!isRedirect || location === null || redirectMode === "manual") {
        return response;
      }
      if (redirectMode === "error") {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError("fetch failed");
      }
      if (redirectCount >= 20) {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError("fetch failed: redirect count exceeded");
      }
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError("fetch failed: invalid redirect URL");
      }
      if (!isHttpUrl(nextUrl.toString())) {
        await response.body?.cancel().catch(() => undefined);
        throw new TypeError("fetch failed: redirect target must be HTTP(S)");
      }
      await response.body?.cancel().catch(() => undefined);
      if (
        (response.status === 303 && currentMethod !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        delete baseHeaders["content-type"];
        delete baseHeaders["content-length"];
      }
      if (nextUrl.origin !== currentUrl.origin) {
        forwardManualCredentials = false;
      }
      currentUrl = nextUrl;
      redirectCount += 1;
    }
  }

  private responseHeaders(headers: Headers): PlaybackDiagnosticHeaders {
    const result: PlaybackDiagnosticHeaders = {};
    headers.forEach((value, name) => {
      result[name] = value;
    });
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
      .getSetCookie;
    const cookies = getSetCookie?.call(headers);
    if (cookies?.length) result["set-cookie"] = cookies;
    return result;
  }

  private upstreamHeaders(
    session: ProxySession,
    targetUrl: string,
    range: string | undefined,
  ): Record<string, string> {
    const headers = {
      ...session.headers,
      ...(session.requestPolicy.portalCredentials === true
        ? session.portalHeaders ?? {}
        : {}),
    };
    // A manifest may point at a different CDN. Do not forward credentials
    // supplied for the original provider to that host.
    if (
      (session.kind === "hls" || session.kind === "dash") &&
      new URL(targetUrl).origin !== session.sourceOrigin &&
      session.requestPolicy.portalCredentials !== true
    ) {
      delete headers.authorization;
      delete headers.cookie;
      delete headers.sn;
      delete headers["x-user-agent"];
    }
    return {
      ...headers,
      "accept-encoding": "identity",
      "cache-control": "no-cache",
      pragma: "no-cache",
      ...(range ? { range } : {}),
    };
  }

  private async handleDashResourceRequest(
    request: IncomingMessage,
    response: ServerResponse,
    session: ProxySession,
    resource: ProxyResource,
    controller: AbortController,
    requestDiagnostics: ProxyRequestDiagnostics,
  ): Promise<void> {
    let body: Buffer | undefined;
    if (request.method === "POST") {
      const incoming = await readIncomingBodyBounded(
        request,
        MAX_DASH_LICENSE_REQUEST_BYTES,
      );
      if (incoming === null) {
        response.writeHead(413).end();
        return;
      }
      body = incoming;
    }

    const headers = resource.isLicense
      ? {
        ...(resource.licenseHeaders ?? {}),
        ...(request.headers.accept ? { accept: request.headers.accept } : {}),
        ...(request.headers["content-type"]
          ? { "content-type": request.headers["content-type"] }
          : {}),
      }
      : this.upstreamHeaders(
        session,
        resource.url,
        typeof request.headers.range === "string"
          ? request.headers.range
          : undefined,
      );
    const upstream = await this.fetchUpstream(
      requestDiagnostics,
      "initial",
      resource.url,
      {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body: body as unknown as BodyInit }),
        redirect: "follow",
        signal: controller.signal,
      },
      !resource.isLicense,
      resource.isLicense ? new URL(resource.url).origin : undefined,
    );

    copyResponseHeaders(upstream, response, true);
    response.setHeader(DASH_REQUEST_ID_HEADER, requestDiagnostics.requestId);
    response.setHeader(
      DASH_RESOURCE_KIND_HEADER,
      resource.resourceKind ?? "unknown",
    );
    if (!resource.isLicense && isHttpUrl(upstream.url)) {
      response.setHeader(DASH_UPSTREAM_URI_HEADER, upstream.url);
    }
    response.writeHead(upstream.status);

    if (request.method === "HEAD" || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      response.end();
      return;
    }

    const stream = Readable.fromWeb(upstream.body as never);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        stream.off("error", fail);
        response.off("error", fail);
        response.off("close", close);
        response.off("finish", finish);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const close = () => {
        if (response.writableFinished) finish();
        else fail(new Error("DASH client closed the response."));
      };
      stream.once("error", fail);
      response.once("error", fail);
      response.once("close", close);
      response.once("finish", finish);
      if (response.destroyed) {
        close();
        return;
      }
      if (response.writableFinished) {
        finish();
        return;
      }
      stream.pipe(response);
    });
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
    requestDiagnostics: ProxyRequestDiagnostics,
    warmedResponse?: Response,
  ): Promise<void> {
    const upstream = warmedResponse ?? await this.fetchUpstream(
      requestDiagnostics,
      "initial",
      resource.url,
      {
        method: request.method,
        headers: this.upstreamHeaders(session, resource.url, request.headers.range),
        redirect: "follow",
        signal: controller.signal,
      },
    );
    if (request.method === "HEAD" || !upstream.body) {
      copyResponseHeaders(upstream, response);
      response.writeHead(upstream.status);
      response.end();
      return;
    }

    if (session.isLive && upstream.ok && this.mpegTsRemuxerPath) {
      try {
        const relayResult = await relayMpegTsWithFfmpeg({
          ffmpegPath: this.mpegTsRemuxerPath,
          firstUpstream: upstream,
          reopenUpstream: (signal) =>
            this.fetchUpstream(
              requestDiagnostics,
              "stream-reopen",
              resource.url,
              {
                method: request.method,
                headers: this.upstreamHeaders(
                  session,
                  resource.url,
                  request.headers.range,
                ),
                redirect: "follow",
                signal,
              },
            ),
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

    copyResponseHeaders(upstream, response);
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

  private serveProgressiveVodCache(
    session: ProxySession,
    resource: ProxyResource,
    requestedRange: ByteRangeRequest,
    response: ServerResponse,
  ): boolean {
    const cache = resource.progressiveVodCache;
    const responseEnd =
      cache && requestedRange.end !== null
        ? Math.min(requestedRange.end, cache.total - 1)
        : cache?.end;
    if (
      !cache ||
      responseEnd === undefined ||
      requestedRange.start < cache.start ||
      requestedRange.start > cache.end ||
      responseEnd > cache.end
    ) {
      return false;
    }

    const offset = requestedRange.start - cache.start;
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

  private async waitForProgressiveVodPrefetch(
    resource: ProxyResource,
    requestedRange: ByteRangeRequest,
  ): Promise<void> {
    const prefetchRange = resource.progressiveVodPrefetchRange;
    if (!prefetchRange || !resource.progressiveVodPrefetch) {
      return;
    }
    const requestedEnd =
      requestedRange.end ??
      (resource.progressiveVodTotal ?? Number.MAX_SAFE_INTEGER) - 1;
    if (
      requestedRange.start < prefetchRange.start ||
      requestedEnd > prefetchRange.end
    ) {
      return;
    }
    await resource.progressiveVodPrefetch.catch(() => undefined);
  }

  private storeProgressiveVodCache(
    session: ProxySession,
    resource: ProxyResource,
    range: ByteRange & { total: number },
    contentType: string | null,
    body: Buffer,
    prefetchNext = true,
    preserveExistingWindow = false,
    requestDiagnostics?: ProxyRequestDiagnostics,
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
    resource.progressiveVodPrefetchRange = { start: nextStart, end: nextEnd };
    // Prefetch is concurrent with the client response. Its phase/error state
    // must not mutate the diagnostics context belonging to that response.
    const context: ProxyRequestDiagnostics = {
      requestId: opaqueId(16),
      sessionId:
        requestDiagnostics?.sessionId ??
        [...this.sessions.entries()].find(
          ([, candidate]) => candidate === session,
        )?.[0] ??
        "",
      resourceId:
        requestDiagnostics?.resourceId ??
        session.resourceIds.get(resource.url) ??
        "",
      sourceUrl: session.sourceUrl,
      resourceKind: "progressive-vod",
      phase: "prefetch",
      upstreamErrorRecorded: false,
    };
    const prefetch = this.fetchUpstream(context, "prefetch", resource.url, {
      method: "GET",
      headers: this.upstreamHeaders(
        session,
        resource.url,
        `bytes=${nextStart}-${nextEnd}`,
      ),
      redirect: "follow",
      signal: controller.signal,
    })
      .then(async (response) => {
        const upstream = this.recoverProgressiveUpstream(response, context, session, resource, controller.signal);
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
        resource.progressiveVodPrefetchRange = undefined;
      });
    resource.progressiveVodPrefetch = prefetch;
  }

  // Keep issued URLs valid until the session is released, including across
  // playlist refreshes while the player may still request older segments.
  private addResource(session: ProxySession, url: string): string {
    const existingId = session.resourceIds.get(url);
    const existing = existingId && session.resources.get(existingId);
    if (existingId && existing) {
      session.resources.delete(existingId);
      session.resources.set(existingId, existing);
      return existingId;
    }
    const id = opaqueId(16);
    session.resources.set(id, {
      url,
      isManifest: isHlsManifest(null, url),
    });
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

export const hlsPlaybackProxy = new HlsPlaybackProxyService({
  diagnostics: playbackDiagnostics,
});
