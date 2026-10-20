import http from 'node:http';
import https from 'node:https';
import { stripCrossOriginCredentials, validateAllowedDestination, urlOrigin } from './security.mjs';

const MAX_REDIRECTS = 3;

function pinnedLookup(address) {
  return (_hostname, options, callback) => {
    if (options?.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function requestOnce(url, headers, method, address, signal, requestTimeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const request = transport.request({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: pinnedLookup(address),
      timeout: requestTimeoutMs,
      signal,
    });
    onRequest(request);
    request.once('response', (response) => resolve(response));
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('upstream timeout')));
    request.end();
  });
}

export async function requestPrivateResource({
  url: inputUrl,
  headers: inputHeaders,
  method = 'GET',
  rangeHeaders = {},
  session,
  signal,
  allowedHosts,
  requestTimeoutMs,
}) {
  let url = new URL(inputUrl);
  let headers = { ...inputHeaders, ...rangeHeaders };
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const address = await validateAllowedDestination(url, allowedHosts);
    const response = await requestOnce(
      url,
      headers,
      method,
      address,
      signal,
      requestTimeoutMs,
      (request) => {
        session.activeRequests.add(request);
        const remove = () => session.activeRequests.delete(request);
        request.once('close', remove);
        request.once('error', remove);
      },
    );
    const status = response.statusCode ?? 502;
    const location = response.headers.location;
    if (status < 300 || status >= 400 || !location) {
      response.once('end', () => {});
      return { response, finalUrl: url, finalHeaders: headers };
    }

    await new Promise((resolve, reject) => {
      response.once('end', resolve);
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('upstream redirect body aborted')));
      response.resume();
    });
    if (redirect === MAX_REDIRECTS) throw Object.assign(new Error('too many redirects'), { code: 'too_many_redirects' });
    let nextUrl;
    try {
      nextUrl = new URL(location, url);
    } catch {
      throw Object.assign(new Error('invalid redirect'), { code: 'invalid_redirect' });
    }
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
      throw Object.assign(new Error('unsupported redirect scheme'), { code: 'destination_blocked' });
    }
    if (nextUrl.username || nextUrl.password) {
      throw Object.assign(new Error('redirect userinfo is not allowed'), { code: 'destination_blocked' });
    }
    if (urlOrigin(url) !== urlOrigin(nextUrl)) {
      headers = stripCrossOriginCredentials(headers);
    }
    url = nextUrl;
  }
  throw Object.assign(new Error('too many redirects'), { code: 'too_many_redirects' });
}

export function incomingRangeHeaders(request) {
  const headers = {};
  for (const name of ['range', 'if-range', 'if-none-match', 'if-modified-since']) {
    const value = request.headers[name];
    if (typeof value === 'string' && !/[\r\n\0]/.test(value)) headers[name] = value;
  }
  return headers;
}

export function copyMediaHeaders(upstreamHeaders, response) {
  for (const name of [
    'accept-ranges', 'cache-control', 'content-length', 'content-range', 'content-type',
    'etag', 'last-modified', 'expires',
  ]) {
    const value = upstreamHeaders[name];
    if (typeof value === 'string') response.setHeader(name, value);
  }
  response.setHeader('X-Content-Type-Options', 'nosniff');
}
