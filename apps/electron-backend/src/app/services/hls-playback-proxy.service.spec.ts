import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import {
    HlsPlaybackProxyService,
    resolveHlsProxyTarget,
    rewriteHlsManifest,
    sanitizeHlsProxyHeaders,
} from './hls-playback-proxy.service';

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('HLS proxy rewrites relative, absolute, and key URIs without exposing targets', () => {
    const target = 'https://tokenized.example/live/segment.ts?token=secret';
    const rewritten = rewriteHlsManifest(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="keys/key.bin?auth=secret"\nsegment.ts?token=secret\nhttps://tokenized.example/live/segment.ts?token=secret\n',
        'https://tokenized.example/live/playlist.m3u8?access=secret',
        () => 'http://127.0.0.1:9999/hls/opaque/resource'
    );

    assert.equal((rewritten.match(/http:\/\/127\.0\.0\.1:9999/g) ?? []).length, 3);
    assert.ok(!rewritten.includes('tokenized.example'));
    assert.ok(!rewritten.includes('secret'));
    assert.equal(resolveHlsProxyTarget('data:text/plain,nope', target), null);
    assert.equal(resolveHlsProxyTarget('../next.ts?x=1', target), 'https://tokenized.example/next.ts?x=1');
});

test('HLS proxy only retains safe provider headers', () => {
    assert.deepEqual(
        sanitizeHlsProxyHeaders({
            'User-Agent': ' Provider/1.0 ',
            Referer: 'https://provider.example/',
            Cookie: 'session=secret',
            'X-Injected': 'bad\r\nvalue',
        }),
        { 'user-agent': 'Provider/1.0', referer: 'https://provider.example/' }
    );
});

test('HLS proxy serializes concurrent server startup', async () => {
    const proxy = new HlsPlaybackProxyService();
    try {
        const [first, second] = await Promise.all([
            proxy.createSession({ url: 'http://127.0.0.1:1/first.m3u8' }),
            proxy.createSession({ url: 'http://127.0.0.1:1/second.m3u8' }),
        ]);
        assert.equal(new URL(first.url).origin, new URL(second.url).origin);
    } finally {
        await proxy.shutdown();
    }
});

test('HLS proxy rejects a session racing with shutdown', async () => {
    const proxy = new HlsPlaybackProxyService();
    const creating = proxy.createSession({ url: 'http://127.0.0.1:1/racing.m3u8' });
    const shuttingDown = proxy.shutdown();

    await assert.rejects(creating, /shutting down/);
    await shuttingDown;
    assert.equal(proxy.sessionCount, 0);
    await assert.rejects(
        proxy.createSession({ url: 'http://127.0.0.1:1/after.m3u8' }),
        /shutting down/
    );
});

test('HLS proxy pins a successful redirect for live playlist refreshes', async () => {
    let redirects = 0;
    let playlistRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            redirects += 1;
            response.writeHead(302, { location: `/node-${redirects}.m3u8` }).end();
            return;
        }
        if (request.url?.startsWith('/node-')) {
            playlistRequests += 1;
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${playlistRequests}\n`);
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/start.m3u8` });
        const first = await fetch(session.url);
        const second = await fetch(session.url);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(redirects, 1);
        assert.equal(playlistRequests, 2);
        assert.match(await second.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy refreshes an expired redirect token for live playlists', async () => {
    let redirects = 0;
    let firstTokenRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            redirects += 1;
            response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
            return;
        }
        if (request.url === '/token-1.m3u8') {
            firstTokenRequests += 1;
            if (firstTokenRequests > 1) {
                response.writeHead(404).end();
                return;
            }
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n');
            return;
        }
        if (request.url === '/token-2.m3u8') {
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n');
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/start.m3u8` });
        assert.equal((await fetch(session.url)).status, 200);
        const refreshed = await fetch(session.url);
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
        assert.equal(redirects, 2);
        assert.equal(firstTokenRequests, 2);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy refreshes a redirect token after a transient upstream failure', async () => {
    let redirects = 0;
    let firstTokenRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            redirects += 1;
            response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
            return;
        }
        if (request.url === '/token-1.m3u8') {
            firstTokenRequests += 1;
            if (firstTokenRequests > 1) {
                response.writeHead(509).end();
                return;
            }
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n');
            return;
        }
        if (request.url === '/token-2.m3u8') {
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n');
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/start.m3u8` });
        assert.equal((await fetch(session.url)).status, 200);
        const refreshed = await fetch(session.url);
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
        assert.equal(redirects, 2);
        assert.equal(firstTokenRequests, 2);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy refreshes a redirect token after an expired-token 406', async () => {
    let redirects = 0;
    let firstTokenRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            redirects += 1;
            response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
            return;
        }
        if (request.url === '/token-1.m3u8') {
            firstTokenRequests += 1;
            if (firstTokenRequests > 1) {
                response.writeHead(406).end();
                return;
            }
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n');
            return;
        }
        if (request.url === '/token-2.m3u8') {
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n');
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/start.m3u8` });
        assert.equal((await fetch(session.url)).status, 200);
        const refreshed = await fetch(session.url);
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
        assert.equal(redirects, 2);
        assert.equal(firstTokenRequests, 2);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy refreshes a redirect token after an expired-token 403', async () => {
    let redirects = 0;
    let firstTokenRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            redirects += 1;
            response.writeHead(302, { location: `/token-${redirects}.m3u8` }).end();
            return;
        }
        if (request.url === '/token-1.m3u8') {
            firstTokenRequests += 1;
            if (firstTokenRequests > 1) {
                response.writeHead(403).end();
                return;
            }
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n');
            return;
        }
        if (request.url === '/token-2.m3u8') {
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n');
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/start.m3u8` });
        assert.equal((await fetch(session.url)).status, 200);
        const refreshed = await fetch(session.url);
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
        assert.equal(redirects, 2);
        assert.equal(firstTokenRequests, 2);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy cache-busts an unredirected live URL after an expired-token 403', async () => {
    let playlistRequests = 0;
    let refreshRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url?.startsWith('/live.m3u8')) {
            playlistRequests += 1;
            if (new URL(request.url, 'http://127.0.0.1').searchParams.has('_arm_nator_refresh')) {
                refreshRequests += 1;
                response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
                response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n');
                return;
            }
            if (playlistRequests === 1) {
                response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
                response.end('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n');
                return;
            }
            response.writeHead(403).end();
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/live.m3u8` });
        assert.equal((await fetch(session.url)).status, 200);
        const refreshed = await fetch(session.url);
        assert.equal(refreshed.status, 200);
        assert.match(await refreshed.text(), /#EXT-X-MEDIA-SEQUENCE:2/);
        assert.equal(refreshRequests, 1);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy does not pass a regressed live media sequence to HLS.js', async () => {
    let playlistRequests = 0;
    const upstream = createServer((request, response) => {
        if (request.url === '/live.m3u8') {
            playlistRequests += 1;
            const sequence = playlistRequests === 1 ? 10 : 9;
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n`);
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({ url: `${upstreamUrl}/live.m3u8` });
        const first = await fetch(session.url);
        const second = await fetch(session.url);
        assert.equal(await first.text(), '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n');
        assert.equal(await second.text(), '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n');
        assert.equal(playlistRequests, 2);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});

