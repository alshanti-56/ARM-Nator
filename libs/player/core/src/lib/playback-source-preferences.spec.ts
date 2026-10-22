import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { AutoPlaybackFormat, ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { automaticPlaybackSourceCandidates, nextAutomaticSource } from './automatic-playback-sources';
import { PlaybackSourcePreferences, type PlaybackSourcePreferenceScope } from './playback-source-preferences';
import type { PlaybackPreferenceStorage } from './playback-engine-preferences';

class MemoryStorage implements PlaybackPreferenceStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null { return this.values.get(key) ?? null; }
    setItem(key: string, value: string): void { this.values.set(key, value); }
    removeItem(key: string): void { this.values.delete(key); }
}

const scope = (sourceIdentity = 'xtream:account-1', live = true, runtime = 'browser'): PlaybackSourcePreferenceScope => ({
    sourceIdentity,
    live,
    runtime,
});

const playback = (streamUrl: string, recovery?: ResolvedPortalPlayback['recovery']): ResolvedPortalPlayback => ({
    streamUrl,
    title: 'Current channel',
    isLive: true,
    recovery,
});

test('stores a route only after verified playback progress', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const current = playback('https://cdn-a.example/live/channel/index.m3u8?token=secret');

    assert.equal(preferences.rememberVerifiedSuccess(scope(), current, false), false);
    assert.equal(preferences.getCompatible(scope(), current), null);
    assert.equal(preferences.rememberVerifiedSuccess(scope(), current, true), true);
    assert.equal(preferences.getCompatible(scope(), current), current.streamUrl);
});

test('isolates saved routes by provider account and live versus recorded scope', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const current = playback('https://cdn-a.example/live/channel/index.m3u8');
    preferences.rememberVerifiedSuccess(scope('xtream:account-1', true), current, true);

    assert.equal(preferences.getCompatible(scope('stalker:account-1', true), current), null);
    assert.equal(preferences.getCompatible(scope('xtream:account-2', true), current), null);
    assert.equal(preferences.getCompatible(scope('xtream:account-1', false), current), null);
});

test('does not persist or read a route when provider account identity is empty', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const current = playback('https://cdn-a.example/live/channel/index.m3u8');
    const anonymousScope = scope('');

    assert.equal(preferences.rememberVerifiedSuccess(anonymousScope, current, true), false);
    assert.equal(preferences.getCompatible(anonymousScope, current), null);
    assert.equal(storage.values.size, 0);
});

test('loads a remembered route from storage after the preference object is recreated', () => {
    const storage = new MemoryStorage();
    const current = playback('https://cdn-a.example/live/channel/index.m3u8');
    new PlaybackSourcePreferences(storage).rememberVerifiedSuccess(scope(), current, true);

    const restarted = new PlaybackSourcePreferences(storage);
    assert.equal(restarted.getCompatible(scope(), current), current.streamUrl);
});

test('expires saved routes after seven days and removes the previous runtime route', () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const preferences = new PlaybackSourcePreferences(storage, { now: () => now });
    const current = playback('https://cdn-a.example/live/channel/index.m3u8');
    preferences.rememberVerifiedSuccess(scope(), current, true);

    assert.equal(preferences.getCompatible(scope('xtream:account-1', true, 'native'), current), null);
    assert.equal(preferences.getCompatible(scope(), current), null);
    preferences.rememberVerifiedSuccess(scope(), current, true);
    now += 7 * 24 * 60 * 60 * 1_000;
    assert.equal(preferences.getCompatible(scope(), current), null);
});

test('matches only a currently supported host and format, using the current channel URL', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const previous = playback('https://cdn-a.example/live/old/index.m3u8?token=old-secret');
    preferences.rememberVerifiedSuccess(scope(), previous, true, 'hls');

    const next = playback('https://origin.example/live/new/index.m3u8?token=current-secret', {
        alternateHostUrl: 'https://cdn-a.example/live/new/index.m3u8?token=current-secret',
        formatUrls: { hls: 'https://origin.example/live/new/index.m3u8?token=current-secret' },
    });
    assert.equal(preferences.getCompatible(scope(), next), 'https://cdn-a.example/live/new/index.m3u8?token=current-secret');

    const wrongFormat = playback('https://origin.example/live/new/index.ts', {
        formatUrls: { mpegts: 'https://cdn-a.example/live/new/index.ts' },
    });
    assert.equal(preferences.getCompatible(scope(), wrongFormat), null);
});

