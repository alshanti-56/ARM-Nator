import type { AutoPlaybackFormat, ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import type { PlaybackPreferenceStorage } from './playback-engine-preferences';
import {
    automaticPlaybackSourceCandidates,
    inferAutomaticPlaybackFormat,
    isSourceRouteFailure,
    type SourceFailure,
} from './automatic-playback-sources';

export interface PlaybackSourcePreferenceScope {
    readonly sourceIdentity: string;
    readonly live: boolean;
    readonly runtime: string;
}

export interface PlaybackSourcePreferencesOptions {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly keyPrefix?: string;
}

interface StoredSourcePreference {
    readonly hostFingerprint: string;
    readonly format: AutoPlaybackFormat;
    readonly runtime: string;
    readonly savedAt: number;
}

interface SourceCandidate {
    readonly url: string;
    readonly format: AutoPlaybackFormat;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FORMATS: readonly AutoPlaybackFormat[] = ['hls', 'mpegts', 'progressive', 'dash', 'unknown'];
/** Persists only an opaque host fingerprint and format, then resolves it against current provider metadata. */
export class PlaybackSourcePreferences {
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly keyPrefix: string;

    constructor(private readonly storage: PlaybackPreferenceStorage, options: PlaybackSourcePreferencesOptions = {}) {
        this.now = options.now ?? Date.now;
        this.ttlMs = options.ttlMs ?? SEVEN_DAYS_MS;
        this.keyPrefix = options.keyPrefix ?? 'playback-source-preference:v1:';
    }

    /** Returns a current provider-supported URL with the remembered host and format. */
    getCompatible(scope: PlaybackSourcePreferenceScope, playback: ResolvedPortalPlayback): string | null {
        const key = this.activateRuntime(scope);
        if (!key) return null;
        const preference = this.readPreference(scope, key);
        if (!preference) return null;

        const candidate = playbackCandidates(playback).find(route =>
            route.format === preference.format && hostFingerprint(route.url) === preference.hostFingerprint,
        );
        if (!candidate) {
            this.removePreference(scope, key);
            return null;
        }
        return candidate.url;
    }

    /** Writes a preference only after the caller has observed verified playback progress. */
    rememberVerifiedSuccess(
        scope: PlaybackSourcePreferenceScope,
        playback: ResolvedPortalPlayback,
        verifiedProgress: boolean,
        format?: AutoPlaybackFormat,
    ): boolean {
        if (!verifiedProgress || !hasIdentity(scope)) return false;

        const candidate = activePlaybackCandidate(playback);
        if (!candidate || (format !== undefined && candidate.format !== 'unknown' && format !== candidate.format)) return false;
        const key = this.activateRuntime(scope);
        if (!key) return false;

        const saved: StoredSourcePreference = {
            hostFingerprint: hostFingerprint(candidate.url),
            format: format ?? candidate.format,
            runtime: scope.runtime,
            savedAt: this.now(),
        };
        this.storage.setItem(key, JSON.stringify(saved));
        this.storage.setItem(this.runtimeIndexKey(scope), key);
        return true;
    }

    /** Clears a remembered route only when that same route fails; HTTP 429 is preserved. */
    invalidateOnFailure(
        scope: PlaybackSourcePreferenceScope,
        playback: ResolvedPortalPlayback,
        failure: SourceFailure,
    ): void {
        if (!hasIdentity(scope) || !isSourceRouteFailure(failure)) return;

        const key = this.preferenceKey(scope);
        const preference = this.readPreference(scope, key);
        if (!preference) return;

        const supported = playbackCandidates(playback).some(route =>
            route.format === preference.format && hostFingerprint(route.url) === preference.hostFingerprint,
        );
        if (!supported) {
            this.removePreference(scope, key);
            return;
        }

        const failedRoute = activePlaybackCandidate(playback);
        if (failedRoute && failedRoute.format === preference.format &&
            hostFingerprint(failedRoute.url) === preference.hostFingerprint) {
            this.removePreference(scope, key);
        }
    }

    private readPreference(scope: PlaybackSourcePreferenceScope, key: string): StoredSourcePreference | null {
        const serialized = this.storage.getItem(key);
        if (serialized === null) return null;

        let parsed: unknown;
        try {
            parsed = JSON.parse(serialized);
        } catch {
            this.removePreference(scope, key);
            return null;
        }
        if (!isStoredSourcePreference(parsed)) {
            this.removePreference(scope, key);
            return null;
        }

        const ageMs = this.now() - parsed.savedAt;
        if (parsed.runtime !== scope.runtime || ageMs < 0 || ageMs >= this.ttlMs) {
            this.removePreference(scope, key);
            return null;
        }
        return parsed;
    }

    private activateRuntime(scope: PlaybackSourcePreferenceScope): string | null {
        if (!hasIdentity(scope)) return null;
        const key = this.preferenceKey(scope);
        const indexKey = this.runtimeIndexKey(scope);
        const previousKey = this.storage.getItem(indexKey);
        if (previousKey && previousKey !== key) this.storage.removeItem(previousKey);
        this.storage.setItem(indexKey, key);
        return key;
    }

    private removePreference(scope: PlaybackSourcePreferenceScope, key: string): void {
        this.storage.removeItem(key);
        const indexKey = this.runtimeIndexKey(scope);
        if (this.storage.getItem(indexKey) === key) this.storage.removeItem(indexKey);
    }

    private preferenceKey(scope: PlaybackSourcePreferenceScope): string {
        return `${this.keyPrefix}entry:${JSON.stringify([
            hashIdentity(scope.sourceIdentity), scope.live, scope.runtime,
        ])}`;
    }

    private runtimeIndexKey(scope: PlaybackSourcePreferenceScope): string {
        return `${this.keyPrefix}runtime:${JSON.stringify([hashIdentity(scope.sourceIdentity), scope.live])}`;
    }
}


function playbackCandidates(playback: ResolvedPortalPlayback): SourceCandidate[] {
    const candidates: SourceCandidate[] = [];
    const current = activePlaybackCandidate(playback);
    if (current) candidates.push(current);

    for (const route of automaticPlaybackSourceCandidates(playback)) {
        const url = safeMediaUrl(route.url);
        if (url) candidates.push({ url: url.href, format: route.format });
    }
    return candidates;
}

function activePlaybackCandidate(playback: ResolvedPortalPlayback): SourceCandidate | null {
    // Prepared proxies are session scoped. Remember their original provider URL and
    // the response format already established during preparation, never the proxy URL.
    const sourceUrl = playback.preparedProxy ? playback.originalStreamUrl : playback.streamUrl;
    if (!sourceUrl) return null;
    const url = safeMediaUrl(sourceUrl);
    if (!url) return null;

    if (playback.preparedProxy && playback.originalStreamUrl) {
        return { url: url.href, format: playback.preparedProxy.format };
    }

    const exactMetadataRoute = automaticPlaybackSourceCandidates(playback).find(route => {
        const metadataUrl = safeMediaUrl(route.url);
        return metadataUrl?.href === url.href;
    });
    return {
        url: url.href,
        format: exactMetadataRoute?.format ?? inferAutomaticPlaybackFormat(url.href),
    };
}

function safeMediaUrl(value: string | undefined): URL | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        url.hash = '';
        return url;
    } catch {
        return null;
    }
}

function isStoredSourcePreference(value: unknown): value is StoredSourcePreference {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record['hostFingerprint'] === 'string' && record['hostFingerprint'].length > 0 &&
        typeof record['format'] === 'string' && FORMATS.includes(record['format'] as AutoPlaybackFormat) &&
        typeof record['runtime'] === 'string' && typeof record['savedAt'] === 'number' && Number.isFinite(record['savedAt']);
}

function hasIdentity(scope: PlaybackSourcePreferenceScope): boolean {
    return scope.sourceIdentity.trim().length > 0;
}

/** FNV-1a 64-bit keeps host and provider/account identity opaque in storage. */
function hostFingerprint(urlValue: string): string {
    const url = new URL(urlValue);
    return hashIdentity(url.origin);
}

function hashIdentity(identity: string): string {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < identity.length; index += 1) {
        hash ^= BigInt(identity.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}
