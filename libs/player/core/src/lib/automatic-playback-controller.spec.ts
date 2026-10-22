import type { AutomaticPlaybackActivity } from './automatic-playback-activity';
import { PlaybackSourcePreferences } from './playback-source-preferences';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
    ResolvedPortalPlayback,
    VideoPlayer,
    type AutoPlaybackPreparationResult,
} from '@arm-nator/shared/interfaces';
import {
    AutomaticPlaybackController,
    type AutomaticPlaybackControllerDependencies,
    type AutomaticPlaybackFailure,
} from './automatic-playback-controller';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

interface LoopbackFixture {
    readonly originUrl: string;
    readonly retained: Map<string, Response>;
    readonly order: string[];
    readonly upstreamRequests: number;
    readonly preparedRequests: number;
    readonly retainedAtPrepare: number[];
    prepare(url: string): Promise<AutoPlaybackPreparationResult>;
    release(id: string): Promise<void>;
    close(): Promise<void>;
}

async function createLoopbackFixture(): Promise<LoopbackFixture> {
    let upstreamRequests = 0;
    let preparedRequests = 0;
    let nextId = 0;
    const retained = new Map<string, Response>();
    const order: string[] = [];
    const retainedAtPrepare: number[] = [];
    const server: Server = createServer((request, response) => {
        if (request.url === '/denied') {
            response.writeHead(401, { 'content-type': 'text/plain' });
            response.end('provider rejected');
            return;
        }
        if (request.url?.startsWith('/prepared/')) {
            preparedRequests += 1;
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-ENDLIST\n');
            return;
        }
        upstreamRequests += 1;
        response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        response.write('#EXTM3U\n');
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return {
        originUrl: `${baseUrl}/origin`, retained, order, retainedAtPrepare,
        get upstreamRequests() { return upstreamRequests; },
        get preparedRequests() { return preparedRequests; },
        async prepare(url) {
            order.push('prepare');
            retainedAtPrepare.push(retained.size);
            const response = await fetch(url);
            if (!response.ok) {
                await response.body?.cancel();
                return { ok: false, error: { code: 'http-error', status: response.status, message: `HTTP ${response.status}` } };
            }
            const id = `loopback-${++nextId}`;
            retained.set(id, response);
            return { ok: true, session: { id, url: `${baseUrl}/prepared/${id}`, format: 'hls' } };
        },
        async release(id) {
            order.push(`release:${id}`);
            const response = retained.get(id);
            await response?.body?.cancel();
            retained.delete(id);
        },
        async close() {
            for (const [id, response] of retained) {
                await response.body?.cancel();
                retained.delete(id);
            }
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        },
    };
}

interface HarnessOptions extends Partial<AutomaticPlaybackControllerDependencies<string>> {
    readonly support?: { readonly embeddedMpv: boolean; readonly ksPlayer: boolean };
}

function createHarness(options: HarnessOptions = {}) {
    let generation = 0;
    const teardown = new Set<() => Promise<void>>();
    const prepareOverride = options.prepare;
    const cancelOverride = options.cancel;
    const releaseOverride = options.release;
    const support = options.support;
    const failures: AutomaticPlaybackFailure<string>[] = [];
    const started: { playback: ResolvedPortalPlayback; engine: VideoPlayer; context?: string; token: number }[] = [];
    const prepared: { url: string; headers: Record<string, string>; isLive: boolean }[] = [];
    const releases: string[] = [];
    const dependencies: AutomaticPlaybackControllerDependencies<string> = {
        prepareForPlayback: async () => {
            generation += 1;
            for (const dispose of [...teardown]) {
                try { await dispose(); }
                catch { return null; }
            }
            return generation;
        },
        isPlaybackTransitionCurrent: (token) => token === generation,
        registerTeardown: (dispose) => {
            const registered = () => dispose();
            teardown.add(registered);
            return () => teardown.delete(registered);
        },
        startPlayback: async (playback, engine, context, token) => { started.push({ playback, engine, context, token }); },
        showFailure: (failure) => { failures.push(failure); },
        ...options,
        prepare: async (url, headers, isLive, attemptId) => {
            prepared.push({ url, headers, isLive });
            if (prepareOverride) return prepareOverride(url, headers, isLive, attemptId);
            return { ok: true, session: { id: `session-${prepared.length}`, url: `http://127.0.0.1/prepared/${prepared.length}`, format: 'hls' } };
        },
        cancel: async (attemptId) => { await cancelOverride?.(attemptId); },
        release: async (id) => { releases.push(id); await releaseOverride?.(id); },
        getNativeSupport: async () => support ?? { embeddedMpv: true, ksPlayer: true },
    };
    const controller = new AutomaticPlaybackController(dependencies);
    return { controller, failures, started, prepared, releases, teardown, dependencies };
}

function playback(streamUrl: string, extra: Partial<ResolvedPortalPlayback> = {}): ResolvedPortalPlayback {
    return { streamUrl, title: 'fixture', isLive: true, ...extra };
}

test('DNS failure selects a known alternate host without repeating the unresolved host', async () => {
    const primary = 'https://missing.example.test/live/1.m3u8';
    const alternate = 'https://media.example.test/live/1.m3u8';
    const harness = createHarness({
        prepare: async (url) =>
            url === primary
                ? {
                      ok: false,
                      error: {
                          code: 'network-error',
                          networkCode: 'ENOTFOUND',
                          status: null,
                          message: 'DNS failed',
                      },
                  }
                : {
                      ok: true,
                      session: { id: 'alternate', url, format: 'hls' },
                  },
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: alternate,
                formatUrls: { mpegts: primary.replace('.m3u8', '.ts') },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary, alternate],
    );
    assert.equal(harness.started.length, 1);
    assert.equal(harness.started[0].playback.originalStreamUrl, alternate);
    assert.equal(harness.failures.length, 0);
});


test('stream rejection uses a known alternate host while a missing HLS resource uses the supported TS URL', async () => {
    const primary = 'https://provider.example.test/live/1.m3u8';
    const alternate = 'https://media.example.test/live/1.m3u8';
    const ts = primary.replace('.m3u8', '.ts');
    for (const [status, expected] of [
        [401, alternate],
        [404, ts],
    ]) {
        const harness = createHarness({
            prepare: async (url) =>
                url === primary
                    ? {
                          ok: false,
                          error: {
                              code: 'http-error',
                              status,
                              message: `HTTP ${status}`,
                          },
                      }
                    : {
                          ok: true,
                          session: {
                              id: 'recovered',
                              url,
                              format: url.endsWith('.ts') ? 'mpegts' : 'hls',
                          },
                      },
        });
        await harness.controller.open(
            playback(primary, {
                originalStreamUrl: primary,
                recovery: {
                    alternateHostUrl: alternate,
                    formatUrls: { hls: primary, mpegts: ts },
                },
            }),
        );
        assert.deepEqual(
            harness.prepared.map((attempt) => attempt.url),
            [primary, expected],
        );
        assert.equal(harness.failures.length, 0);
        assert.equal(harness.started.length, 1);
    }
});


test('format recovery retains a usable alternate host and never returns to the host that failed DNS', async () => {
    const primary = 'https://missing.example.test/live/1.m3u8';
    const alternate = 'https://media.example.test/live/1.m3u8';
    const alternateTs = alternate.replace('.m3u8', '.ts');
    const harness = createHarness({
        prepare: async (url) =>
            url === primary
                ? {
                      ok: false,
                      error: {
                          code: 'network-error',
                          networkCode: 'ENOTFOUND',
                          status: null,
                          message: 'DNS failed',
                      },
                  }
                : url === alternate
                  ? {
                        ok: false,
                        error: {
                            code: 'http-error',
                            status: 404,
                            message: 'HTTP 404',
                        },
                    }
                  : {
                        ok: true,
                        session: { id: 'recovered-ts', url, format: 'mpegts' },
                    },
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: alternate,
                formatUrls: {
                    hls: primary,
                    mpegts: primary.replace('.m3u8', '.ts'),
                },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary, alternate, alternateTs],
    );
    assert.equal(harness.started.length, 1);
    assert.equal(harness.failures.length, 0);
});


test('duplicate source metadata cannot repeat rejected URLs or exceed three attempts', async () => {
    const primary = 'https://provider.example.test/live/1.m3u8';
    const ts = primary.replace('.m3u8', '.ts');
    const harness = createHarness({
        prepare: async () => ({
            ok: false,
            error: { code: 'http-error', status: 404, message: 'HTTP 404' },
        }),
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: primary,
                formatUrls: { hls: primary, mpegts: ts },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary, ts],
    );
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.started.length, 0);
});


test('a source alternative can reuse the compatible player without reusing an owned proxy response', async () => {
    const primary = 'https://provider.example.test/live/1.m3u8';
    const alternate = 'https://media.example.test/live/1.m3u8';
    const harness = createHarness();
    await harness.controller.open(
        playback(primary, { recovery: { alternateHostUrl: alternate } }),
    );
    const active = harness.controller.activePlayback;
    await harness.controller.handleDiagnostic({
        code: 'provider-rejected',
        status: 401,
        sourceUrl: active.preparedPlayback.streamUrl,
    });
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary, alternate],
    );
    assert.deepEqual(harness.releases, ['session-1']);
    assert.equal(harness.started.length, 2);
    assert.equal(harness.started[1].engine, harness.started[0].engine);
});


