import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createMediaCompanion } from '../server.mjs';

const fixturePath = process.env.MEDIA_COMPANION_TEST_MEDIA;
const ffmpegPath = process.env.MEDIA_COMPANION_TEST_FFMPEG ?? 'ffmpeg';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  server.close();
  await once(server, 'close');
}

test('real FFmpeg stream-copy remux produces a playable local HLS segment', {
  skip: !fixturePath && 'Set MEDIA_COMPANION_TEST_MEDIA to a local MPEG-TS fixture to run this integration check',
}, async (t) => {
  const source = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'video/mp2t');
    createReadStream(fixturePath).pipe(response);
  });
  const sourceBase = await listen(source);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'media-companion-test-'));
  const companion = createMediaCompanion({
    host: '127.0.0.1',
    port: 0,
    controlToken: 'integration-token-0123456789abcdef',
    allowedHosts: ['127.0.0.1'],
    allowedOrigins: [],
    ffmpegPath,
    ffprobePath: '/media-companion-test-no-ffprobe',
    tempRoot,
    readyTimeoutMs: 20_000,
  });
  const address = await companion.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await companion.close();
    await closeServer(source);
    await rm(tempRoot, { recursive: true, force: true });
  });

  const headers = {
    Authorization: `Bearer ${companion.pairingToken}`,
    'Content-Type': 'application/json',
  };
  const createdResponse = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: `${sourceBase}/fixture.ts`, mode: 'remux' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();

  let status;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/sessions/${created.id}`, { headers });
    status = await response.json();
    if (status.status === 'failed' || status.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(status?.status, 'ready', status?.error ?? 'remux did not become ready');

  const playlistResponse = await fetch(created.mediaUrl);
  const playlist = await playlistResponse.text();
  assert.match(playlist, /^#EXTM3U/m);
  const segmentPath = playlist.split(/\r?\n/).find((line) => line.includes('/out/segment_'));
  assert.ok(segmentPath, 'generated playlist references an HLS segment');
  const segmentResponse = await fetch(new URL(segmentPath));
  assert.equal(segmentResponse.status, 200);
  assert.ok((await segmentResponse.arrayBuffer()).byteLength > 188);

  const deleted = await fetch(`${base}/api/sessions/${created.id}`, {
    method: 'DELETE',
    headers: { Authorization: headers.Authorization },
  });
  assert.equal(deleted.status, 204);
  assert.deepEqual(await readdir(tempRoot), []);
});
