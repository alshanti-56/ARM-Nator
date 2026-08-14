import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

const SESSION_IDLE_MS = 15 * 60_000;
const SESSION_SWEEP_MS = 60_000;
const MAX_RESOURCES_PER_SESSION = 4_096;
const HLS_CONTENT_TYPE = /(?:application|audio)\/(?:vnd\.apple\.|x-)?mpegurl/i;

export interface HlsProxySession {
    id: string;
    url: string;
}

export interface HlsProxySessionInput {
    url: string;
    headers?: Record<string, string>;
}

type ProxyResource = {
    url: string;
    root?: boolean;
    fallbackUrl?: string;
    lastManifest?: { sequence: number; body: string };
};
type ProxySession = {
    headers: Record<string, string>;
    resources: Map<string, ProxyResource>;
    resourceIds: Map<string, string>;
    requests: Set<AbortController>;
    lastUsedAt: number;
};

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

function opaqueId(bytes = 24): string {
    return randomBytes(bytes).toString('hex');
}

/** Retain only request headers which providers commonly require for playback. */
export function sanitizeHlsProxyHeaders(
    headers: Record<string, string> | undefined
): Record<string, string> {
    const accepted = new Set(['user-agent', 'referer', 'origin']);
    const result: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
        const normalizedName = name.toLowerCase();
        if (
            accepted.has(normalizedName) &&
            typeof value === 'string' &&
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
    responseUrl: string
): string | null {
    try {
        const url = new URL(value, responseUrl);
        return url.protocol === 'http:' || url.protocol === 'https:'
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
    makeProxyUrl: (targetUrl: string) => string
): string {
    const rewrite = (value: string): string => {
        const target = resolveHlsProxyTarget(value, responseUrl);
        return target ? makeProxyUrl(target) : value;
    };

    return manifest
        .split(/(\r?\n)/)
        .map((part) => {
            const trimmed = part.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                return part.replace(/URI=("([^"]*)"|'([^']*)'|([^,\s]*))/gi, (match, _whole, doubleQuoted, singleQuoted, bare) => {
                    const value = doubleQuoted ?? singleQuoted ?? bare;
                    const rewritten = rewrite(value);
                    if (rewritten === value) {
                        return match;
                    }
                    return `URI="${rewritten}"`;
                });
            }
            return part.replace(trimmed, rewrite(trimmed));
        })
        .join('');
}

function isHlsManifest(contentType: string | null, url: string): boolean {
    return HLS_CONTENT_TYPE.test(contentType ?? '') ||
        new URL(url).pathname.toLowerCase().endsWith('.m3u8');
}

function shouldRefreshLiveManifest(status: number): boolean {
    return status === 401 || status === 403 || status === 404 || status === 406 || status === 410 || status === 429 || status >= 500;
}