test('a provider retry delay beyond the live budget stops without trying another host or format', async () => {
    const primary = 'https://provider.example.test/live/1.m3u8';
    const harness = createHarness({
        prepare: async () => ({
            ok: false,
            error: {
                code: 'http-error',
                status: 429,
                retryAfterMs: 6e4,
                message: 'Slow down',
            },
        }),
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: 'https://media.example.test/live/1.m3u8',
                formatUrls: { mpegts: primary.replace('.m3u8', '.ts') },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary],
    );
    assert.equal(harness.started.length, 0);
    assert.equal(harness.failures[0].error.status, 429);
    assert.equal(harness.failures[0].error.retryAfterMs, 6e4);
});


test('Auto exhausts distinct provider alternatives within the existing three-attempt limit', async () => {
    const primary = 'https://provider.example.test/live/1.m3u8';
    const alternate = 'https://media.example.test/live/1.m3u8';
    const ts = primary.replace('.m3u8', '.ts');
    const harness = createHarness({
        prepare: async () => ({
            ok: false,
            error: { code: 'http-error', status: 404, message: 'HTTP 404' },
        }),
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: alternate,
                formatUrls: { hls: primary, mpegts: ts },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((attempt) => attempt.url),
        [primary, ts, alternate],
    );
    assert.equal(harness.failures.length, 1);
    assert.equal(harness.started.length, 0);
});


test('a terminal DNS preparation failure retains its network code for the visible error banner', async () => {
    let now = 0;
    const error = {
        code: 'network-error',
        status: null,
        networkCode: 'ENOTFOUND',
        message: 'DNS lookup could not find the stream host.',
    };
    const harness = createHarness({
        now: () => now,
        prepare: async () => {
            now = 3e4;
            return { ok: false, error };
        },
    });
    await harness.controller.open(playback('https://stream.example.test/live'));
    assert.equal(harness.failures.length, 1);
    assert.deepEqual(harness.failures[0].error, error);
    assert.equal(harness.started.length, 0);
});


test('drains the retained loopback response before a replacement request and forwards proxy metadata', async () => {
    const fixture = await createLoopbackFixture();
    const harness = createHarness({
        prepare: (url) => {
            harnessOrder.push(`probe:${fixture.retained.size}`);
            return fixture.prepare(url);
        },
        release: (id) => fixture.release(id),
        startPlayback: async (resolved, engine, context, token) => {
            assert.equal(engine, VideoPlayer.EmbeddedMpv);
            const response = await fetch(resolved.streamUrl);
            assert.match(await response.text(), /#EXTM3U/);
            harnessStart.push({ resolved, context, token });
        },
    });
    const harnessOrder = [];
    const harnessStart = [];
    harness.dependencies.onPreparing = () => harnessOrder.push('loading');
    harness.dependencies.getNativeSupport = async () => {
        harnessOrder.push('support');
        return { embeddedMpv: true, ksPlayer: true };
    };
    try {
        const source = playback(fixture.originUrl, {
            headers: {
                Authorization: 'Bearer private',
                'x-provider': 'kept',
                'user-agent': 'old-agent',
            },
            userAgent: 'player-agent',
            referer: 'https://provider.example/page',
            origin: 'https://provider.example',
        });
        await harness.controller.open(source, 'live-context');
        assert.equal(fixture.upstreamRequests, 1);
        assert.equal(fixture.preparedRequests, 1);
        assert.equal(fixture.retained.size, 1);
        const first = harness.controller.activePlayback;
        assert.ok(first);
        assert.equal(first.playback.streamUrl, fixture.originUrl);
        assert.equal(
            first.preparedPlayback.originalStreamUrl,
            fixture.originUrl,
        );
        assert.equal(
            first.preparedPlayback.streamUrl,
            `${new URL(fixture.originUrl).origin}/prepared/loopback-1`,
        );
        assert.deepEqual(harness.prepared[0].headers, {
            Authorization: 'Bearer private',
            'x-provider': 'kept',
            'User-Agent': 'player-agent',
            Referer: 'https://provider.example/page',
            Origin: 'https://provider.example',
        });
        await harness.controller.open(playback(fixture.originUrl));
        assert.equal(fixture.upstreamRequests, 2);
        assert.equal(fixture.retained.size, 1);
        assert.deepEqual(fixture.retainedAtPrepare, [0, 0]);
        assert.ok(
            harnessOrder.indexOf('loading') < harnessOrder.indexOf('support'),
        );
        assert.ok(
            harnessOrder.indexOf('support') < harnessOrder.indexOf('probe:0'),
        );
        assert.equal(harnessStart.length, 2);
        await harness.controller.close();
        assert.equal(fixture.retained.size, 0);
    } finally {
        await fixture.close();
    }
});


test('a delayed old preparation is cancelled and released before the newer source starts', async () => {
    const old = deferred<AutoPlaybackPreparationResult>();
    const cancelled = deferred<void>();
    const order: string[] = [];
    const harness = createHarness({
        prepare: async (url) => {
            order.push(`prepare:${url}`);
            return url.endsWith('/old') ? old.promise : { ok: true, session: { id: 'new', url: 'http://127.0.0.1/new', format: 'hls' } };
        },
        cancel: async (attemptId) => { order.push(`cancel:${attemptId}`); cancelled.resolve(); },
        release: async (id) => { order.push(`release:${id}`); },
    });
    const first = harness.controller.open(playback('https://provider.example/old'));
    while (harness.prepared.length === 0) await Promise.resolve();
    const second = harness.controller.open(playback('https://provider.example/new'));
    await cancelled.promise;
    assert.equal(harness.started.length, 0);
    old.resolve({ ok: true, session: { id: 'late-old', url: 'http://127.0.0.1/late', format: 'hls' } });
    await Promise.all([first, second]);
    assert.ok(order.indexOf('release:late-old') < order.indexOf('prepare:https://provider.example/new'));
    assert.deepEqual(harness.started.map((item) => item.playback.originalStreamUrl), ['https://provider.example/new']);
});

test('an older open superseded by a newer open does not publish a stale barrier failure', async () => {
    const oldBarrier = deferred<number | null>(), harness = createHarness();
    let generation = 0, calls = 0;
    harness.dependencies.prepareForPlayback = async () => {
        calls += 1;
        if (calls === 1) return oldBarrier.promise;
        generation += 1;
        return generation;
    };
    harness.dependencies.isPlaybackTransitionCurrent = (token) => token === generation;
    const olderOpen = harness.controller.open(playback('https://provider.example/older')), currentOpen = harness.controller.open(playback('https://provider.example/current'));
    await currentOpen;
    oldBarrier.resolve(null);
    assert.equal(await olderOpen, null);
    assert.equal(harness.failures.length, 0); assert.equal(harness.started.length, 1);
    assert.equal(harness.controller.activePlayback?.playback.streamUrl, 'https://provider.example/current');
});

test('a superseded decoder diagnostic cannot publish a stale barrier failure over a newer open', async () => {
    const staleBarrier = deferred(),
        enteredBarrier = deferred(),
        harness = createHarness();
    await harness.controller.open(playback('https://provider.example/older'));
    let generation = 1,
        calls = 0;
    harness.dependencies.isPlaybackTransitionCurrent = (token) =>
        token === generation;
    harness.dependencies.prepareForPlayback = async () => {
        generation += 1;
        calls += 1;
        if (calls === 1) {
            enteredBarrier.resolve();
            return staleBarrier.promise;
        }
        for (const dispose of [...harness.teardown]) await dispose();
        return generation;
    };
    const oldActive = harness.controller.activePlayback;
    assert.ok(oldActive);
    const oldDiagnostic = harness.controller.handleDiagnostic({
        code: 'unsupported-codec',
        sourceUrl: oldActive.preparedPlayback.streamUrl,
    });
    await enteredBarrier.promise;
    await harness.controller.open(playback('https://provider.example/current'));
    staleBarrier.resolve(null);
    assert.equal(await oldDiagnostic, false);
    assert.equal(harness.failures.length, 0);
    assert.equal(
        harness.controller.activePlayback?.playback.streamUrl,
        'https://provider.example/current',
    );
});


test('close during preparation releases a late session and never starts the driver', async () => {
    const pending = deferred();
    const cancelled = deferred();
    const harness = createHarness({
        prepare: async () => pending.promise,
        cancel: async () => cancelled.resolve(),
    });
    const opening = harness.controller.open(
        playback('https://provider.example/pending'),
    );
    while (harness.prepared.length === 0) await Promise.resolve();
    const closing = harness.controller.close();
    await cancelled.promise;
    pending.resolve({
        ok: true,
        session: {
            id: 'late-close',
            url: 'http://127.0.0.1/late-close',
            format: 'hls',
        },
    });
    await Promise.all([opening, closing]);
    assert.deepEqual(harness.releases, ['late-close']);
    assert.equal(harness.started.length, 0);
});


test('a provider 401 is preserved for the failure surface and never starts or falls back', async () => {
    const fixture = await createLoopbackFixture();
    const harness = createHarness({ prepare: (url) => fixture.prepare(url) });
    try {
        await harness.controller.open(playback(`${new URL(fixture.originUrl).origin}/denied`));
        assert.equal(harness.started.length, 0);
        assert.equal(harness.failures.length, 1);
        assert.deepEqual(harness.failures[0].error, { code: 'http-error', status: 401, message: 'HTTP 401' });
    } finally {
        await fixture.close();
    }
});

test('a failed retained-response release blocks replacement and remains registered for retry', async () => {
    let failRelease = true;
    const harness = createHarness({
        release: async () => { if (failRelease) throw new Error('release pending'); },
    });
    await harness.controller.open(playback('https://provider.example/first'));
    const startsBefore = harness.started.length;
    await harness.controller.open(playback('https://provider.example/blocked'));
    assert.equal(harness.started.length, startsBefore);
    assert.equal(harness.prepared.length, 1);
    assert.ok(harness.teardown.size > 0);
    failRelease = false;
    await harness.controller.open(playback('https://provider.example/retry'));
    assert.equal(harness.prepared.length, 2);
    assert.equal(harness.started.length, 2);
});

test('one matching browser decoder diagnostic releases and reprepares for one native attempt', async () => {
    const harness = createHarness();
    await harness.controller.open(playback('https://provider.example/channel'), undefined, VideoPlayer.ArtPlayer);
    const active = harness.controller.activePlayback;
    assert.ok(active);
    const preparedUrl = active.preparedPlayback.streamUrl;
    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: preparedUrl }), true);
    assert.deepEqual(harness.started.map((item) => item.engine), [VideoPlayer.ArtPlayer, VideoPlayer.EmbeddedMpv]);
    assert.deepEqual(harness.releases, ['session-1']);
    assert.equal(harness.prepared.length, 2);
    assert.equal(harness.controller.activePlayback?.nativeAttempted, true);
    assert.equal(await harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl: preparedUrl }), false);
    assert.equal(harness.started.length, 2);
});