test('drops a route when current provider metadata no longer supplies it', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    preferences.rememberVerifiedSuccess(scope(), playback('https://cdn-a.example/live/old/index.m3u8'), true);

    const current = playback('https://origin.example/live/new/index.m3u8');
    assert.equal(preferences.getCompatible(scope(), current), null);
    assert.equal(storage.values.size, 0);
});

test('stores only opaque host fingerprints and never stores source paths or credentials', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const secretIdentity = 'xtream:https://user:password@portal.example?account=private';
    const current = playback('https://user:route-password@cdn-a.example/live/private/channel.m3u8?token=route-secret');

    assert.equal(preferences.rememberVerifiedSuccess(scope(secretIdentity), current, true), false);
    const valid = playback('https://cdn-a.example/live/private/channel.m3u8?token=route-secret');
    preferences.rememberVerifiedSuccess(scope(secretIdentity), valid, true);
    const serialized = [...storage.values.entries()].flat().join('\n');
    for (const secret of ['portal.example', 'user', 'password', 'account=private', 'cdn-a.example', '/live/private/channel.m3u8', 'route-secret']) {
        assert.equal(serialized.includes(secret), false, `storage must not contain ${secret}`);
    }
});

test('remembers the original provider host for prepared proxy playback', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const prepared = playback('http://127.0.0.1/session/private/index.m3u8', {
        formatUrls: { hls: 'https://cdn-a.example/live/channel/index.m3u8?token=source-secret' },
    });
    const withPreparation: ResolvedPortalPlayback = {
        ...prepared,
        originalStreamUrl: 'https://cdn-a.example/live/channel/index.m3u8?token=source-secret',
        preparedProxy: {
            id: 'proxy-session-secret',
            url: 'http://127.0.0.1/session/private/index.m3u8',
            format: 'hls',
        },
    };

    assert.equal(preferences.rememberVerifiedSuccess(scope(), withPreparation, true), true);
    const serialized = [...storage.values.entries()].flat().join('\n');
    for (const secret of ['127.0.0.1', 'session/private', 'proxy-session-secret', 'cdn-a.example', 'source-secret']) {
        assert.equal(serialized.includes(secret), false, `storage must not contain ${secret}`);
    }
    assert.equal(preferences.getCompatible(scope(), playback('https://cdn-a.example/live/next/index.m3u8?token=next-secret')), 'https://cdn-a.example/live/next/index.m3u8?token=next-secret');
});

test('does not invalidate a remembered route for HTTP 429, but clears its failing route for rejection errors', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const current = playback('https://cdn-a.example/live/channel/index.m3u8');
    preferences.rememberVerifiedSuccess(scope(), current, true);

    preferences.invalidateOnFailure(scope(), current, { status: 429 });
    assert.equal(preferences.getCompatible(scope(), current), current.streamUrl);
    preferences.invalidateOnFailure(scope(), current, { status: 404 });
    assert.equal(preferences.getCompatible(scope(), current), null);
});

test('invalidates the matching remembered route after startup, stall, timeout, network, and server failures', () => {
    const failures = [
        { code: 'startup-timeout' },
        { code: 'playback-stalled' },
        { code: 'playback-timeout' },
        { code: 'network-error' },
        { code: 'playback-start-failed' },
        { status: 408 },
        { status: 503 },
    ] as const;

    for (const failure of failures) {
        const storage = new MemoryStorage();
        const preferences = new PlaybackSourcePreferences(storage);
        const current = playback('https://cdn-a.example/live/channel/index.m3u8');
        preferences.rememberVerifiedSuccess(scope(), current, true);

        preferences.invalidateOnFailure(scope(), current, failure);

        assert.equal(preferences.getCompatible(scope(), current), null, `expected ${JSON.stringify(failure)} to invalidate the route`);
    }
});

