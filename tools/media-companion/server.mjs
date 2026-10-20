import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CompanionError,
  normalizeHost,
  normalizeSourceHeaders,
  parseExactHosts,
  parseExactOrigins,
  parseHttpUrl,
  removeUrlCredentials,
  stripCrossOriginCredentials,
  urlOrigin,
  validateAllowedDestination,
} from './security.mjs';
import {
  buildConversionArgs,
  buildRemuxArgs,
  inspectFfmpeg,
  probeMedia,
  spawnManaged,
  stopChild,
} from './ffmpeg.mjs';
import {
  copyMediaHeaders,
  incomingRangeHeaders,
  requestPrivateResource,
} from './upstream.mjs';

const DEFAULT_SESSION_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SESSION_RESOURCES = 4096;
const SCOPED_TOKEN_BYTES = 32;

function newToken(bytes = SCOPED_TOKEN_BYTES) {
  return randomBytes(bytes).toString('base64url');
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  return normalized === 'localhost'
    || normalized === '::1'
    || (isIP(normalized) === 4 && Number(normalized.split('.')[0]) === 127);
}

function normalizeOptions(options) {
  const env = options.env ?? process.env;
  const host = options.host ?? env.MEDIA_COMPANION_HOST ?? '127.0.0.1';
  const port = options.port ?? parsePositiveInteger(env.MEDIA_COMPANION_PORT, 4321);
  const allowedHosts = options.allowedHosts
    ? new Set(options.allowedHosts.map(normalizeHost))
    : parseExactHosts(env.MEDIA_COMPANION_ALLOWED_HOSTS);
  const allowedOrigins = options.allowedOrigins
    ? new Set(options.allowedOrigins)
    : parseExactOrigins(env.MEDIA_COMPANION_ALLOWED_ORIGINS);
  const trustedHttpsProxy = options.trustedHttpsProxy ?? env.MEDIA_COMPANION_TRUSTED_HTTPS_PROXY === '1';
  const enableConversion = options.enableConversion ?? env.MEDIA_COMPANION_ENABLE_CONVERSION === '1';
  const controlToken = options.controlToken ?? env.MEDIA_COMPANION_TOKEN ?? newToken();
  if (typeof controlToken !== 'string' || Buffer.byteLength(controlToken) < 24) {
    throw new Error('MEDIA_COMPANION_TOKEN must contain at least 24 bytes');
  }
  if (!isLoopbackHost(host)) {
    if (!trustedHttpsProxy) throw new Error('Non-loopback binding requires MEDIA_COMPANION_TRUSTED_HTTPS_PROXY=1');
    if (!allowedOrigins.size) throw new Error('Non-loopback binding requires MEDIA_COMPANION_ALLOWED_ORIGINS');
  }
  const publicBaseUrl = options.publicBaseUrl ?? env.MEDIA_COMPANION_PUBLIC_BASE_URL ?? null;
  if (publicBaseUrl) {
    const parsed = new URL(publicBaseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Public base URL must use HTTP or HTTPS');
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Public base URL must not include credentials, query, or fragment');
    if (parsed.pathname !== '/') throw new Error('Public base URL must be an origin without a path');
    if (!isLoopbackHost(host) && parsed.protocol !== 'https:') throw new Error('Remote public base URL must use HTTPS');
  }
  if (!isLoopbackHost(host) && !publicBaseUrl) {
    throw new Error('Remote binding requires MEDIA_COMPANION_PUBLIC_BASE_URL for HTTPS media URLs');
  }
  return {
    host,
    port,
    allowedHosts,
    allowedOrigins,
    controlToken,
    enableConversion,
    ffmpegPath: options.ffmpegPath ?? env.MEDIA_COMPANION_FFMPEG ?? 'ffmpeg',
    ffprobePath: options.ffprobePath ?? env.MEDIA_COMPANION_FFPROBE ?? 'ffprobe',
    sessionTimeoutMs: options.sessionTimeoutMs ?? parsePositiveInteger(env.MEDIA_COMPANION_SESSION_TIMEOUT_MS, DEFAULT_SESSION_TIMEOUT_MS),
    requestTimeoutMs: options.requestTimeoutMs ?? parsePositiveInteger(env.MEDIA_COMPANION_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    sweepIntervalMs: options.sweepIntervalMs ?? 1_000,
    maxSessions: Math.min(2, Math.max(1, options.maxSessions ?? 2)),
    readyTimeoutMs: options.readyTimeoutMs ?? 15_000,
    tempRoot: options.tempRoot ?? os.tmpdir(),
    publicBaseUrl,
    remoteBinding: !isLoopbackHost(host),
  };
}

function sendJson(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new CompanionError(413, 'request_body_too_large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new CompanionError(400, 'invalid_json'));
      }
    });
  });
}