for (const nativeCase of [
    {
        name: 'Embedded MPV',
        support: { embeddedMpv: true, ksPlayer: true },
        engine: VideoPlayer.EmbeddedMpv,
    },
    {
        name: 'KSPlayer',
        support: { embeddedMpv: false, ksPlayer: true },
        engine: VideoPlayer.KsPlayer,
    },
]) {
    test(`automatic Matroska handoff to ${nativeCase.name} keeps credentials in the proxy session`, async () => {
        const sourceUrl = 'https://provider.example/movie/42';
        const preparedUrl = 'http://127.0.0.1/prepared/movie-42';
        const headers = {
            Authorization: 'Bearer provider-token',
            Cookie: 'stalker_session=opaque',
            Origin: 'https://provider.example',
            Referer: 'https://provider.example/portal.php',
            'X-User-Agent': 'Stalker-Client',
        };
        const requestPolicy = { accountRef: 'stalker-account', loginCookies: true, portalCredentials: true };
        const harness = createHarness({
            support: nativeCase.support,
            prepare: async () => ({
                ok: true,
                session: { id: 'prepared-movie-42', url: preparedUrl, format: 'progressive', container: 'matroska' },
            }),
        });

        await harness.controller.open(playback(sourceUrl, {
            isLive: false,
            headers,
            userAgent: 'Stalker-Client',
            referer: 'https://provider.example/portal.php',
            origin: 'https://provider.example',
            requestPolicy,
        }));

        const active = harness.controller.activePlayback;
        assert.ok(active);
        assert.equal(harness.started.length, 1);
        assert.equal(harness.started[0].engine, nativeCase.engine);
        assert.deepEqual(harness.prepared[0].headers, {
            ...headers,
            'User-Agent': 'Stalker-Client',
        });
        assert.equal(harness.started[0].playback.streamUrl, preparedUrl);
        assert.equal(harness.started[0].playback.originalStreamUrl, sourceUrl);
        assert.equal(harness.started[0].playback.preparedProxy?.url, preparedUrl);
        assert.equal(harness.started[0].playback.headers, undefined);
        assert.equal(harness.started[0].playback.userAgent, undefined);
        assert.equal(harness.started[0].playback.referer, undefined);
        assert.equal(harness.started[0].playback.origin, undefined);
        assert.equal(active.playback.streamUrl, sourceUrl);
        assert.deepEqual(active.playback.headers, headers);
        assert.equal(active.playback.requestPolicy, requestPolicy);
        assert.equal(harness.controller.originalPlayback?.streamUrl, sourceUrl);

        await harness.controller.close();
    });
}

