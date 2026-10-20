import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createMediaCompanion } from '../server.mjs';
import { isBlockedAddress } from '../security.mjs';

const SOURCE_HEADERS = { Authorization: 'Bearer fixture-secret' };

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  return `http://${host}:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
}

async function setup(t, sourceHandler, options = {}) {
  const source = http.createServer(sourceHandler);
  const sourceBase = await listen(source);
  const companion = createMediaCompanion({
    host: '127.0.0.1',
    port: 0,
    controlToken: 'test-control-token-0123456789abcdef',
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: ['https://player.example'],
    sessionTimeoutMs: 60_000,
    sweepIntervalMs: 10_000,
    requestTimeoutMs: 5_000,
    ...options,
  });
  const address = await companion.listen();
  t.after(async () => {
    await companion.close();
    await closeServer(source);
  });
  return { companion, source, sourceBase, base: `http://127.0.0.1:${address.port}` };
}

function auth(companion, extra = {}) {
  return {
    Authorization: `Bearer ${companion.pairingToken}`,
    ...extra,
  };
}

async function jsonRequest(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

async function createSession(companion, base, sourceUrl, body = {}) {
  return jsonRequest(base, '/api/sessions', {
    method: 'POST',
    headers: auth(companion, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ url: sourceUrl, ...body }),
  });
}

test('control API requires the process pairing bearer token', async (t) => {
  const { companion, base } = await setup(t, (_req, res) => res.end('fixture'));

  const denied = await jsonRequest(base, '/api/capabilities');
  assert.equal(denied.response.status, 401);

  const allowed = await jsonRequest(base, '/api/capabilities', {
    headers: auth(companion),
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.body.privateOnly, true);
  assert.equal(allowed.body.session.max, 2);
});

test('control and media routes enforce the exact configured browser origin', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'));

  const denied = await jsonRequest(base, '/api/capabilities', {
    headers: auth(companion, { Origin: 'https://attacker.example' }),
  });
  assert.equal(denied.response.status, 403);

  const preflight = await fetch(`${base}/api/sessions`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://player.example',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://player.example');

  const created = await createSession(companion, base, `${sourceBase}/media`);
  assert.equal(created.response.status, 201);
  const blocked = await fetch(created.body.mediaUrl, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(blocked.status, 403);
});

test('session media is reachable without placing source credentials in browser URLs', async (t) => {
  let authorization;
  const { companion, base, sourceBase } = await setup(t, (req, res) => {
    authorization = req.headers.authorization;
    res.setHeader('Content-Type', 'video/mp2t');
    res.end('transport-stream');
  });

  const created = await createSession(companion, base, `${sourceBase}/path?username=fixture&password=private`, {
    headers: SOURCE_HEADERS,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.mediaUrl.includes('private'), false);
  assert.equal(created.body.mediaUrl.includes('fixture-secret'), false);
  assert.equal(created.body.mediaUrl.includes('capability='), false);
  const sessionJson = JSON.stringify(created.body);
  assert.equal(sessionJson.includes('username=fixture'), false);
  assert.equal(sessionJson.includes('password=private'), false);
  assert.equal(sessionJson.includes('fixture-secret'), false);

  const media = await fetch(created.body.mediaUrl);
  assert.equal(await media.text(), 'transport-stream');
  assert.equal(authorization, 'Bearer fixture-secret');
});

test('malformed URL credentials are rejected without returning their content', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('unused'));
  const malformed = sourceBase.replace('http://', 'http://user%ZZ:secret@');
  const created = await createSession(companion, base, `${malformed}/media`);
  assert.equal(created.response.status, 400);
  assert.deepEqual(created.body, { error: 'invalid_url_credentials' });
  assert.equal(JSON.stringify(created.body).includes('secret'), false);
});

test('HLS child resources are rewritten to scoped opaque paths', async (t) => {
  let segmentAuthorization;
  const { companion, base, sourceBase } = await setup(t, (req, res) => {
    if (req.url.startsWith('/index.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:2,\nsegment.ts?token=fixture-private\n#EXT-X-ENDLIST\n');
      return;
    }
    segmentAuthorization = req.headers.authorization;
    res.setHeader('Content-Type', 'video/mp2t');
    res.end('segment-data');
  });

  const created = await createSession(companion, base, `${sourceBase}/index.m3u8`, { headers: SOURCE_HEADERS });
  assert.equal(created.response.status, 201);
  const playlistResponse = await fetch(created.body.mediaUrl);
  const playlist = await playlistResponse.text();
  const repeated = await (await fetch(created.body.mediaUrl)).text();
  assert.match(playlist, /\/media\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/);
  assert.equal(repeated, playlist);
  assert.equal(playlist.includes('fixture-private'), false);

  const childUrl = new URL(playlist.split('\n').find((line) => line.includes('/media/')));
  const segment = await fetch(childUrl);
  assert.equal(await segment.text(), 'segment-data');
  assert.equal(segmentAuthorization, 'Bearer fixture-secret');
});

test('cross-origin HLS children do not receive source or URL credentials', async (t) => {
  let childHeaders;
  const child = http.createServer((req, res) => {
    childHeaders = req.headers;
    res.setHeader('Content-Type', 'video/mp2t');
    res.end('child-segment');
  });
  const childBase = await listen(child);
  t.after(() => closeServer(child));

  const { companion, base, sourceBase } = await setup(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(`#EXTM3U\n#EXTINF:2,\n${childBase.replace('http://', 'http://child-user:child-secret@')}/segment.ts\n#EXT-X-ENDLIST\n`);
  });
  const created = await createSession(companion, base, `${sourceBase}/index.m3u8`, {
    headers: { ...SOURCE_HEADERS, 'X-API-Key': 'fixture-api-key', Cookie: 'fixture-cookie' },
  });
  const playlist = await (await fetch(created.body.mediaUrl)).text();
  assert.equal(playlist.includes('child-user'), false);
  assert.equal(playlist.includes('child-secret'), false);
  const childPath = playlist.split(/\r?\n/).find((line) => line.includes('/media/'));
  await (await fetch(new URL(childPath))).text();
  assert.equal(childHeaders.authorization, undefined);
  assert.equal(childHeaders.cookie, undefined);
  assert.equal(childHeaders['x-api-key'], undefined);
});