test('does not invalidate remembered routes for HTTP 429 or decoder, autoplay, and DRM failures', () => {
    const failures = [
        { status: 429, code: 'network-error' },
        { code: 'unsupported-container' },
        { code: 'unsupported-codec' },
        { code: 'decoder-error' },
        { code: 'autoplay-blocked' },
        { code: 'drm-error' },
    ] as const;

    for (const failure of failures) {
        const storage = new MemoryStorage();
        const preferences = new PlaybackSourcePreferences(storage);
        const current = playback('https://cdn-a.example/live/channel/index.m3u8');
        preferences.rememberVerifiedSuccess(scope(), current, true);

        preferences.invalidateOnFailure(scope(), current, failure);

        assert.equal(preferences.getCompatible(scope(), current), current.streamUrl, `expected ${JSON.stringify(failure)} to preserve the route`);
    }
});

test('does not invalidate a remembered route when a different host and format failed', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const remembered = playback('https://cdn-a.example/live/old/index.m3u8');
    preferences.rememberVerifiedSuccess(scope(), remembered, true, 'hls');
    const current = playback('https://origin.example/live/new/index.ts', {
        alternateHostUrl: 'https://cdn-a.example/live/new/index.m3u8',
        formatUrls: {
            hls: 'https://origin.example/live/new/index.m3u8',
            mpegts: 'https://origin.example/live/new/index.ts',
        },
    });

    preferences.invalidateOnFailure(scope(), current, { code: 'playback-stalled' });

    assert.equal(preferences.getCompatible(scope(), current), 'https://cdn-a.example/live/new/index.m3u8');
});

test('keeps automatic source fallback ordering and includes only provider supported candidates', () => {
    const current = playback('https://origin.example/live/channel/index.m3u8', {
        alternateHostUrl: 'https://cdn.example/live/channel/index.m3u8',
        formatUrls: { hls: 'https://origin.example/live/channel/index.m3u8', mpegts: 'https://origin.example/live/channel/index.ts' },
    });
    const candidates = automaticPlaybackSourceCandidates(current);
    assert.deepEqual(candidates.map(candidate => [candidate.url, candidate.format]), [
        ['https://cdn.example/live/channel/index.m3u8', 'hls'],
        ['https://origin.example/live/channel/index.m3u8', 'hls'],
        ['https://origin.example/live/channel/index.ts', 'mpegts'],
        ['https://cdn.example/live/channel/index.ts', 'mpegts'],
    ]);
    assert.equal(nextAutomaticSource(current, current.streamUrl, { status: 401 }, new Set(), new Set()), 'https://cdn.example/live/channel/index.m3u8');
});

test('derives a current-host HLS sibling when playback already uses the alternate TS route', () => {
    const current = playback('https://cdn-b.example/live/channel/index.ts?token=preferred', {
        alternateHostUrl: 'https://cdn-a.example/live/channel/index.m3u8?token=origin',
        formatUrls: {
            hls: 'https://origin.example/live/channel/index.m3u8?token=origin',
            mpegts: 'https://origin.example/live/channel/index.ts?token=origin',
        },
    });

    assert.equal(
        nextAutomaticSource(current, current.streamUrl, { status: 404 }, new Set(), new Set()),
        'https://cdn-b.example/live/channel/index.m3u8?token=preferred',
    );
});

test('keeps extensionless source formats unknown unless current metadata identifies them', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const unknown = playback('https://cdn-a.example/live/channel');
    preferences.rememberVerifiedSuccess(scope(), unknown, true);
    assert.equal(preferences.getCompatible(scope(), playback('https://cdn-a.example/live/next-channel')), 'https://cdn-a.example/live/next-channel');

    const explicit: AutoPlaybackFormat = 'hls';
    preferences.rememberVerifiedSuccess(scope(), unknown, true, explicit);
    assert.equal(preferences.getCompatible(scope(), playback('https://cdn-a.example/live/next-channel')), null);
});

test('an HTML response clears a matching remembered route but does not affect another route', () => {
    const storage = new MemoryStorage();
    const preferences = new PlaybackSourcePreferences(storage);
    const current = playback('https://cdn-a.example/live/1.m3u8');
    preferences.rememberVerifiedSuccess(scope(), current, true);
    preferences.invalidateOnFailure(scope(), playback('https://cdn-b.example/live/1.m3u8', { alternateHostUrl: current.streamUrl }), { code: 'html-response', status: 200 });
    assert.equal(preferences.getCompatible(scope(), current), current.streamUrl);
    preferences.invalidateOnFailure(scope(), current, { code: 'html-response', status: 200 });
    assert.equal(preferences.getCompatible(scope(), current), null);
});