test('same-source reopen accepts only the current prepared URL for decoder fallback', async () => {
    const source = playback('https://provider.example/same-channel');
    const harness = createHarness();
    await harness.controller.open(source);
    const first = harness.controller.activePlayback;
    assert.ok(first);
    const oldPreparedUrl = first.preparedPlayback.streamUrl;
    await harness.controller.open(source);
    const current = harness.controller.activePlayback;
    assert.ok(current);
    const currentPreparedUrl = current.preparedPlayback.streamUrl;
    assert.notEqual(currentPreparedUrl, oldPreparedUrl);

    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: source.streamUrl }), false);
    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: oldPreparedUrl }), false);
    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: currentPreparedUrl }), true);
    assert.deepEqual(harness.started.map((item) => item.engine), [VideoPlayer.EmbeddedMpv, VideoPlayer.EmbeddedMpv, VideoPlayer.KsPlayer]);
});

test('a failed native fallback is shown once and never starts another engine', async () => {
    const engines: VideoPlayer[] = [];
    const harness = createHarness({
        startPlayback: async (_playback, engine) => {
            engines.push(engine);
            if (engine === VideoPlayer.EmbeddedMpv) throw new Error('native load failed');
        },
    });
    await harness.controller.open(playback('https://provider.example/channel'), undefined, VideoPlayer.ArtPlayer);
    const active = harness.controller.activePlayback;
    assert.ok(active);
    assert.equal(await harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl: active.preparedPlayback.streamUrl }), false);
    assert.deepEqual(engines, [VideoPlayer.ArtPlayer, VideoPlayer.EmbeddedMpv]);
    assert.equal(harness.failures[0].error.code, 'playback-start-failed');
    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: active.preparedPlayback.streamUrl }), false);
    assert.deepEqual(engines, [VideoPlayer.ArtPlayer, VideoPlayer.EmbeddedMpv]);
});