function addLiveManifestRefreshNonce(url: string): string {
    try {
        const refreshed = new URL(url);
        refreshed.searchParams.set(
            '_arm_nator_refresh',
            `${Date.now()}-${randomBytes(6).toString('hex')}`,
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
    if (!origin || origin === 'null') {
        return true;
    }
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
    } catch {
        return false;
    }
}

function copyResponseHeaders(
    upstream: Response,
    response: ServerResponse,
    rewritten: boolean
): void {
    const excluded = new Set([
        'connection', 'content-length', 'keep-alive', 'proxy-authenticate',
        'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
        'vary',
    ]);
    upstream.headers.forEach((value, name) => {
        const normalizedName = name.toLowerCase();
        if (!excluded.has(normalizedName) &&
            !normalizedName.startsWith('access-control-') &&
            (!rewritten || normalizedName !== 'content-encoding')) {
            response.setHeader(name, value);
        }
    });
}

export class HlsPlaybackProxyService {
    private readonly sessions = new Map<string, ProxySession>();
    private server: Server | null = null;
    private port: number | null = null;
    private serverStartup: Promise<void> | null = null;
    private shuttingDown = false;
    private shutdownPromise: Promise<void> | null = null;
    private readonly sweepTimer = setInterval(() => this.sweepExpiredSessions(), SESSION_SWEEP_MS);

    constructor() {
        this.sweepTimer.unref();
    }

    async createSession(input: HlsProxySessionInput): Promise<HlsProxySession> {
        if (this.shuttingDown) {
            throw new Error('The HLS proxy is shutting down.');
        }
        if (!isHttpUrl(input.url)) {
            throw new Error('An HLS proxy session requires an HTTP(S) source URL.');
        }
        await this.ensureServer();
        if (this.shuttingDown || this.port === null) {
            throw new Error('The HLS proxy is shutting down.');
        }
        const id = opaqueId();
        const rootId = opaqueId(16);
        const session: ProxySession = {
            headers: sanitizeHlsProxyHeaders(input.headers),
            resources: new Map([[
                rootId,
                { url: input.url, root: true, fallbackUrl: input.url },
            ]]),
            resourceIds: new Map([[input.url, rootId]]),
            requests: new Set(),
            lastUsedAt: Date.now(),
        };
        this.sessions.set(id, session);
        return { id, url: `http://127.0.0.1:${this.port}/hls/${id}/${rootId}` };
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
        const server = createServer((request, response) => void this.handleRequest(request, response));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                resolve();
            });
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Unable to start the local HLS proxy.');
        }
        this.server = server;
        this.port = address.port;
    }

    private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const origin = request.headers.origin;
        if (!isAllowedRendererOrigin(origin)) {
            response.writeHead(403).end();
            return;
        }
        response.setHeader('Access-Control-Allow-Origin', origin === 'null' ? 'null' : origin ?? '*');
        response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
        response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type');
        response.setHeader('Vary', 'Origin');
        if (request.method === 'OPTIONS') {
            response.writeHead(204).end();
            return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405).end();
            return;
        }

        const match = request.url?.match(/^\/hls\/([a-f0-9]{48})\/([a-f0-9]{32})$/);
        if (!match) {
            response.writeHead(404).end();
            return;
        }
        const [, sessionId, resourceId] = match;
        const session = this.sessions.get(sessionId);
        const resource = session?.resources.get(resourceId);
        if (!session || !resource) {
            response.writeHead(404).end();
            return;
        }
        session.lastUsedAt = Date.now();
        const controller = new AbortController();
        session.requests.add(controller);
        const abort = () => controller.abort();
        request.once('aborted', abort);
        response.once('close', abort);
        try {
            let upstream = await fetch(resource.url, {
                method: request.method,
                headers: this.upstreamHeaders(session.headers, request.headers.range),
                redirect: 'follow',
                signal: controller.signal,
            });
            if (shouldRefreshLiveManifest(upstream.status) && resource.fallbackUrl) {
                await upstream.body?.cancel().catch(() => undefined);
                const refreshUrls = [
                    addLiveManifestRefreshNonce(resource.fallbackUrl),
                    resource.fallbackUrl,
                ];
                for (const refreshUrl of refreshUrls) {
                    upstream = await fetch(refreshUrl, {
                        method: request.method,
                        headers: this.upstreamHeaders(session.headers, request.headers.range),
                        redirect: 'follow',
                        signal: controller.signal,
                    });
                    if (!shouldRefreshLiveManifest(upstream.status) || refreshUrl === refreshUrls.at(-1)) {
                        break;
                    }
                    await upstream.body?.cancel().catch(() => undefined);
                }
            }
            if (upstream.ok && isHttpUrl(upstream.url)) {
                // Keep live-playlist refreshes on the same redirected backend.
                // Re-resolving the Xtream URL can move between nodes whose
                // media sequences are out of order, which HLS.js treats as a
                // fatal level-parsing error.
                resource.url = upstream.url;
            }
            if (isHlsManifest(upstream.headers.get('content-type'), upstream.url || resource.url) && request.method === 'GET') {
                const manifest = await upstream.text();
                const sequence = getHlsMediaSequence(manifest);
                const previous = resource.lastManifest;
                const body =
                    sequence !== null && previous && sequence < previous.sequence
                        ? previous.body
                        : rewriteHlsManifest(
                              manifest,
                              upstream.url || resource.url,
                              (target) => {
                                  const childId = this.addResource(session, target);
                                  return `http://127.0.0.1:${this.port}/hls/${sessionId}/${childId}`;
                              }
                          );
                if (sequence !== null && (!previous || sequence >= previous.sequence)) {
                    resource.lastManifest = { sequence, body };
                }
                copyResponseHeaders(upstream, response, true);
                response.writeHead(upstream.status);
                response.end(body);
                return;
            }
            copyResponseHeaders(upstream, response, false);
            response.writeHead(upstream.status);
            if (request.method === 'HEAD' || !upstream.body) {
                response.end();
                return;
            }
            await new Promise<void>((resolve, reject) => {
                const body = Readable.fromWeb(upstream.body as never);
                body.once('error', reject);
                response.once('error', reject);
                response.once('finish', resolve);
                body.pipe(response);
            });
        } catch (error) {
            if (!response.headersSent && !controller.signal.aborted) response.writeHead(502);
            if (!response.writableEnded) response.end();
            void error;
        } finally {
            request.off('aborted', abort);
            response.off('close', abort);
            session.requests.delete(controller);
        }
    }

    private upstreamHeaders(headers: Record<string, string>, range: string | undefined): Record<string, string> {
        return {
            ...headers,
            'cache-control': 'no-cache',
            pragma: 'no-cache',
            ...(range ? { range } : {}),
        };
    }

    private addResource(session: ProxySession, url: string): string {
        const existingId = session.resourceIds.get(url);
        if (existingId && session.resources.has(existingId)) {
            return existingId;
        }
        while (session.resources.size >= MAX_RESOURCES_PER_SESSION) {
            const oldest = [...session.resources.entries()].find(
                ([, resource]) => !resource.root
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
            if (session.lastUsedAt < oldestAllowed) this.releaseSession(id);
        }
    }
}

export const hlsPlaybackProxy = new HlsPlaybackProxyService();