test('HLS proxy scopes resources to a session, forwards headers, emits CORS, and releases cleanly', async () => {
    const observed: Array<{
        path: string;
        userAgent?: string;
        referer?: string;
        range?: string;
        cacheControl?: string;
        pragma?: string;
    }> = [];
    const upstream = createServer((request, response) => {
        observed.push({
            path: request.url ?? '',
            userAgent: request.headers['user-agent'],
            referer: request.headers.referer,
            range: request.headers.range,
            cacheControl: request.headers['cache-control'],
            pragma: request.headers.pragma,
        });
        if (request.url === '/start.m3u8') {
            response.writeHead(302, { location: '/tokenized/manifest' }).end();
            return;
        }
        if (request.url === '/tokenized/manifest') {
            response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            response.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin?access=secret"\nchunk.ts?access=secret\nchunk.ts?access=secret\n');
            return;
        }
        if (request.url?.startsWith('/tokenized/chunk.ts')) {
            response.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-2/3' });
            response.end('ts!');
            return;
        }
        if (request.url?.startsWith('/tokenized/key.bin')) {
            response.writeHead(200, { 'content-type': 'application/octet-stream' }).end('key');
            return;
        }
        response.writeHead(404).end();
    });
    const upstreamUrl = await listen(upstream);
    const proxy = new HlsPlaybackProxyService();
    try {
        const session = await proxy.createSession({
            url: `${upstreamUrl}/start.m3u8`,
            headers: { 'User-Agent': 'Provider/1.0', Referer: 'https://provider.example/' },
        });
        const manifest = await fetch(session.url, { headers: { Origin: 'http://localhost:4200' } });
        assert.equal(manifest.status, 200);
        assert.equal(manifest.headers.get('access-control-allow-origin'), 'http://localhost:4200');
        const body = await manifest.text();
        assert.ok(!body.includes('tokenized'));
        assert.ok(!body.includes('secret'));
        const chunkUrls = body.split('\n').filter((line) => line.startsWith('http://'));
        assert.equal(chunkUrls.length, 2);
        assert.equal(new Set(chunkUrls).size, 1);
        const chunkUrl = chunkUrls[0];
        assert.ok(chunkUrl);
        const chunk = await fetch(chunkUrl, { headers: { Origin: 'http://localhost:4200', Range: 'bytes=0-2' } });
        assert.equal(chunk.status, 206);
        assert.equal(await chunk.text(), 'ts!');
        assert.deepEqual(observed.at(-1), {
            path: '/tokenized/chunk.ts?access=secret', userAgent: 'Provider/1.0',
            referer: 'https://provider.example/', range: 'bytes=0-2',
            cacheControl: 'no-cache', pragma: 'no-cache',
        });
        assert.equal(observed[0]?.cacheControl, 'no-cache');
        assert.equal(observed[0]?.pragma, 'no-cache');

        const denied = await fetch(session.url, { headers: { Origin: 'https://untrusted.example' } });
        assert.equal(denied.status, 403);
        proxy.releaseSession(session.id);
        assert.equal(proxy.sessionCount, 0);
        assert.equal((await fetch(session.url)).status, 404);
    } finally {
        await proxy.shutdown();
        await close(upstream);
    }
});