test('late diagnostics for an old source and non-decoder failures cannot switch the current source', async () => {
    const harness = createHarness();
    await harness.controller.open(playback('https://provider.example/old'));
    const active = harness.controller.activePlayback;
    assert.ok(active);
    const oldUrl = active.preparedPlayback.streamUrl;
    await harness.controller.open(playback('https://provider.example/current'));
    assert.equal(await harness.controller.handleDiagnostic({ code: 'unsupported-container', sourceUrl: oldUrl }), false);
    assert.equal(await harness.controller.handleDiagnostic({ code: 'http-error', sourceUrl: 'https://provider.example/current' }), false);
    assert.equal(harness.controller.activePlayback?.playback.streamUrl, 'https://provider.example/current');
    assert.equal(harness.started.length, 2);
});

test('Matroska without an available bundled native engine reports unsupported media without starting', async () => {
    const harness = createHarness({ support: { embeddedMpv: false, ksPlayer: false } });
    harness.dependencies.prepare = async (url, headers, isLive) => {
        harness.prepared.push({ url, headers, isLive });
        return { ok: true, session: { id: 'matroska', url: 'http://127.0.0.1/matroska', format: 'progressive', container: 'matroska' } };
    };
    await harness.controller.open(playback('https://provider.example/movie'));
    assert.equal(harness.started.length, 0);
    assert.equal(harness.failures[0].error.code, 'unsupported-container');
    assert.deepEqual(harness.releases, ['matroska']);
});

test('DRM playback keeps its raw browser transport and skips automatic inspection', async () => {
    const harness = createHarness({ getRememberedSource: () => { throw new Error('Protected routes must not use source preferences'); } });
    const source = playback('https://provider.example/drm.mpd', {
        drm: { licenseType: 'org.w3.clearkey', supported: true },
    });
    await harness.controller.open(source);
    assert.equal(harness.prepared.length, 0);
    assert.equal(harness.started[0].engine, VideoPlayer.Html5Player);
    assert.equal(harness.started[0].playback, source);
    assert.equal(harness.controller.activePlayback?.preparedPlayback.preparedProxy, undefined);
});

test('a manually selected in-app engine starts first and recovers within the same selection', async () => {
    const harness = createHarness();
    await harness.controller.open(playback('https://provider.example/manual'), undefined, VideoPlayer.Html5Player);
    assert.equal(harness.started[0].engine, VideoPlayer.Html5Player);
    const active = harness.controller.activePlayback!;
    assert.equal(await harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl: active.preparedPlayback.streamUrl, positionSeconds: 44 }), true);
    assert.equal(harness.started[1].engine, VideoPlayer.EmbeddedMpv);
    await harness.controller.close();
});

test('native decoder failure tries another available engine and never exceeds three attempts', async () => {
    const harness = createHarness();
    await harness.controller.open(playback('https://provider.example/native'));
    assert.equal(harness.started[0].engine, VideoPlayer.EmbeddedMpv);
    for (let i = 0; i < 3; i++) {
        const active = harness.controller.activePlayback;
        if (active) await harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl: active.preparedPlayback.streamUrl });
    }
    assert.deepEqual(harness.started.map(item => item.engine), [VideoPlayer.EmbeddedMpv, VideoPlayer.KsPlayer, VideoPlayer.ArtPlayer]);
    assert.equal(harness.failures.length, 1);
    await harness.controller.close();
});

test('duplicate diagnostics share one replacement and terminal failures do not switch engines', async () => {
    const harness = createHarness();
    await harness.controller.open(playback('https://provider.example/duplicate'));
    const sourceUrl = harness.controller.activePlayback!.preparedPlayback.streamUrl;
    await Promise.all([harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl }), harness.controller.handleDiagnostic({ code: 'media-decode-error', sourceUrl })]);
    assert.equal(harness.started.length, 2);
    const current = harness.controller.activePlayback!;
    await harness.controller.handleDiagnostic({ code: 'provider-rejected', sourceUrl: current.preparedPlayback.streamUrl, status: 403 });
    assert.equal(harness.started.length, 2);
    await harness.controller.close();
});

test('100 source-change and cancel cycles release every retained response', async () => {
    const harness = createHarness();
    for (let index = 0; index < 100; index++) {
        await harness.controller.open(playback(`https://fixture.example/source/${index}`));
        assert.equal(harness.teardown.size, 1);
        await harness.controller.close();
        assert.equal(harness.teardown.size, 0);
    }
    assert.equal(harness.releases.length, 100);
    assert.equal(new Set(harness.releases).size, 100);
    assert.equal(harness.controller.activePlayback, null);
});

test('browser decoder recovery uses configured remux and then opt-in conversion within three attempts', async () => {
    const modes: (string | undefined)[] = [];
    const harness = createHarness({ support: { embeddedMpv: false, ksPlayer: false }, companionAvailable: () => true, conversionAllowed: () => true });
    harness.dependencies.prepare = async (_url, _headers, _live, _id, _policy, options) => {
        modes.push(options?.processingMode);
        return { ok: true, session: { id: `mode-${modes.length}`, url: `http://127.0.0.1/mode-${modes.length}`, format: 'hls', processingMode: options?.processingMode } };
    };
    await harness.controller.open(playback('https://fixture.example/test.m3u8'));
    for (let index = 0; index < 3; index++) {
        const active = harness.controller.activePlayback;
        if (active) await harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: active.preparedPlayback.streamUrl });
    }
    assert.deepEqual(modes, ['direct', 'remux', 'convert']);
    assert.equal(harness.failures.length, 1);
    await harness.controller.close();
});

