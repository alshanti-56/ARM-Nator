import type { PlaybackFailureCategory } from './playback-attempt-manager';

export interface PlaybackPreferenceScope {
    readonly sourceIdentity: string;
    readonly live: boolean;
    readonly media: string;
    readonly runtime: string;
}

/** The synchronous subset implemented by browser localStorage and simple test stores. */
export interface PlaybackPreferenceStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface PlaybackEnginePreferencesOptions {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly keyPrefix?: string;
}

interface StoredPreference {
    readonly engine: string;
    readonly runtime: string;
    readonly savedAt: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

/** Persists verified engine choices without writing provider URLs or credentials to keys. */
export class PlaybackEnginePreferences<E extends string = string> {
    private readonly now: () => number;
    private readonly ttlMs: number;
    private readonly keyPrefix: string;

    constructor(private readonly storage: PlaybackPreferenceStorage, options: PlaybackEnginePreferencesOptions = {}) {
        this.now = options.now ?? Date.now;
        this.ttlMs = options.ttlMs ?? SEVEN_DAYS_MS;
        this.keyPrefix = options.keyPrefix ?? 'playback-engine-preference:v1:';
    }

    /** Returns an unexpired engine only when it is compatible with the current runtime. */
    getCompatible(scope: PlaybackPreferenceScope, isCompatible: (engine: E) => boolean = () => true): E | null {
        const key = this.activateRuntime(scope);
        const serialized = this.storage.getItem(key);
        if (serialized === null) return null;

        let saved: StoredPreference;
        try {
            const parsed: unknown = JSON.parse(serialized);
            if (!isStoredPreference(parsed)) {
                this.storage.removeItem(key);
                return null;
            }
            saved = parsed;
        } catch {
            this.storage.removeItem(key);
            return null;
        }

        const ageMs = this.now() - saved.savedAt;
        if (saved.runtime !== scope.runtime || ageMs < 0 || ageMs >= this.ttlMs) {
            this.storage.removeItem(key);
            return null;
        }
        const engine = saved.engine as E;
        if (!isCompatible(engine)) {
            this.storage.removeItem(key);
            return null;
        }
        return engine;
    }

    /** Writes a preference only after the caller has observed verified playback progress. */
    rememberVerifiedSuccess(scope: PlaybackPreferenceScope, engine: E, verifiedProgress: boolean): boolean {
        if (!verifiedProgress) return false;
        const key = this.activateRuntime(scope);
        const saved: StoredPreference = { engine, runtime: scope.runtime, savedAt: this.now() };
        this.storage.setItem(key, JSON.stringify(saved));
        this.storage.setItem(this.runtimeIndexKey(scope), key);
        return true;
    }

    /** Decoder failures invalidate a preference; transport and other failures preserve it. */
    invalidateOnFailure(scope: PlaybackPreferenceScope, category: PlaybackFailureCategory): void {
        if (category !== 'decoder') return;
        const key = this.preferenceKey(scope);
        this.storage.removeItem(key);
        this.storage.removeItem(this.runtimeIndexKey(scope));
    }

    private activateRuntime(scope: PlaybackPreferenceScope): string {
        const key = this.preferenceKey(scope);
        const indexKey = this.runtimeIndexKey(scope);
        const previousKey = this.storage.getItem(indexKey);
        if (previousKey && previousKey !== key) this.storage.removeItem(previousKey);
        this.storage.setItem(indexKey, key);
        return key;
    }

    private preferenceKey(scope: PlaybackPreferenceScope): string {
        return `${this.keyPrefix}entry:${JSON.stringify([
            hashIdentity(scope.sourceIdentity), scope.live, scope.media, scope.runtime,
        ])}`;
    }

    private runtimeIndexKey(scope: PlaybackPreferenceScope): string {
        return `${this.keyPrefix}runtime:${JSON.stringify([
            hashIdentity(scope.sourceIdentity), scope.live, scope.media,
        ])}`;
    }
}

function isStoredPreference(value: unknown): value is StoredPreference {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record['engine'] === 'string' && typeof record['runtime'] === 'string' &&
        typeof record['savedAt'] === 'number' && Number.isFinite(record['savedAt']);
}

/** FNV-1a 64-bit gives a stable opaque source key without retaining the input string. */
function hashIdentity(identity: string): string {
    let hash = 0xcbf29ce484222325n;
    for (let index = 0; index < identity.length; index += 1) {
        hash ^= BigInt(identity.charCodeAt(index));
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, '0');
}
