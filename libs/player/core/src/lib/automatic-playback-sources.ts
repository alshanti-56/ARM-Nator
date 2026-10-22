import type { AutoPlaybackFormat, ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';

export interface SourceFailure {
    readonly code?: string;
    readonly status?: number | null;
    readonly networkCode?: string;
}

export function isDnsFailure(failure: SourceFailure): boolean {
    return failure.status == null && ['ENOTFOUND', 'EAI_NONAME', 'EAI_AGAIN'].includes(failure.networkCode ?? '');
}

export function isSourceRejection(failure: SourceFailure): boolean {
    const status = failure.status;
    return status == null ? failure.code === 'provider-rejected' :
        status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function mediaUrl(value: string | undefined): URL | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
        url.hash = '';
        return url;
    } catch { return undefined; }
}

export interface AutomaticPlaybackSourceCandidate {
    readonly url: string;
    readonly format: AutoPlaybackFormat;
}

/** Provider supplied routes and only those cross-host siblings proved by matching format metadata. */
export function automaticPlaybackSourceCandidates(playback: ResolvedPortalPlayback): AutomaticPlaybackSourceCandidate[] {
    const alternate = mediaUrl(playback.recovery?.alternateHostUrl);
    const currentValue = playback.preparedProxy ? playback.originalStreamUrl : playback.streamUrl;
    const current = mediaUrl(currentValue);
    const hls = mediaUrl(playback.recovery?.formatUrls?.hls);
    const mpegts = mediaUrl(playback.recovery?.formatUrls?.mpegts);
    const formats = [hls, mpegts].filter((url): url is URL => !!url);
    const candidates: AutomaticPlaybackSourceCandidate[] = [];

    if (alternate) candidates.push({ url: alternate.href, format: formatFromUrl(alternate) });
    if (hls) candidates.push({ url: hls.href, format: 'hls' });
    if (mpegts) candidates.push({ url: mpegts.href, format: 'mpegts' });

    // A host change must survive a subsequent format change. Derive siblings at
    // both the current provider host and the provider's alternate host, and only
    // when metadata proves both formats identify the same stream at one origin.
    for (const anchorUrl of [alternate, current]) {
        if (!anchorUrl) continue;
        const anchor = formats.find(url => url.pathname.split('/').at(-1) === anchorUrl.pathname.split('/').at(-1));
        if (!anchor || !/\.(m3u8|ts)$/.test(anchor.pathname)) continue;
        for (const format of formats) {
            if (format.origin !== anchor.origin || format.search !== anchor.search ||
                !/\.(m3u8|ts)$/.test(format.pathname) ||
                format.pathname.replace(/\.(m3u8|ts)$/, '') !== anchor.pathname.replace(/\.(m3u8|ts)$/, '')) continue;
            const sibling = new URL(anchorUrl.href);
            sibling.pathname = sibling.pathname.replace(/\.(m3u8|ts)$/, format.pathname.endsWith('.ts') ? '.ts' : '.m3u8');
            candidates.push({ url: sibling.href, format: format.pathname.endsWith('.ts') ? 'mpegts' : 'hls' });
        }
    }

    const seen = new Set<string>();
    return candidates.filter(candidate => {
        const key = `${candidate.url}\u0000${candidate.format}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatFromUrl(url: URL): AutoPlaybackFormat {
    const path = url.pathname.toLowerCase();
    if (/\.m3u8$/.test(path)) return 'hls';
    if (/\.ts$/.test(path)) return 'mpegts';
    if (/\.mpd$/.test(path)) return 'dash';
    if (/\.(mp4|m4v|mov|mkv|webm|avi|mp3|m4a|aac|ogg|flv)$/.test(path)) return 'progressive';
    // Extensionless and unfamiliar routes stay unknown; do not infer their format.
    return 'unknown';
}

/** Infers only from explicit, recognized file extensions; extensionless paths stay unknown. */
export function inferAutomaticPlaybackFormat(value: string): AutoPlaybackFormat {
    const url = mediaUrl(value);
    return url ? formatFromUrl(url) : 'unknown';
}

export function sourceKey(value: string): string {
    return mediaUrl(value)?.href ?? value;
}

/** Only provider-supplied URLs and matching HLS/TS siblings at its known alternate host. */
export function nextAutomaticSource(
    playback: ResolvedPortalPlayback,
    currentUrl: string,
    failure: SourceFailure,
    attempted: ReadonlySet<string>,
    failedDnsHosts: ReadonlySet<string>,
): string | undefined {
    if (playback.drm || (!isDnsFailure(failure) && !isSourceRejection(failure))) return undefined;
    const current = mediaUrl(currentUrl);
    if (!current) return undefined;
    const candidates = automaticPlaybackSourceCandidates(playback)
        .map(candidate => mediaUrl(candidate.url))
        .filter((url): url is URL => !!url);

    if (!isDnsFailure(failure) && failure.status !== 401 && failure.status !== 403) {
        candidates.sort((left, right) => Number(right.origin === current.origin) - Number(left.origin === current.origin));
    }
    return candidates.find(url => url.href !== current.href && !attempted.has(url.href) &&
        !failedDnsHosts.has(url.hostname) && (!isDnsFailure(failure) || url.hostname !== current.hostname))?.href;
}

const NON_SOURCE_FAILURE_CODES = new Set([
    'unsupported-container', 'unsupported-codec', 'media-decode-error', 'decoder-error', 'decode-error',
    'autoplay-blocked', 'autoplay-error', 'not-allowed', 'user-gesture-required',
    'license-error', 'drm-error', 'drm-or-encryption', 'encrypted', 'key-system-error',
]);
const ROUTE_FAILURE_CODES = new Set([
    'network', 'network-error', 'timeout', 'startup-timeout', 'fetch-error', 'connection-error',
    'playback-timeout', 'playback-stalled', 'playback-start-failed', 'html-response',
]);

/** A route failure can discard a remembered source and try the current configured route. */
export function isSourceRouteFailure(failure: SourceFailure): boolean {
    // A rate limit is temporary and must never poison a provider route preference.
    if (failure.status === 429) return false;
    const code = (failure.code ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    // These outcomes describe the player or the viewing policy rather than the route.
    if (NON_SOURCE_FAILURE_CODES.has(code)) return false;
    if (isDnsFailure(failure) || isSourceRejection(failure)) return true;
    if (failure.status === 408 || (failure.status !== undefined && failure.status !== null && failure.status >= 500 && failure.status <= 599)) return true;
    return ROUTE_FAILURE_CODES.has(code);
}