test('direct playback ignores a captured diagnostic from an old attempt at the same URL', async () => {
    const url = 'https://fixture.example/same.mp4';
    const harness = createHarness({ support: { embeddedMpv: false, ksPlayer: false }, prepare: async () => ({ok:true,session:{id:crypto.randomUUID(),url,format:'progressive',container:'mp4',processingMode:'direct'}}) });
    await harness.controller.open(playback(url));
    const oldToken = harness.controller.activePlayback!.token;
    await harness.controller.open(playback(url));
    const currentToken = harness.controller.activePlayback!.token;
    assert.notEqual(oldToken, currentToken);
    assert.equal(await harness.controller.handleDiagnostic({code:'unsupported-codec',sourceUrl:url,attemptToken:oldToken}),false);
    assert.equal(harness.controller.activePlayback!.token,currentToken);
    assert.equal(harness.started.length,2);
    await harness.controller.close();
});

test('a browser container failure can try another transport without cycling a failed decoder', async () => {
    const harness = createHarness();
    harness.dependencies.getNativeSupport = async () => ({embeddedMpv:false,ksPlayer:false,nativeHls:true});
    await harness.controller.open(playback('https://fixture.example/native-hls.m3u8'));
    assert.equal(harness.started[0].engine,VideoPlayer.Html5Player);
    const current=harness.controller.activePlayback!;
    assert.equal(await harness.controller.handleDiagnostic({code:'unsupported-container',sourceUrl:current.preparedPlayback.streamUrl}),true);
    assert.equal(harness.started[1].engine,VideoPlayer.ArtPlayer);
    await harness.controller.close();
});

test('source memory waits for thirty seconds of advancing frames and writes once', async () => {
    let now = 0;
    const saved: ResolvedPortalPlayback[] = [];
    const activity: AutomaticPlaybackActivity[] = [];
    const harness = createHarness({
        now: () => now,
        rememberSource: (value) => saved.push(value),
        onActivity: (value) => activity.push(value),
    });
    await harness.controller.open(
        playback(
            'https://provider.test/live/user/password/1.m3u8?token=secret',
        ),
    );
    assert.equal(activity.at(-1)?.attempts[0].outcome, 'preparing');
    const url = harness.controller.activePlayback.preparedPlayback.streamUrl;
    for (let second = 0; second <= 31; second++) {
        now = second * 1e3;
        harness.controller.observeProgress(
            { mediaTimeSeconds: second, presentedFrames: second * 25 },
            url,
        );
        await harness.controller.poll();
        if (second < 31) assert.equal(saved.length, 0);
    }
    assert.equal(saved.length, 1);
    assert.equal(activity.at(-1)?.status, 'verified');
    assert.equal(activity.at(-1)?.attempts[0].verified, true);
    assert.equal(activity.at(-1)?.attempts[0].host, 'provider.test');
    assert.doesNotMatch(
        JSON.stringify(activity),
        /password|token=|secret|user\//,
    );
    now += 1e3;
    harness.controller.observeProgress(
        { mediaTimeSeconds: 32, presentedFrames: 800 },
        url,
    );
    await harness.controller.poll();
    assert.equal(saved.length, 1);
});


test('Auto applies a remembered current-channel route and retains configured fallback', async () => {
    const primary = 'https://primary.test/live/2.m3u8';
    const preferred = 'https://alternate.test/live/2.ts';
    const invalidated: string[] = [];
    const harness = createHarness({
        getRememberedSource: () => preferred,
        invalidateSource: (value) => invalidated.push(value.streamUrl),
        prepare: async (url) =>
            url === preferred
                ? {
                      ok: false,
                      error: {
                          code: 'http-error',
                          status: 401,
                          message: 'denied',
                      },
                  }
                : { ok: true, session: { id: 'fallback', url, format: 'hls' } },
    });
    await harness.controller.open(
        playback(primary, {
            recovery: {
                alternateHostUrl: primary.replace('primary', 'alternate'),
                formatUrls: {
                    hls: primary,
                    mpegts: primary.replace('.m3u8', '.ts'),
                },
            },
        }),
    );
    assert.deepEqual(
        harness.prepared.map((value) => value.url),
        [preferred, primary],
    );
    assert.equal(invalidated[0], preferred);
    const manual = createHarness({ getRememberedSource: () => preferred });
    await manual.controller.open(
        playback(primary),
        void 0,
        VideoPlayer.Html5Player,
    );
    assert.equal(manual.prepared[0].url, primary);
});


test('Auto activity retains failed attempts and a safe policy stop reason, then resets per selection', async () => {
    const activity: AutomaticPlaybackActivity[] = [];
    const harness = createHarness({
        onActivity: (value) => activity.push(value),
        prepare: async () => ({
            ok: false,
            error: {
                code: 'http-error',
                status: 404,
                message: 'https://provider.test/user/password?token=secret',
            },
        }),
    });
    await harness.controller.open(
        playback('https://provider.test/1.m3u8', {
            recovery: { formatUrls: { mpegts: 'https://provider.test/1.ts' } },
        }),
    );
    const failed = activity.at(-1);
    assert.equal(failed.status, 'stopped');
    assert.equal(failed.attempts.length, 2);
    assert.ok(failed.attempts.every((attempt) => attempt.outcome === 'failed'));
    assert.match(failed.attempts[0].reason, /404/);
    assert.ok(failed.stopReason);
    assert.doesNotMatch(JSON.stringify(activity), /password|token=|secret/);
    harness.controller.invalidate();
    assert.equal(activity.at(-1)?.status, 'stopped');
    await harness.controller.open(playback('https://next.test/2.m3u8'));
    assert.equal(activity.at(-1)?.attempts.length, 1);
    assert.equal(activity.at(-1)?.attempts[0].number, 1);
    assert.equal(activity.at(-1)?.attempts[0].host, 'next.test');
});


