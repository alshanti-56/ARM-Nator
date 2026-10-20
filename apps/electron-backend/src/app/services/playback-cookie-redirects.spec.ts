import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { HlsPlaybackProxyService } from './hls-playback-proxy.service';
import { PlaybackCookieSession } from './playback-cookie-session';

async function listen(server: Server): Promise<string> {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

test('cookie-aware redirects retain HEAD through a 303 without requesting a body', async () => {
    const requests: { method?: string; cookie?: string }[] = [];
    const server = createServer((request, response) => {
        requests.push({ method: request.method, cookie: request.headers.cookie });
        if (request.url === '/start.m3u8') {
            response.writeHead(303, { location: '/final.m3u8', 'set-cookie': 'head-session=ready; Path=/' }).end();
        } else {
            response.writeHead(request.headers.cookie === 'head-session=ready' ? 200 : 401, { 'content-type': 'application/vnd.apple.mpegurl' }).end();
        }
    });
    const source = await listen(server);
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    try {
        const session = await proxy.createSession({ url: `${source}/start.m3u8` });
        const response = await fetch(session.url, { method: 'HEAD' });
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '');
        assert.deepEqual(requests, [
            { method: 'HEAD', cookie: undefined },
            { method: 'HEAD', cookie: 'head-session=ready' },
        ]);
    } finally { await proxy.shutdown(); await close(server); }
});

test('cookie-aware playback stops redirect loops after twenty follows', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
        requests += 1;
        response.writeHead(302, { location: '/loop.m3u8', 'set-cookie': 'loop-session=ready; Path=/' }).end();
    });
    const source = await listen(server);
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    try {
        const session = await proxy.createSession({ url: `${source}/loop.m3u8` });
        const response = await fetch(session.url, { signal: AbortSignal.timeout(3000) });
        await response.body?.cancel();
        assert.equal(response.status, 502);
        assert.equal(requests, 21);
    } finally { await proxy.shutdown(); await close(server); }
});

test('releasing a cookie-aware session aborts a stalled second redirect hop', async () => {
    let markStarted!: () => void;
    let markClosed!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const closed = new Promise<void>(resolve => { markClosed = resolve; });
    const server = createServer((request, response) => {
        if (request.url === '/start.m3u8') {
            response.writeHead(302, { location: '/slow.m3u8', 'set-cookie': 'hop-session=ready; Path=/' }).end();
        } else {
            assert.equal(request.headers.cookie, 'hop-session=ready');
            request.once('close', markClosed);
            markStarted();
        }
    });
    const source = await listen(server);
    const proxy = new HlsPlaybackProxyService({ mpegTsRemuxerPath: null });
    let pending: Promise<Response> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        const session = await proxy.createSession({ url: `${source}/start.m3u8` });
        pending = fetch(session.url).catch(() => new Response());
        const timeout = new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('redirect teardown timed out')), 3000);
        });
        await Promise.race([started, timeout]);
        proxy.releaseSession(session.id);
        await Promise.race([closed, timeout]);
        assert.equal(proxy.sessionCount, 0);
    } finally {
        if (deadline) clearTimeout(deadline);
        await proxy.shutdown(); await close(server);
        await (await pending)?.body?.cancel();
    }
});

test('cookie prefix checks ignore invalid cookies and preserve valid deletion masks', async () => {
    const cookies = new PlaybackCookieSession('https://video.example.com', '__Host-auth=manual');
    try {
        await cookies.storeSetCookieHeaders('https://video.example.com/live/start', [
            '__Host-auth=fresh; Path=/; Secure',
            '__Host-invalid=wrong; Domain=example.com; Path=/; Secure',
            '__Secure-invalid=wrong; Path=/',
        ]);
        assert.equal(await cookies.getCookieHeader('https://video.example.com/live/segment'), '__Host-auth=fresh');
        await cookies.storeSetCookieHeaders('https://video.example.com/live/start', ['__Host-auth=; Path=/; Secure; Max-Age=0']);
        assert.equal(await cookies.getCookieHeader('https://video.example.com/live/segment'), undefined);
    } finally { cookies.dispose(); }
});