function bearerMatches(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function originHeaders(request, response, allowedOrigins) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges,Content-Length,Content-Range,Content-Type,ETag,Last-Modified');
  return true;
}

function mediaPath(baseUrl, capability, resourceId, suffix = '') {
  return `${baseUrl}/media/${capability}/${resourceId}${suffix}`;
}

function sourceMediaHints(url) {
  const extension = path.extname(url.pathname).toLowerCase();
  if (extension === '.m3u8') return { format: 'hls', container: 'unknown' };
  if (extension === '.mp4' || extension === '.m4v') return { format: 'progressive', container: 'mp4' };
  if (extension === '.mkv') return { format: 'progressive', container: 'matroska' };
  if (extension === '.ts' || extension === '.mts' || extension === '.m2ts') return { format: 'progressive', container: 'mpegts' };
  if (extension === '.mp3') return { format: 'progressive', container: 'mp3' };
  if (extension === '.m4a') return { format: 'progressive', container: 'm4a' };
  if (extension === '.aac') return { format: 'progressive', container: 'aac' };
  return { format: 'unknown', container: 'unknown' };
}

function safeError(error) {
  if (error instanceof CompanionError) return { status: error.status, code: error.code };
  if (error?.code === 'destination_not_allowed' || error?.code === 'destination_blocked') {
    return { status: 502, code: 'upstream_destination_blocked' };
  }
  if (error?.code === 'too_many_redirects' || error?.code === 'invalid_redirect') {
    return { status: 502, code: error.code };
  }
  return { status: 502, code: 'upstream_unavailable' };
}

function isPlaylist(contentType, url) {
  return /mpegurl|x-mpegurl/i.test(contentType ?? '') || url.pathname.toLowerCase().endsWith('.m3u8');
}