test('activity ignores late preparations and records playback only after frame progress', async () => {
    const first = deferred<AutoPlaybackPreparationResult>();
    const activity: AutomaticPlaybackActivity[] = [];
    const harness = createHarness({
        onActivity: (value) => activity.push(value),
        prepare: async (url) =>
            url.includes('old.test')
                ? first.promise
                : { ok: true, session: { id: 'new', url, format: 'hls' } },
    });
    const old = harness.controller.open(playback('https://old.test/1.m3u8'));
    while (!harness.prepared.length)
        await new Promise((resolve) => setTimeout(resolve, 0));
    const next = harness.controller.open(playback('https://new.test/2.m3u8'));
    first.resolve({
        ok: true,
        session: { id: 'old', url: 'https://old.test/1.m3u8', format: 'hls' },
    });
    await Promise.all([old, next]);
    assert.equal(activity.at(-1)?.attempts[0].host, 'new.test');
    assert.equal(activity.at(-1)?.attempts[0].outcome, 'preparing');
    harness.controller.observeProgress(
        { mediaTimeSeconds: 0, presentedFrames: 0 },
        'https://new.test/2.m3u8',
    );
    harness.controller.observeProgress(
        { mediaTimeSeconds: 1, presentedFrames: 25 },
        'https://new.test/2.m3u8',
    );
    assert.equal(activity.at(-1)?.attempts[0].outcome, 'playing');
    assert.equal(activity.at(-1)?.attempts[0].verified, false);
    harness.controller.invalidate();
    assert.equal(activity.at(-1)?.status, 'cancelled');
});


test('a running clock without advancing frames never becomes a remembered source', async () => {
    let now = 0;
    let remembered = 0;
    const harness = createHarness({
        now: () => now,
        rememberSource: () => {
            remembered++;
        },
    });
    await harness.controller.open(playback('https://provider.test/1.m3u8'));
    const url = harness.controller.activePlayback.preparedPlayback.streamUrl;
    for (let second = 0; second < 40; second++) {
        now = second * 1e3;
        harness.controller.observeProgress(
            { mediaTimeSeconds: second, presentedFrames: 0 },
            url,
        );
    }
    await harness.controller.poll();
    assert.equal(remembered, 0);
    harness.controller.invalidate();
});


test('verified source survives a store restart and resolves the next channel at the remembered host and format', async () => {
    const values = new Map<string, string>();
    const storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
        removeItem: (key: string) => {
            values.delete(key);
        },
    };
    let now = 0;
    let preferences = new PlaybackSourcePreferences(storage, {
        now: () => now,
    });
    const scope = {
        sourceIdentity: 'provider-account',
        live: true,
        runtime: 'test',
    };
    const harness = createHarness({
        now: () => now,
        getRememberedSource: (value) =>
            preferences.getCompatible(scope, value) ?? void 0,
        rememberSource: (value, media) => {
            preferences.rememberVerifiedSuccess(
                scope,
                value,
                true,
                media.format,
            );
        },
        prepare: async (url) => ({
            ok: true,
            session: {
                id: url.endsWith('.ts') ? 'ts' : 'hls',
                url,
                format: url.endsWith('.ts') ? 'mpegts' : 'hls',
            },
        }),
    });
    const old = 'https://alternate.test/live/user/password/1.ts';
    await harness.controller.open(playback(old));
    for (let second = 0; second <= 31; second++) {
        now = second * 1e3;
        harness.controller.observeProgress(
            { mediaTimeSeconds: second, presentedFrames: second * 25 },
            old,
        );
        await harness.controller.poll();
    }
    await harness.controller.close();
    preferences = new PlaybackSourcePreferences(storage, { now: () => now });
    const next = 'https://primary.test/live/user/password/2.m3u8';
    await harness.controller.open(
        playback(next, {
            recovery: {
                alternateHostUrl: next.replace('primary', 'alternate'),
                formatUrls: { hls: next, mpegts: next.replace('.m3u8', '.ts') },
            },
        }),
    );
    assert.equal(
        harness.prepared.at(-1)?.url,
        'https://alternate.test/live/user/password/2.ts',
    );
    assert.doesNotMatch(JSON.stringify([...values]), /password|https:|live\//);
    harness.controller.invalidate();
});


test('activity explains a blocked preparation instead of remaining in preparing', async () => {
    let current: AutomaticPlaybackActivity | undefined;
    const harness = createHarness({
        prepareForPlayback: async () => null,
        onActivity: (value) => {
            current = value;
        },
    });
    await harness.controller.open(playback('https://provider.test/1.m3u8'));
    assert.equal(current?.status, 'stopped');
    assert.match(current?.stopReason ?? '', /previous player/);
});


test('a late player-start rejection cannot change a newer selection or its activity', async () => {
    let rejectOld!: (error: Error) => void;
    const oldStart = new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
    });
    let oldStarting = false;
    let activity: AutomaticPlaybackActivity | undefined;
    const harness = createHarness({
        onActivity: (value) => {
            activity = value;
        },
        startPlayback: async (value) => {
            if (value.title === 'old') {
                oldStarting = true;
                await oldStart;
            }
        },
    });
    const old = harness.controller.open(
        playback('https://old.test/1.m3u8', { title: 'old' }),
    );
    while (!oldStarting) await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.controller.open(playback('https://new.test/2.m3u8'));
    const before = activity;
    rejectOld(new Error('Old player could not start'));
    await old;
    assert.equal(activity, before);
    assert.equal(
        harness.controller.activePlayback?.originalUrl,
        'https://new.test/2.m3u8',
    );
    assert.equal(harness.prepared.length, 2);
    harness.controller.invalidate();
});


test('activity explains provider throttling and the recovery window in plain language', async () => {
    let activity: import('./automatic-playback-activity').AutomaticPlaybackActivity | undefined;
    const harness = createHarness({ onActivity: value => { activity = value; }, prepare: async () => ({ ok: false, error: { code: 'http-error', status: 429, retryAfterMs: 60000, message: 'provider secret' } }) });
    await harness.controller.open(playback('https://provider.test/1.m3u8'));
    assert.match(activity?.stopReason ?? '', /HTTP 429/);
    assert.match(activity?.stopReason ?? '', /60 seconds/);
    assert.match(activity?.stopReason ?? '', /remaining recovery window/);
    assert.doesNotMatch(activity?.stopReason ?? '', /episode-deadline|provider secret/);
});

