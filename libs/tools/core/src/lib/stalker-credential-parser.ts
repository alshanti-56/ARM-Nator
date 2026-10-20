import { normalizeStalkerMacAddress } from '@arm-nator/shared/interfaces';

export interface StalkerCredentialCandidate {
  readonly id: string;
  readonly type: 'stalker';
  readonly originalText: string;
  readonly portalUrl: string;
  readonly macAddress: string;
  readonly normalizedKey: string;
}

export interface StalkerInvalidEntry {
  readonly id: string;
  readonly text: string;
  readonly reason: string;
}

export interface StalkerParseResult {
  readonly candidates: readonly StalkerCredentialCandidate[];
  readonly duplicates: readonly StalkerCredentialCandidate[];
  readonly invalidEntries: readonly StalkerInvalidEntry[];
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function normalizeStalkerPortalUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function createStalkerCredentialKey(
  portalUrl: string,
  macAddress: string
): string {
  const normalizedPortal = normalizeStalkerPortalUrl(portalUrl) ?? portalUrl.trim();
  try {
    const url = new URL(normalizedPortal);
    return JSON.stringify([
      'stalker',
      url.protocol.toLowerCase(),
      url.hostname.toLowerCase(),
      url.port,
      url.pathname.replace(/\/+$/, ''),
      url.username,
      url.password,
      macAddress.toUpperCase(),
    ]);
  } catch {
    return `stalker|${normalizedPortal.toLowerCase()}|${macAddress.toUpperCase()}`;
  }
}

interface ExtractedLine {
  text: string;
  portals: string[];
  macs: string[];
}

function extractLine(text: string): ExtractedLine {
  // Remove URL tokens before scanning MACs: a path or password can contain
  // twelve hex digits without identifying a device.
  const portals: string[] = [];
  const macs: string[] = [];
  const addPortal = (raw: string) => {
    const cleaned = raw.replace(/[.,;!?)\]}]+$/g, '');
    const url = normalizeStalkerPortalUrl(cleaned);
    if (!url) return;
    if (!portals.includes(url)) portals.push(url);
    for (const [key, value] of new URL(cleaned).searchParams) {
      if (/^mac(?:_?address)?$/i.test(key)) {
        const mac = normalizeStalkerMacAddress(value);
        if (mac) macs.push(mac);
      }
    }
  };
  let remainder = text.replace(/https?:\/\/[^\s<>"'`|,]+/gi, (raw) => {
    addPortal(raw);
    return ' ';
  });
  // A missing scheme is common in labeled exports. Only accept a domain
  // with a valid-looking TLD (or an IPv4 address), never an arbitrary word.
  remainder = remainder.replace(
    /(?<![\w@/])(?:(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,63}|(?:\d{1,3}\.){3}\d{1,3})(?::\d{1,5})?(?:\/[^\s<>"'`|,]*)?/gi,
    (raw) => {
      if (normalizeStalkerMacAddress(raw)) return raw;
      addPortal(`http://${raw}`); return ' ';
    }
  );
  const pattern = /(?<![\w:.-])(?:[a-f\d]{2}(?:[ \t]*[:-][ \t]*[a-f\d]{2}){5}|[a-f\d]{4}(?:\.[a-f\d]{4}){2}|[a-f\d]{2}(?:\.[a-f\d]{2}){5}|[a-f\d]{2}(?:[ \t]+[a-f\d]{2}){5}|[a-f\d]{12})(?![\w]|[:.-][a-f\d])/gi;
  for (const match of remainder.matchAll(pattern)) {
    const mac = normalizeStalkerMacAddress(match[0]);
    if (mac) macs.push(mac);
  }
  return { text, portals, macs };
}

function extractInput(rawInput: string): { lines: ExtractedLine[]; structured: boolean } {
  // JSON records keep their own scope, even when keys are reversed or a
  // nested list inherits its portal from the parent object.
  try {
    const jsonText = rawInput.trim().replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '');
    const json: unknown = JSON.parse(jsonText);
    if (json && typeof json === 'object') {
      const lines: ExtractedLine[] = [];
      const visit = (value: unknown, inherited: string[] = []) => {
        if (Array.isArray(value)) {
          for (const item of value) visit(item, inherited);
        } else if (value && typeof value === 'object') {
          const values = Object.values(value);
          const primitives = values.flatMap(v => typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter(item => typeof item === 'string') : []);
          const line = extractLine(primitives.join(' | '));
          const portals = line.portals.length ? line.portals : inherited;
          if (line.macs.length) lines.push({ ...line, portals });
          for (const child of values) {
            if (child && typeof child === 'object' && !(Array.isArray(child) && child.every(v => typeof v === 'string'))) visit(child, portals);
          }
        } else if (typeof value === 'string') {
          const line = extractLine(value);
          if (line.macs.length) lines.push({ ...line, portals: line.portals.length ? line.portals : inherited });
        }
      };
      visit(json);
      if (lines.length) return { lines, structured: true };
    }
  } catch { /* Plain text exports do not need to be valid JSON. */ }
  const text = rawInput
    .replace(/\\\//g, '/')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:lt|gt);/gi, ' ')
    .replace(/<\/(?:div|p|tr|li)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, tag => {
      const url = tag.match(/https?:\/\/[^\s<>"']+/i)?.[0];
      return url ? ` ${url} ` : ' ';
    });
  return { lines: text.replace(/\r/g, '').split('\n').map(extractLine), structured: false };
}

export function parseStalkerCredentials(rawInput: string, limit = 100): StalkerParseResult {
  const { lines, structured } = extractInput(rawInput);
  const candidates: StalkerCredentialCandidate[] = [];
  const duplicates: StalkerCredentialCandidate[] = [];
  const invalidEntries: StalkerInvalidEntry[] = [];
  const seen = new Set<string>();
  const allPortals = [...new Set(lines.flatMap(line => line.portals))];
  // A blank-line record can put its portal after the MAC. Resolve that
  // local scope before falling back to the preceding shared portal header.
  const blockPortals = new Map<ExtractedLine, string[]>();
  let block: ExtractedLine[] = [];
  const finishBlock = () => {
    const urls = [...new Set(block.flatMap(line => line.portals))];
    const firstPortal = block.findIndex(line => line.portals.length > 0);
    const hasFollowingMacs = block.slice(firstPortal + 1).some(line => line.macs.length > 0);
    for (const line of block) blockPortals.set(line, hasFollowingMacs ? [] : urls);
    block = [];
  };
  for (const line of lines) {
    if (line.text.trim()) block.push(line); else finishBlock();
  }
  finishBlock();
  let currentPortals: string[] = [];
  const usedPortals = new Set<string>();
  const invalid = (text: string, reason: string) => invalidEntries.push({ id: id(), text, reason });

  for (const line of lines) {
    if (!line.text.trim()) continue;
    if (line.portals.length) currentPortals = line.portals;
    const localPortals = blockPortals.get(line) ?? [];
    const portals = structured ? line.portals
      : line.portals.length ? line.portals
      : localPortals.length === 1 ? localPortals
      : currentPortals.length ? currentPortals
      : allPortals.length === 1 ? allPortals : [];
    if (!line.macs.length) {
      // Decorative/export metadata is harmless; account-looking malformed
      // fields remain visible so the parser never silently loses a device.
      if (!line.portals.length && /\bmac(?:\s+address)?\s*[:=➤]|(?:[a-f\d]{2}[:-]){3}[a-f\d]{2}|^\s*[a-f\d]{12}\w*/i.test(line.text)) {
        invalid(line.text, 'Invalid MAC address.');
      }
      continue;
    }
    if (portals.length !== 1) {
      invalid(line.text, portals.length > 1 || allPortals.length > 1
        ? 'Ambiguous: multiple portals found. Put each MAC with its portal in the same row or block.'
        : 'No portal URL found for this MAC address.');
      continue;
    }
    const portalUrl = portals[0];
    usedPortals.add(portalUrl);
    for (const macAddress of line.macs) {
      const candidate: StalkerCredentialCandidate = {
        id: id(), type: 'stalker', originalText: `${portalUrl}\n${line.text}`,
        portalUrl, macAddress, normalizedKey: createStalkerCredentialKey(portalUrl, macAddress),
      };
      if (seen.has(candidate.normalizedKey)) duplicates.push(candidate);
      else if (candidates.length >= limit) invalid(line.text, `Only the first ${limit} unique entries are accepted.`);
      else { seen.add(candidate.normalizedKey); candidates.push(candidate); }
    }
  }
  for (const portal of allPortals) {
    if (!usedPortals.has(portal) && !invalidEntries.some(entry => entry.reason.startsWith('Ambiguous'))) {
      invalid(portal, 'No valid MAC address found for this portal.');
    }
  }
  return { candidates, duplicates, invalidEntries };
}
