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
    const failures: { playback: ResolvedPortalPlayback; error: { code: string; status: number | null; message: string }; token: number | null }[] = [];
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
    const harnessOrder: string[] = [];
    const harnessStart: { resolved: ResolvedPortalPlayback; context?: string; token: number }[] = [];
    harness.dependencies.onPreparing = () => harnessOrder.push('loading');
    harness.dependencies.getNativeSupport = async () => {
        harnessOrder.push('support');
        return { embeddedMpv: true, ksPlayer: true };
    };
    try {
        const source = playback(fixture.originUrl, {
            headers: { Authorization: 'Bearer private', 'x-provider': 'kept', 'user-agent': 'old-agent' },
            userAgent: 'player-agent', referer: 'https://provider.example/page', origin: 'https://provider.example',
        });
        await harness.controller.open(source, 'live-context');
        assert.equal(fixture.upstreamRequests, 1);
        assert.equal(fixture.preparedRequests, 1);
        assert.equal(fixture.retained.size, 1);
        const first = harness.controller.activePlayback;
        assert.ok(first);
        assert.equal(first.playback.streamUrl, fixture.originUrl);
        assert.equal(first.preparedPlayback.originalStreamUrl, fixture.originUrl);
        assert.equal(first.preparedPlayback.streamUrl, `${new URL(fixture.originUrl).origin}/prepared/loopback-1`);
        assert.deepEqual(harness.prepared[0].headers, {
            Authorization: 'Bearer private', 'x-provider': 'kept', 'User-Agent': 'player-agent',
            Referer: 'https://provider.example/page', Origin: 'https://provider.example',
        });
        await harness.controller.open(playback(fixture.originUrl));
        assert.equal(fixture.upstreamRequests, 2);
        assert.equal(fixture.retained.size, 1);
        assert.deepEqual(fixture.retainedAtPrepare, [0, 0]);
        assert.ok(harnessOrder.indexOf('loading') < harnessOrder.indexOf('support'));
        assert.ok(harnessOrder.indexOf('support') < harnessOrder.indexOf('probe:0'));
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
    const staleBarrier = deferred<number | null>(), enteredBarrier = deferred<void>(), harness = createHarness();
    await harness.controller.open(playback('https://provider.example/older'));
    let generation = 1, calls = 0;
    harness.dependencies.isPlaybackTransitionCurrent = (token) => token === generation;
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
    const oldDiagnostic = harness.controller.handleDiagnostic({ code: 'unsupported-codec', sourceUrl: oldActive.preparedPlayback.streamUrl });
    await enteredBarrier.promise;
    await harness.controller.open(playback('https://provider.example/current'));
    staleBarrier.resolve(null);
    assert.equal(await oldDiagnostic, false);
    assert.equal(harness.failures.length, 0);
    assert.equal(harness.controller.activePlayback?.playback.streamUrl, 'https://provider.example/current');
});

test('close during preparation releases a late session and never starts the driver', async () => {
    const pending = deferred<AutoPlaybackPreparationResult>();
    const cancelled = deferred<void>();
    const harness = createHarness({
        prepare: async () => pending.promise,
        cancel: async () => cancelled.resolve(),
    });
    const opening = harness.controller.open(playback('https://provider.example/pending'));
    while (harness.prepared.length === 0) await Promise.resolve();
    const closing = harness.controller.close();
    await cancelled.promise;
    pending.resolve({ ok: true, session: { id: 'late-close', url: 'http://127.0.0.1/late-close', format: 'hls' } });
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
    const harness = createHarness();
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