async function readLimited(response, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      response.destroy();
      throw new CompanionError(502, 'manifest_too_large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fileExists(filePath) {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

async function updateDurationFromPlaylist(session) {
  if (session.isLive || session.durationSeconds !== null || !session.outputDir) return;
  try {
    const playlist = await readFile(path.join(session.outputDir, 'index.m3u8'), 'utf8');
    if (!playlist.includes('#EXT-X-ENDLIST')) return;
    const durations = [...playlist.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm)]
      .map((match) => Number(match[1]));
    const generatedDuration = durations.reduce((total, duration) => total + duration, 0);
    if (Number.isFinite(generatedDuration) && generatedDuration > 0) {
      session.durationSeconds = session.startTime + generatedDuration;
    }
  } catch {
    // The playlist may still be written or removed during session cleanup.
  }
}

function actualAudioOnly(streams) {
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
  const hasVideo = streams.some((stream) => stream.codec_type === 'video');
  return hasAudio && !hasVideo;
}

export function createMediaCompanion(rawOptions = {}) {
  const config = normalizeOptions(rawOptions);
  const sessions = new Map();
  const capabilities = new Map();
  const conversionSessions = new Set();
  let creationReservations = 0;
  let conversionReserved = false;
  let capabilityPromise;
  let remuxCapabilityPromise;
  let sweepTimer;
  let listenAddress;
  let isClosing = false;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (response.destroyed || response.writableEnded) return;
      const result = safeError(error);
      sendJson(response, result.status, { error: result.code });
    });
  });

  async function getFfmpegCapabilities() {
    capabilityPromise ??= inspectFfmpeg({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      enableConversion: config.enableConversion,
    });
    return capabilityPromise;
  }

  async function getRemuxCapabilities() {
    remuxCapabilityPromise ??= inspectFfmpeg({
      ffmpegPath: config.ffmpegPath,
      ffprobePath: config.ffprobePath,
      enableConversion: false,
    });
    return remuxCapabilityPromise;
  }

  function baseUrl() {
    if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '');
    const address = listenAddress;
    const port = address?.port ?? config.port;
    const host = normalizeHost(config.host);
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${formattedHost}:${port}`;
  }

  function newSession(body, parsedSourceUrl, sourceHeaders) {
    const now = Date.now();
    const id = newToken(18);
    const capability = newToken();
    const rootId = newToken(18);
    const session = {
      id,
      capability,
      rootId,
      mode: body.mode ?? 'proxy',
      isLive: body.isLive === true,
      startTime: body.startTime ?? 0,
      audioOnly: null,
      audioFirst: body.audioOnly === true || body.audioFirst === true,
      sourceHints: sourceMediaHints(parsedSourceUrl),
      status: body.mode === 'proxy' || body.mode === undefined ? 'ready' : 'starting',
      createdAt: now,
      lastHeartbeatAt: now,
      activeRequests: new Set(),
      controllers: new Set(),
      children: new Set(),
      processController: new AbortController(),
      resources: new Map(),
      resourceIndex: new Map(),
      closed: false,
      closePromise: null,
      outputDir: null,
      processTask: null,
      processError: null,
      tracks: null,
      durationSeconds: null,
      encoderMode: null,
      videoEncoder: null,
      limitations: body.mode === 'remux'
        ? ['FFmpeg stream copy retains mapped tracks when the selected HLS muxer supports their codecs; unsupported subtitle codecs cause remux to fail rather than being silently dropped.']
        : body.mode === 'convert'
          ? ['Conversion selects the first audio and video tracks; subtitle and alternate tracks are omitted. HDR conversion requires verified zscale and tonemap filters.']
          : [],
    };
    const resourceUrl = removeUrlCredentials(parsedSourceUrl);
    const resourceHeaders = normalizeSourceHeaders(sourceHeaders, resourceUrl.authorization);
    session.resources.set(rootId, { kind: 'remote', url: resourceUrl.url, headers: resourceHeaders });
    sessions.set(id, session);
    capabilities.set(capability, session);
    return session;
  }

  function describeSession(session) {
    const url = session.mode === 'proxy'
      ? mediaPath(baseUrl(), session.capability, session.rootId)
      : mediaPath(baseUrl(), session.capability, session.rootId, '/out/index.m3u8');
    return {
      id: session.id,
      mode: session.mode,
      processingMode: session.mode,
      status: session.status,
      format: session.mode === 'proxy' ? session.sourceHints.format : 'hls',
      container: session.mode === 'proxy'
        ? session.sourceHints.container
        : 'hls',
      sourceFormatHint: session.sourceHints.format,
      sourceContainerHint: session.sourceHints.container,
      startTime: session.startTime,
      timelineOffsetSeconds: session.mode !== 'proxy' && !session.isLive ? session.startTime : 0,
      durationSeconds: session.durationSeconds,
      encoderMode: session.encoderMode,
      videoEncoder: session.videoEncoder,
      audioOnly: session.audioOnly ?? undefined,
      audioFirst: session.audioFirst,
      url,
      mediaUrl: url,
      createdAt: new Date(session.createdAt).toISOString(),
      lastHeartbeatAt: new Date(session.lastHeartbeatAt).toISOString(),
      expiresAt: new Date(session.lastHeartbeatAt + config.sessionTimeoutMs).toISOString(),
      heartbeatIntervalMs: Math.min(15_000, Math.max(1_000, Math.floor(config.sessionTimeoutMs / 3))),
      tracks: session.tracks,
      limitations: session.limitations,
      error: session.processError,
    };
  }

  function getSessionById(id) {
    const session = sessions.get(id);
    if (!session || session.closed) return null;
    if (Date.now() - session.lastHeartbeatAt >= config.sessionTimeoutMs) {
      void closeSession(session);
      return null;
    }
    return session;
  }

  function getSessionByCapability(capability) {
    const session = capabilities.get(capability);
    if (!session || session.closed) return null;
    if (Date.now() - session.lastHeartbeatAt >= config.sessionTimeoutMs) {
      void closeSession(session);
      return null;
    }
    return session;
  }

  async function closeSession(session) {
    if (session.closePromise) return session.closePromise;
    session.closed = true;
    sessions.delete(session.id);
    capabilities.delete(session.capability);
    conversionSessions.delete(session.id);
    session.closePromise = (async () => {
      for (const controller of session.controllers) controller.abort();
      session.controllers.clear();
      session.processController.abort();
      for (const request of session.activeRequests) request.destroy();
      session.activeRequests.clear();
      const children = [...session.children];
      await Promise.all(children.map((child) => stopChild(child)));
      if (session.outputDir) await rm(session.outputDir, { recursive: true, force: true });
      session.resources.clear();
      session.resourceIndex.clear();
    })();
    return session.closePromise;
  }

  function internalMediaUrl(session) {
    const host = isLoopbackHost(config.host) ? config.host : '127.0.0.1';
    const formattedHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `http://${formattedHost}:${listenAddress.port}/media/${session.capability}/${session.rootId}`;
  }

  async function failGeneratedSession(session, publicCode) {
    session.status = 'failed';
    session.processError = publicCode;
    conversionSessions.delete(session.id);
    for (const child of [...session.children]) await stopChild(child);
    if (session.outputDir) await rm(session.outputDir, { recursive: true, force: true });
    session.outputDir = null;
  }

  async function runGeneratedSession(session) {
    try {
      const capabilitiesNow = session.mode === 'convert'
        ? await getFfmpegCapabilities()
        : await getRemuxCapabilities();
      if (session.closed) return;
      if (!capabilitiesNow.ffmpeg || (session.mode === 'convert' && !capabilitiesNow.convert.available)) {
        await failGeneratedSession(session, session.mode === 'convert'
          ? capabilitiesNow.convert.reason ?? 'converter_unavailable'
          : 'ffmpeg_unavailable');
        return;
      }
      if (session.mode === 'convert' && !capabilitiesNow.convert.enabled) {
        await failGeneratedSession(session, 'conversion_disabled');
        return;
      }

      session.outputDir = await mkdtemp(path.join(config.tempRoot, 'media-companion-'));
      if (session.closed) {
        await rm(session.outputDir, { recursive: true, force: true });
        session.outputDir = null;
        return;
      }
      let streams;
      if (session.mode === 'convert') {
        streams = await probeMedia(config.ffprobePath, internalMediaUrl(session), session.processController.signal);
        if (session.closed) return;
        session.durationSeconds = streams.durationSeconds;
        session.audioOnly = actualAudioOnly(streams);
        session.tracks = streams.map((stream) => ({
          type: stream.codec_type,
          codec: stream.codec_name,
          language: stream.tags?.language,
          pixelFormat: stream.pix_fmt,
          width: stream.width,
          height: stream.height,
          colorTransfer: stream.color_transfer,
        }));
        streams.hdrTonemapAvailable = capabilitiesNow.convert.hdrTonemap;
      }
      const options = {
        outputDir: session.outputDir,
        inputUrl: internalMediaUrl(session),
        isLive: session.isLive,
        startTime: session.startTime,
        audioOnly: session.audioFirst,
        streams,
        videoEncoder: capabilitiesNow.convert.videoEncoder ?? 'libx264',
      };
      const args = session.mode === 'convert' ? buildConversionArgs(options) : buildRemuxArgs(options);
      const { child, closed } = await spawnManaged(config.ffmpegPath, args, session);
      if (session.closed) {
        await stopChild(child);
        if (session.outputDir) await rm(session.outputDir, { recursive: true, force: true });
        return;
      }
      child.once('error', () => {
        if (!session.closed) void failGeneratedSession(session, 'ffmpeg_process_failed');
      });
      void closed.then(async ({ code }) => {
        if (session.closed || session.status === 'failed') return;
        if (code === 0 && await fileExists(path.join(session.outputDir, 'index.m3u8'))) {
          await updateDurationFromPlaylist(session);
          session.status = 'ready';
          conversionSessions.delete(session.id);
        } else if (code !== 0) {
          await failGeneratedSession(session, 'ffmpeg_process_failed');
        }
      });

      if (session.mode === 'remux' && !session.isLive && capabilitiesNow.ffprobe) {
        void probeMedia(config.ffprobePath, internalMediaUrl(session), session.processController.signal)
          .then((probe) => {
            if (!session.closed) {
              if (session.durationSeconds === null) session.durationSeconds = probe.durationSeconds;
              session.audioOnly = actualAudioOnly(probe);
            }
          })
          .catch(() => {});
      }

      const deadline = Date.now() + config.readyTimeoutMs;
      while (!session.closed && Date.now() < deadline) {
        if (await fileExists(path.join(session.outputDir, 'index.m3u8'))) {
          session.status = 'ready';
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!session.closed && session.status !== 'ready') {
        await failGeneratedSession(session, 'ffmpeg_output_not_ready');
      }
    } catch (error) {
      if (!session.closed) {
        await failGeneratedSession(session, error?.publicCode ?? error?.code ?? 'media_process_failed');
      }
    }
  }

  async function addRemoteResource(session, reference, baseUrlValue, inheritedHeaders, retainedResources) {
    const url = parseHttpUrl(new URL(reference, baseUrlValue).href);
    const normalized = removeUrlCredentials(url);
    const crossOrigin = urlOrigin(new URL(baseUrlValue)) !== urlOrigin(normalized.url);
    const headers = crossOrigin ? stripCrossOriginCredentials(inheritedHeaders) : { ...inheritedHeaders };
    if (!crossOrigin && normalized.authorization && !headers.authorization) {
      headers.authorization = normalized.authorization;
    }
    await validateAllowedDestination(normalized.url, config.allowedHosts);
    const canonicalHeaders = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
    const key = createHash('sha256').update(normalized.url.href).update('\0').update(JSON.stringify(canonicalHeaders)).digest('base64url');
    let id = session.resourceIndex.get(key);
    if (id) {
      const resource = session.resources.get(id);
      if (resource) {
        session.resources.delete(id);
        session.resources.set(id, resource);
        retainedResources?.add(id);
        return mediaPath(baseUrl(), session.capability, id);
      }
      session.resourceIndex.delete(key);
    }
    while (session.resources.size >= MAX_SESSION_RESOURCES) {
      const candidate = [...session.resources.entries()].find(([resourceId]) =>
        resourceId !== session.rootId && !retainedResources?.has(resourceId));
      if (!candidate) throw new CompanionError(502, 'resource_capacity_reached');
      const [evictedId, evicted] = candidate;
      session.resources.delete(evictedId);
      if (evicted.dedupKey) session.resourceIndex.delete(evicted.dedupKey);
    }
    id = newToken(18);
    session.resources.set(id, { kind: 'remote', url: normalized.url, headers, dedupKey: key });
    session.resourceIndex.set(key, id);
    retainedResources?.add(id);
    return mediaPath(baseUrl(), session.capability, id);
  }

  async function rewriteRemotePlaylist(session, body, finalUrl, headers, sourceResourceId) {
    const output = [];
    const retainedResources = new Set([session.rootId, sourceResourceId]);
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        output.push(line);
        continue;
      }
      if (trimmed.startsWith('#')) {
        let rewrittenLine = line;
        for (const match of [...line.matchAll(/URI=(['"])(.*?)\1/g)]) {
          const [, quote, uri] = match;
          const rewritten = await addRemoteResource(session, uri, finalUrl.href, headers, retainedResources);
          rewrittenLine = rewrittenLine.replace(match[0], `URI=${quote}${rewritten}${quote}`);
        }
        output.push(rewrittenLine);
        continue;
      }
      const leading = line.match(/^\s*/)?.[0] ?? '';
      const trailing = line.match(/\s*$/)?.[0] ?? '';
      output.push(`${leading}${await addRemoteResource(session, trimmed, finalUrl.href, headers, retainedResources)}${trailing}`);
    }
    return output.join('\n');
  }

  function rewriteOutputPlaylist(body, session) {
    return body.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const toOutputUrl = (value) => {
        const file = value.replaceAll('\\', '/').split('/').pop();
        if (!file || file === '.' || file === '..' || !/^[A-Za-z0-9._-]+$/.test(file)) {
          throw new CompanionError(502, 'invalid_generated_playlist');
        }
        return mediaPath(baseUrl(), session.capability, session.rootId, `/out/${encodeURIComponent(file)}`);
      };
      if (trimmed.startsWith('#')) {
        return line.replace(/URI=(['"])(.*?)\1/g, (_match, quote, uri) => `URI=${quote}${toOutputUrl(uri)}${quote}`);
      }
      const leading = line.match(/^\s*/)?.[0] ?? '';
      const trailing = line.match(/\s*$/)?.[0] ?? '';
      return `${leading}${toOutputUrl(trimmed)}${trailing}`;
    }).join('\n');
  }

  async function serveRemoteResource(request, response, session, resourceId, resource) {
    const controller = new AbortController();
    session.controllers.add(controller);
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', onClose);
    try {
      const upstream = await requestPrivateResource({
        url: resource.url,
        headers: resource.headers,
        method: request.method,
        rangeHeaders: incomingRangeHeaders(request),
        session,
        signal: controller.signal,
        allowedHosts: config.allowedHosts,
        requestTimeoutMs: config.requestTimeoutMs,
      });
      if (session.closed || response.destroyed) {
        upstream.response.destroy();
        return;
      }
      const status = upstream.response.statusCode ?? 502;
      if (request.method === 'HEAD') {
        copyMediaHeaders(upstream.response.headers, response);
        response.writeHead(status);
        response.end();
        upstream.response.resume();
        return;
      }
      if (isPlaylist(upstream.response.headers['content-type'], upstream.finalUrl)) {
        if (upstream.response.headers['content-encoding'] && upstream.response.headers['content-encoding'] !== 'identity') {
          upstream.response.destroy();
          throw new CompanionError(502, 'encoded_manifest_unsupported');
        }
        const text = await readLimited(upstream.response, MAX_MANIFEST_BYTES);
        const rewritten = await rewriteRemotePlaylist(session, text, upstream.finalUrl, upstream.finalHeaders, resourceId);
        response.writeHead(status, {
          'Content-Type': upstream.response.headers['content-type'] ?? 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        response.end(rewritten);
        return;
      }
      copyMediaHeaders(upstream.response.headers, response);
      response.writeHead(status);
      await pipeline(upstream.response, response, { signal: controller.signal });
    } catch (error) {
      if (!session.closed && !response.destroyed && !response.writableEnded) {
        const result = error instanceof CompanionError && error.code === 'destination_not_allowed'
          ? { status: 502, code: 'upstream_destination_blocked' }
          : safeError(error);
        sendJson(response, result.status, { error: result.code });
      }
    } finally {
      session.controllers.delete(controller);
      response.off('close', onClose);
    }
  }

  async function serveOutputResource(request, response, session, fileName) {
    if (session.status === 'failed') {
      sendJson(response, 502, { error: session.processError ?? 'media_process_failed' });
      return;
    }
    const outputRoot = session.outputDir;
    if (!outputRoot) {
      response.writeHead(503, { 'Retry-After': '1', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName === '.' || fileName === '..') {
      sendJson(response, 404, { error: 'resource_not_found' });
      return;
    }
    const filePath = path.join(outputRoot, fileName);
    const root = path.resolve(outputRoot) + path.sep;
    if (!path.resolve(filePath).startsWith(root)) {
      sendJson(response, 404, { error: 'resource_not_found' });
      return;
    }
    if (!await fileExists(filePath)) {
      response.writeHead(session.status === 'ready' ? 404 : 503, {
        'Retry-After': '1',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    if (fileName.endsWith('.m3u8')) {
      const body = await readFile(filePath, 'utf8');
      await updateDurationFromPlaylist(session);
      const rewritten = rewriteOutputPlaylist(body, session);
      response.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(rewritten),
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : rewritten);
      return;
    }
    const contentType = fileName.endsWith('.m4s') || fileName.endsWith('.mp4')
      ? 'video/mp4'
      : fileName.endsWith('.vtt')
        ? 'text/vtt; charset=utf-8'
        : 'video/mp2t';
    const details = await stat(filePath);
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': details.size,
      'Accept-Ranges': 'none',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(filePath), response);
  }

  async function serveMedia(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean);
    const [, capability, resourceId, section, fileName, ...extra] = segments;
    const session = getSessionByCapability(capability);
    if (!session) {
      sendJson(response, 404, { error: 'session_not_found' });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }
    if (section === 'out' && fileName && !extra.length && session.mode !== 'proxy') {
      await serveOutputResource(request, response, session, fileName);
      return;
    }
    if (section || fileName || extra.length) {
      sendJson(response, 404, { error: 'resource_not_found' });
      return;
    }
    const resource = session.resources.get(resourceId);
    if (!resource || resource.kind !== 'remote') {
      sendJson(response, 404, { error: 'resource_not_found' });
      return;
    }
    await serveRemoteResource(request, response, session, resourceId, resource);
  }

  async function createNewSession(request, response) {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CompanionError(400, 'invalid_request');
    const mode = body.mode ?? 'proxy';
    if (!['proxy', 'remux', 'convert'].includes(mode)) throw new CompanionError(400, 'invalid_mode');
    if (body.isLive !== undefined && typeof body.isLive !== 'boolean') throw new CompanionError(400, 'invalid_live_flag');
    if (body.audioOnly !== undefined && typeof body.audioOnly !== 'boolean') throw new CompanionError(400, 'invalid_audio_only_flag');
    if (body.audioFirst !== undefined && typeof body.audioFirst !== 'boolean') throw new CompanionError(400, 'invalid_audio_first_flag');
    if (body.subtitleTrack !== undefined || body.audioTrack !== undefined || body.videoTrack !== undefined || body.burnSubtitles === true) {
      throw new CompanionError(400, 'track_selection_unsupported');
    }
    const startTime = body.startTime === undefined ? 0 : Number(body.startTime);
    if (!Number.isFinite(startTime) || startTime < 0 || startTime > 86_400) throw new CompanionError(400, 'invalid_start_time');
    if (body.isLive === true && startTime > 0) throw new CompanionError(400, 'live_seek_unsupported');
    if (mode === 'proxy' && startTime > 0) throw new CompanionError(400, 'seek_requires_processing');
    if (mode !== 'convert' && (body.audioOnly === true || body.audioFirst === true)) throw new CompanionError(400, 'audio_first_requires_conversion');
    if (mode === 'convert' && body.allowConversion !== true) throw new CompanionError(400, 'conversion_opt_in_required');
    if (mode === 'convert' && !config.enableConversion) throw new CompanionError(403, 'conversion_disabled');
    if (sessions.size + creationReservations >= config.maxSessions) throw new CompanionError(409, 'session_capacity_reached');

    let hasCreationReservation = true;
    let hasConversionReservation = false;
    creationReservations += 1;
    if (mode === 'convert') {
      if (conversionReserved || conversionSessions.size >= 1) {
        creationReservations -= 1;
        hasCreationReservation = false;
        throw new CompanionError(409, 'conversion_busy');
      }
      conversionReserved = true;
      hasConversionReservation = true;
    }

    let conversionCapabilities;
    try {
      if (mode === 'convert') {
        conversionCapabilities = await getFfmpegCapabilities();
        if (!conversionCapabilities.convert.available) {
          sendJson(response, 503, {
            error: 'converter_unavailable',
            reason: conversionCapabilities.convert.reason ?? 'required_encoder_or_filter_unavailable',
          });
          return;
        }
      }
      const rawUrl = parseHttpUrl(body.url);
      const normalized = removeUrlCredentials(rawUrl);
      normalizeSourceHeaders(body.headers, normalized.authorization);
      await validateAllowedDestination(normalized.url, config.allowedHosts);
      const sessionBody = { ...body, mode, startTime };
      const session = newSession(sessionBody, rawUrl, body.headers);
      if (mode === 'convert') {
        session.encoderMode = conversionCapabilities.convert.encoderMode;
        session.videoEncoder = conversionCapabilities.convert.videoEncoder;
      }
      creationReservations -= 1;
      hasCreationReservation = false;
      if (mode === 'convert') {
        conversionSessions.add(session.id);
        conversionReserved = false;
        hasConversionReservation = false;
      }
      if (mode !== 'proxy') session.processTask = runGeneratedSession(session);
      response.once('close', () => {
        if (!response.writableFinished) void closeSession(session);
      });
      sendJson(response, 201, describeSession(session));
    } finally {
      if (hasCreationReservation) creationReservations -= 1;
      if (hasConversionReservation) conversionReserved = false;
    }
  }

  async function handleApi(request, response, url) {
    if (!bearerMatches(request, config.controlToken)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/capabilities') {
      const ffmpeg = await getFfmpegCapabilities();
      sendJson(response, 200, {
        version: 1,
        privateOnly: true,
        audience: 'private-single-owner',
        sourceHostPolicy: 'Exact allowlist; public and private sources are permitted, while metadata, link-local, multicast, and reserved ranges are blocked.',
        auth: { scheme: 'Bearer', pairingRequired: true },
        session: {
          active: sessions.size,
          max: config.maxSessions,
          heartbeatTimeoutMs: config.sessionTimeoutMs,
        },
        modes: {
          proxy: { available: true, byteRanges: true, hlsUriRewrite: true },
          remux: {
            available: ffmpeg.remux,
            output: 'HLS stream copy',
            audioSubtitleNote: 'Mapped tracks are retained when supported by the selected HLS muxer; unsupported track codecs fail visibly.',
          },
          convert: {
            enabled: ffmpeg.convert.enabled,
            available: ffmpeg.convert.available,
            reason: ffmpeg.convert.reason,
            hdrTonemap: ffmpeg.convert.hdrTonemap,
            videoEncoder: ffmpeg.convert.videoEncoder,
            encoderMode: ffmpeg.convert.encoderMode,
            softwareThreads: ffmpeg.convert.softwareThreads,
            audioFirst: true,
            seek: 'VOD conversion accepts startTime in seconds and returns timelineOffsetSeconds.',
            video: 'H.264 8-bit SDR, maximum 1920x1080, aspect preserved, no upscaling',
            audio: 'AAC, first audio track',
            concurrency: 1,
          },
        },
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      await createNewSession(request, response);
      return;
    }
    const match = url.pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)(?:\/(heartbeat))?$/);
    if (match) {
      const [, id, heartbeat] = match;
      const session = getSessionById(id);
      if (!session) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      if (heartbeat && request.method === 'POST') {
        session.lastHeartbeatAt = Date.now();
        sendJson(response, 200, describeSession(session));
        return;
      }
      if (!heartbeat && request.method === 'GET') {
        sendJson(response, 200, describeSession(session));
        return;
      }
      if (!heartbeat && request.method === 'DELETE') {
        await closeSession(session);
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
    }
    sendJson(response, 404, { error: 'not_found' });
  }

  async function handleRequest(request, response) {
    const originAllowed = originHeaders(request, response, config.allowedOrigins);
    if (!originAllowed) {
      sendJson(response, 403, { error: 'origin_not_allowed' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Range,Range',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
    } catch {
      sendJson(response, 400, { error: 'invalid_request_url' });
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      await serveMedia(request, response, url);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  }

  async function close() {
    if (isClosing) return;
    isClosing = true;
    if (sweepTimer) clearInterval(sweepTimer);
    await Promise.all([...sessions.values()].map((session) => closeSession(session)));
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  async function listen() {
    if (server.listening) return listenAddress;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    listenAddress = server.address();
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const session of sessions.values()) {
        if (now - session.lastHeartbeatAt >= config.sessionTimeoutMs) void closeSession(session);
      }
    }, Math.min(config.sweepIntervalMs, config.sessionTimeoutMs));
    sweepTimer.unref?.();
    return listenAddress;
  }

  return {
    server,
    pairingToken: config.controlToken,
    listen,
    close,
    get activeSessions() { return sessions.size; },
  };
}

async function main() {
  const companion = createMediaCompanion();
  const address = await companion.listen();
  const bindHost = address.address.includes(':') ? `[${address.address}]` : address.address;
  process.stdout.write(`Media companion listening on http://${bindHost}:${address.port}\n`);
  process.stdout.write(`Pairing bearer token: ${companion.pairingToken}\n`);
  process.stdout.write('Configure MEDIA_COMPANION_ALLOWED_HOSTS with exact provider or private LAN source hosts before use.\n');
  const stop = async () => {
    await companion.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) void main();

