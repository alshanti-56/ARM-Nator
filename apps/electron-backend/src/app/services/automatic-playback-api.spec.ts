import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createAutomaticPlaybackApi } from './automatic-playback-api';
import { HlsPlaybackProxyService } from './hls-playback-proxy.service';
import { PlaybackDiagnosticsStore, type PlaybackDiagnosticInput } from './playback-diagnostics.service';

test('a rejected source returns a serializable authorization failure instead of throwing away its HTTP status', async () => {
    const source = createServer((_request, response) => response.writeHead(401).end('Denied'));
    await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
    const address = source.address(); assert.ok(address && typeof address !== 'string');
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    try {
        const result = await createAutomaticPlaybackApi(proxy).prepare(`http://127.0.0.1:${address.port}/channel`, undefined, true, 'api-auth-test');
        const transferred = JSON.parse(JSON.stringify(result)) as typeof result;
        assert.equal(transferred.ok, false);
        if (!transferred.ok) {
            assert.equal(transferred.error.code, 'http-error');
            assert.equal(transferred.error.status, 401);
            assert.match(transferred.error.message, /401/);
        }
        assert.equal(proxy.sessionCount, 0);
    } finally {
        await proxy.shutdown();
        await new Promise<void>((resolve) => source.close(() => resolve()));
    }
});

test('a DNS failure keeps its nested network code and returns a useful preparation message', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND stream.example.test'), { code: 'ENOTFOUND' });
    const proxy = {
        createAutoSession: async () => { throw new TypeError('fetch failed', { cause }); },
    } as unknown as HlsPlaybackProxyService;

    const result = await createAutomaticPlaybackApi(proxy).prepare('https://provider.example/live', undefined, true, 'api-dns-test');
    const transferred = JSON.parse(JSON.stringify(result)) as typeof result;
    assert.equal(transferred.ok, false);
    if (!transferred.ok) {
        assert.equal(transferred.error.code, 'network-error');
        assert.equal(transferred.error.networkCode, 'ENOTFOUND');
        assert.match(transferred.error.message, /DNS lookup/i);
        assert.doesNotMatch(transferred.error.message, /stream\.example\.test/);
    }
});

test('preparation preserves provider Retry-After across IPC before any engine starts', async () => {
    const source = createServer((_request, response) => response.writeHead(429, { 'Retry-After': '60' }).end('Slow down'));
    await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
    const address = source.address(); assert.ok(address && typeof address !== 'string');
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    try {
        const result = JSON.parse(JSON.stringify(await createAutomaticPlaybackApi(proxy).prepare(`http://127.0.0.1:${address.port}/channel`, undefined, true, 'retry-after-test')));
        assert.equal(result.ok, false);
        assert.equal(result.error.status, 429);
        assert.equal(result.error.retryAfterMs, 60_000);
        assert.equal(proxy.sessionCount, 0);
    } finally {
        await proxy.shutdown();
        await new Promise<void>(resolve => source.close(() => resolve()));
    }
});

test('decision diagnostics retain the original source and actual chosen engine', async () => {
    class Recorder extends PlaybackDiagnosticsStore {
        readonly records: PlaybackDiagnosticInput[] = [];
        override record(record: PlaybackDiagnosticInput): void { this.records.push(record); }
    }
    const diagnostics = new Recorder({ filePath: '/tmp/arm-nator-auto-api-test.jsonl' });
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    try {
        createAutomaticPlaybackApi(proxy, diagnostics).recordDecision({ sourceUrl: 'https://provider.example/live/user/password/1?token=exact', sessionId: 'owned-session', engine: 'artplayer', reason: 'Inspected HLS' });
        assert.equal(diagnostics.records[0]?.event, 'automatic-playback-decision');
        assert.equal(diagnostics.records[0]?.sourceUrl, 'https://provider.example/live/user/password/1?token=exact');
        assert.equal(diagnostics.records[0]?.sessionId, 'owned-session');
        assert.equal(diagnostics.records[0]?.details, 'engine=artplayer; reason=Inspected HLS');
    } finally {
        await proxy.shutdown();
    }
});
