import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class CompanionError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function normalizeHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function expandIpv6(address) {
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = value.slice(lastColon + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const [leftText, rightText = ''] = value.split('::');
  const left = leftText ? leftText.split(':') : [];
  const right = rightText ? rightText.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!value.includes('::') && missing !== 0)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => Number.parseInt(part, 16));
}

function ipv4IsBlocked(octets) {
  const [a, b, c, d] = octets;
  return a === 0
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
    || (a === 255 && b === 255 && c === 255 && d === 255);
}

export function isBlockedAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    return ipv4IsBlocked(octets);
  }
  if (family !== 6) return false;

  const parts = expandIpv6(address);
  if (!parts) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    return ipv4IsBlocked([parts[6] >> 8, parts[6] & 255, parts[7] >> 8, parts[7] & 255]);
  }
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1) return false;
  if (parts.every((part) => part === 0) || parts.slice(0, 7).every((part) => part === 0)) return true;
  if ((parts[0] === 0xfd00 && parts[1] === 0x0ec2)
    || (parts[0] === 0xfd20 && parts[1] === 0x00ce)) return true;
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && (parts[2] === 0x0001 || parts.slice(2, 6).every((part) => part === 0))) return true;
  if (parts[0] === 0x2002 || (parts[0] === 0x2001 && parts[1] < 0x0200)) return true;
  if ((parts[0] & 0xfe00) === 0xfc00) return false;
  if ((parts[0] & 0xffc0) === 0xfe80) return true;
  if ((parts[0] & 0xff00) === 0xff00) return true;
  if (parts[0] >= 0x2000 && parts[0] <= 0x3fff) {
    if (parts[0] === 0x2001 && parts[1] === 0x0db8) return true;
    if (parts[0] === 0x3fff && (parts[1] & 0xfff0) === 0) return true;
    return false;
  }
  return true;
}

export function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CompanionError(400, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CompanionError(400, 'unsupported_url_scheme');
  }
  if (!url.hostname) throw new CompanionError(400, 'invalid_url');
  return url;
}

export function removeUrlCredentials(url) {
  const clean = new URL(url.href);
  let credentials;
  if (clean.username || clean.password) {
    let username;
    let password;
    try {
      username = decodeURIComponent(clean.username);
      password = decodeURIComponent(clean.password);
    } catch {
      throw new CompanionError(400, 'invalid_url_credentials');
    }
    credentials = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  clean.username = '';
  clean.password = '';
  return { url: clean, authorization: credentials };
}

export function normalizeSourceHeaders(input, authorization) {
  if (input === undefined) input = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CompanionError(400, 'invalid_headers');
  }

  const output = {};
  const forbidden = new Set([
    'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    'range', 'if-range', 'accept-encoding',
  ]);
  const entries = Object.entries(input);
  if (entries.length > 32) throw new CompanionError(400, 'too_many_headers');
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || forbidden.has(name)) {
      throw new CompanionError(400, 'invalid_header_name');
    }
    if (typeof rawValue !== 'string' || /[\r\n\0]/.test(rawValue) || rawValue.length > 4096) {
      throw new CompanionError(400, 'invalid_header_value');
    }
    output[name] = rawValue;
  }
  if (authorization && !output.authorization) output.authorization = authorization;
  output['accept-encoding'] = 'identity';
  return output;
}

export function stripCrossOriginCredentials(headers) {
  const safeAcrossOrigins = new Set([
    'accept', 'accept-language', 'accept-encoding', 'user-agent',
    'range', 'if-range', 'if-none-match', 'if-modified-since',
  ]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => safeAcrossOrigins.has(name.toLowerCase())));
}

export async function validateAllowedDestination(urlValue, allowedHosts) {
  const url = urlValue instanceof URL ? urlValue : parseHttpUrl(urlValue);
  const hostname = normalizeHost(url.hostname);
  if (!allowedHosts.has(hostname)) throw new CompanionError(403, 'destination_not_allowed');

  let addresses;
  const family = isIP(hostname);
  try {
    addresses = family
      ? [{ address: hostname, family }]
      : await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new CompanionError(502, 'destination_dns_failed');
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new CompanionError(403, 'destination_not_allowed');
  }
  return addresses[0];
}

export function urlOrigin(url) {
  return `${url.protocol}//${normalizeHost(url.hostname)}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}

export function parseExactOrigins(value) {
  if (!value) return new Set();
  const origins = new Set();
  for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
    let parsed;
    try {
      parsed = new URL(item);
    } catch {
      throw new Error(`Invalid allowed origin: ${item}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Allowed origins must use HTTP or HTTPS: ${item}`);
    }
    if (parsed.origin === 'null' || parsed.origin !== item.replace(/\/$/, '')) {
      throw new Error(`Allowed origins must be exact origins: ${item}`);
    }
    origins.add(parsed.origin);
  }
  return origins;
}

export function parseExactHosts(value) {
  const hosts = (value ?? '127.0.0.1,localhost,::1')
    .split(',')
    .map((part) => normalizeHost(part.trim()))
    .filter(Boolean);
  return new Set(hosts);
}