test('byte ranges stream through with the upstream partial-content headers', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (req, res) => {
    assert.equal(req.headers.range, 'bytes=2-5');
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Range': 'bytes 2-5/10',
      'Accept-Ranges': 'bytes',
      'Content-Length': '4',
    });
    res.end('2345');
  });

  const created = await createSession(companion, base, `${sourceBase}/movie.mp4`);
  const response = await fetch(created.body.mediaUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await response.text(), '2345');
});

test('redirects are revalidated and source credentials are stripped across origins', async (t) => {
  let redirectedHeaders;
  const redirectTarget = http.createServer((req, res) => {
    redirectedHeaders = req.headers;
    res.end('redirected-media');
  });
  const redirectBase = await listen(redirectTarget);
  t.after(() => closeServer(redirectTarget));

  const { companion, base, sourceBase } = await setup(t, (req, res) => {
    res.writeHead(302, { Location: `${redirectBase}/target` });
    res.end();
  }, { allowedHosts: ['127.0.0.1'] });

  const created = await createSession(companion, base, `${sourceBase}/redirect`, {
    headers: { ...SOURCE_HEADERS, Cookie: 'fixture-cookie', 'X-API-Key': 'fixture-api-key' },
  });
  const response = await fetch(created.body.mediaUrl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'redirected-media');
  assert.equal(redirectedHeaders.authorization, undefined);
  assert.equal(redirectedHeaders.cookie, undefined);
  assert.equal(redirectedHeaders['x-api-key'], undefined);
});

test('a redirect to a destination outside the source host allowlist is rejected', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => {
    res.writeHead(302, { Location: 'http://example.com/should-not-be-requested' });
    res.end();
  });

  const created = await createSession(companion, base, `${sourceBase}/redirect`);
  const response = await fetch(created.body.mediaUrl);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'upstream_destination_blocked' });
});

test('unlisted public destinations cannot be created even with control access', async (t) => {
  const { companion, base } = await setup(t, (_req, res) => res.end('unused'));
  const created = await createSession(companion, base, 'https://example.com/video.m3u8');
  assert.equal(created.response.status, 403);
  assert.deepEqual(created.body, { error: 'destination_not_allowed' });
});

test('an exact allowlist entry permits a public media endpoint without changing private audience', async (t) => {
  const { companion, base } = await setup(t, (_req, res) => res.end('unused'), {
    allowedHosts: ['8.8.8.8'],
  });
  const created = await createSession(companion, base, 'https://8.8.8.8/channel.ts');
  assert.equal(created.response.status, 201);
  assert.equal(created.body.format, 'progressive');
  const capabilities = await jsonRequest(base, '/api/capabilities', { headers: auth(companion) });
  assert.equal(capabilities.body.privateOnly, true);
  assert.equal(capabilities.body.audience, 'private-single-owner');
  await jsonRequest(base, `/api/sessions/${created.body.id}`, {
    method: 'DELETE',
    headers: auth(companion),
  });
});