test('a failed remembered route tries the configured source before repeating the route', async () => {
    const primary = 'https://primary.test/live/1.m3u8';
    const preferred = 'https://alternate.test/live/1.ts';
    for (const error of [
        { code: 'network-error', status: null },
        { code: 'html-response', status: 200 },
        { code: 'http-error', status: 503 },
    ]) {
        const reasons: string[] = [];
        const harness = createHarness({
            getRememberedSource: () => preferred,
            onRecovery: reason => reasons.push(reason),
            prepare: async url => url === preferred
                ? { ok: false, error: { ...error, message: 'Remembered route failed' } }
                : { ok: true, session: { id: 'configured', url, format: 'hls' } },
        });
        await harness.controller.open(playback(primary, { recovery: { alternateHostUrl: primary.replace('primary', 'alternate'), formatUrls: { hls: primary, mpegts: primary.replace('.m3u8', '.ts') } } }));
        assert.deepEqual(harness.prepared.map(value => value.url), [preferred, primary]);
        assert.equal(harness.failures.length, 0);
        assert.match(reasons[0], /configured source/);
        await harness.controller.close();
    }
});

test('startup watchdog failure on a remembered route falls back to the configured source', async () => {
    let now = 0;
    const primary = 'https://primary.test/live/1.m3u8';
    const preferred = 'https://primary.test/live/1.ts';
    const harness = createHarness({ now: () => now, getRememberedSource: () => preferred });
    await harness.controller.open(playback(primary, { recovery: { formatUrls: { hls: primary, mpegts: preferred } } }));
    now = 12000;
    await harness.controller.poll();
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred, primary]);
    assert.equal(harness.failures.length, 0);
    await harness.controller.close();
});

test('configured fallback cannot repeat indefinitely or exceed three attempts', async () => {
    const primary = 'https://primary.test/live/1.m3u8';
    const preferred = 'https://primary.test/live/1.ts';
    const harness = createHarness({ getRememberedSource: () => preferred, prepare: async () => ({ ok: false, error: { code: 'html-response', status: 200, message: 'Not media' } }) });
    await harness.controller.open(playback(primary, { recovery: { formatUrls: { hls: primary, mpegts: preferred } } }));
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred, primary]);
    assert.equal(harness.failures.length, 1);
});

test('a remembered route cannot bypass a provider rate limit by changing source', async () => {
    const primary = 'https://primary.test/live/1.m3u8';
    const preferred = 'https://alternate.test/live/1.ts';
    const harness = createHarness({ getRememberedSource: () => preferred, prepare: async () => ({ ok: false, error: { code: 'http-error', status: 429, retryAfterMs: 60000, message: 'Wait' } }) });
    await harness.controller.open(playback(primary));
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred]);
    assert.equal(harness.failures[0].error.status, 429);
});

test('configured source fallback preserves recorded playback position and restores provider alternatives', async () => {
    const primary = 'https://primary.test/movie/1.m3u8';
    const alternate = primary.replace('primary', 'alternate');
    const preferred = alternate.replace('.m3u8', '.ts');
    const harness = createHarness({ getRememberedSource: () => preferred });
    await harness.controller.open(playback(primary, { isLive: false, recovery: { alternateHostUrl: alternate, formatUrls: { hls: primary, mpegts: primary.replace('.m3u8', '.ts') } } }));
    const active = harness.controller.activePlayback!;
    await harness.controller.handleDiagnostic({ code: 'network-error', sourceUrl: active.preparedPlayback.streamUrl, positionSeconds: 64 });
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred, primary]);
    assert.equal(harness.started.at(-1)?.playback.startTime, 64);
    assert.equal(harness.started.at(-1)?.playback.recovery?.alternateHostUrl, alternate);
    await harness.controller.close();
});

test('a configured fallback never reuses an old provider link after supported renewal', async () => {
    const primary = 'https://primary.test/live/1.m3u8?token=old';
    const preferred = 'https://alternate.test/live/1.ts?token=old';
    const fresh = 'https://primary.test/live/1.m3u8?token=fresh';
    const harness = createHarness({
        getRememberedSource: () => preferred,
        canRenew: () => true,
        renewPlayback: async () => playback(fresh),
        prepare: async url => url === preferred
            ? { ok: false, error: { code: 'http-error', status: 401, message: 'Expired' } }
            : { ok: false, error: { code: 'html-response', status: 200, message: 'Unavailable' } },
    });
    await harness.controller.open(playback(primary));
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred, fresh]);
    assert.equal(harness.failures.length, 1);
});

test('a just-resolved renewal cannot clear the configured fallback of a newer selection', async () => {
    const renewal = deferred<ResolvedPortalPlayback>();
    let renewing = false;
    const oldPrimary = 'https://primary.test/live/old.m3u8';
    const newPrimary = 'https://primary.test/live/new.m3u8';
    const preferred = (url: string) => url.replace('primary', 'alternate');
    const harness = createHarness({
        getRememberedSource: value => preferred(value.streamUrl),
        canRenew: value => value.title === 'old',
        renewPlayback: () => { renewing = true; return renewal.promise; },
        prepare: async url => url === preferred(oldPrimary)
            ? { ok: false, error: { code: 'http-error', status: 401, message: 'Expired' } }
            : { ok: true, session: { id: url === newPrimary ? 'configured' : 'preferred', url, format: 'hls' } },
    });
    const old = harness.controller.open(playback(oldPrimary, { title: 'old' }));
    while (!renewing) await new Promise(resolve => setTimeout(resolve, 0));
    const next = renewal.promise.then(() => harness.controller.open(playback(newPrimary)));
    renewal.resolve(playback('https://primary.test/live/old.m3u8?fresh=true'));
    await Promise.all([old, next]);
    const active = harness.controller.activePlayback!;
    await harness.controller.handleDiagnostic({ code: 'html-response', status: 200, sourceUrl: active.preparedPlayback.streamUrl });
    assert.deepEqual(harness.prepared.map(value => value.url), [preferred(oldPrimary), preferred(newPrimary), newPrimary]);
    await harness.controller.close();
});