test('metadata, link-local, multicast, and reserved source addresses remain blocked', () => {
  for (const address of [
    '0.0.0.0', '169.254.169.254', '224.0.0.1', '192.0.2.1', '255.255.255.255',
    '::', 'fe80::1', 'ff02::1', '2001:db8::1', 'fd00:ec2::254',
    '2001:1::1', '2002:a9fe:a9fe::1', '64:ff9b::a9fe:a9fe', '3fff::1',
  ]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
});

test('deleting a session aborts active upstream requests immediately', async (t) => {
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  let requestClosed;
  const closed = new Promise((resolve) => { requestClosed = resolve; });
  const { companion, base, sourceBase } = await setup(t, (req, res) => {
    requestStarted();
    req.socket.once('close', requestClosed);
    res.on('close', () => {});
    // Deliberately never respond. Session deletion must destroy the client socket.
  });

  const created = await createSession(companion, base, `${sourceBase}/slow`);
  const mediaRequest = http.get(created.body.mediaUrl);
  mediaRequest.on('error', () => {});
  await started;
  const deleted = await jsonRequest(base, `/api/sessions/${created.body.id}`, {
    method: 'DELETE',
    headers: auth(companion),
  });
  assert.equal(deleted.response.status, 204);
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stayed open')), 500)),
  ]);
});

test('sessions expire without heartbeat and return capacity on close', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'), {
    sessionTimeoutMs: 90,
    sweepIntervalMs: 10,
    maxSessions: 1,
  });

  const first = await createSession(companion, base, `${sourceBase}/first`);
  assert.equal(first.response.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 130));
  const expiredStatus = await jsonRequest(base, `/api/sessions/${first.body.id}`, { headers: auth(companion) });
  assert.equal(expiredStatus.response.status, 404);

  const second = await createSession(companion, base, `${sourceBase}/second`);
  assert.equal(second.response.status, 201);
});

test('session capacity is bounded and DELETE releases it immediately', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'));
  const first = await createSession(companion, base, `${sourceBase}/one`);
  const second = await createSession(companion, base, `${sourceBase}/two`);
  assert.equal(first.response.status, 201);
  assert.equal(second.response.status, 201);

  const full = await createSession(companion, base, `${sourceBase}/three`);
  assert.equal(full.response.status, 409);
  assert.deepEqual(full.body, { error: 'session_capacity_reached' });

  const removed = await jsonRequest(base, `/api/sessions/${first.body.id}`, {
    method: 'DELETE',
    headers: auth(companion),
  });
  assert.equal(removed.response.status, 204);
  const replacement = await createSession(companion, base, `${sourceBase}/replacement`);
  assert.equal(replacement.response.status, 201);
});

test('conversion requires server and client opt-in', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'));
  const noRequestOptIn = await createSession(companion, base, `${sourceBase}/input`, { mode: 'convert' });
  assert.equal(noRequestOptIn.response.status, 400);
  assert.deepEqual(noRequestOptIn.body, { error: 'conversion_opt_in_required' });

  const serverDisabled = await createSession(companion, base, `${sourceBase}/input`, {
    mode: 'convert', allowConversion: true,
  });
  assert.equal(serverDisabled.response.status, 403);
  assert.deepEqual(serverDisabled.body, { error: 'conversion_disabled' });
});

test('unimplemented explicit track selection is rejected instead of silently dropped', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'));
  const selectedSubtitle = await createSession(companion, base, `${sourceBase}/input`, {
    mode: 'convert', allowConversion: true, subtitleTrack: 2,
  });
  assert.equal(selectedSubtitle.response.status, 400);
  assert.deepEqual(selectedSubtitle.body, { error: 'track_selection_unsupported' });
});

test('proxy and live sessions reject unsupported start-time seeking', async (t) => {
  const { companion, base, sourceBase } = await setup(t, (_req, res) => res.end('fixture'));
  const proxySeek = await createSession(companion, base, `${sourceBase}/input`, { startTime: 5 });
  assert.equal(proxySeek.response.status, 400);
  assert.deepEqual(proxySeek.body, { error: 'seek_requires_processing' });

  const liveSeek = await createSession(companion, base, `${sourceBase}/input`, {
    isLive: true, mode: 'remux', startTime: 5,
  });
  assert.equal(liveSeek.response.status, 400);
  assert.deepEqual(liveSeek.body, { error: 'live_seek_unsupported' });
});

test('remote binds require trusted HTTPS proxy settings and a browser-facing HTTPS origin', () => {
  const baseOptions = {
    host: '0.0.0.0',
    port: 4321,
    controlToken: 'remote-test-token-0123456789abcdef',
    trustedHttpsProxy: true,
    allowedOrigins: ['https://player.example'],
  };
  assert.throws(() => createMediaCompanion(baseOptions), /PUBLIC_BASE_URL/);
  assert.throws(() => createMediaCompanion({ ...baseOptions, publicBaseUrl: 'http://media.example' }), /HTTPS/);
  assert.throws(() => createMediaCompanion({ ...baseOptions, publicBaseUrl: 'https://media.example/path' }), /without a path/);
  const companion = createMediaCompanion({ ...baseOptions, publicBaseUrl: 'https://media.example' });
  return companion.close();
});
