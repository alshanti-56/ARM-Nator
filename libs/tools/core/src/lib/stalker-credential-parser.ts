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

const PANEL = /^\s*(?:📡\s*)?(?:panel|portal|server)\s*(?:➤|:|=)\s*(https?:\/\/\S+)\s*$/i;
const MAC = /^\s*(?:📱\s*)?(?:mac|mac address)\s*(?:➤|:|=)\s*(\S+)\s*$/i;
const EXPIRY = /^\s*(?:⏰\s*)?(?:expires?|expiry|expiration)\s*(?:➤|:|=)\s*(.+?)\s*$/i;

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

export function parseStalkerCredentials(rawInput: string, limit = 100): StalkerParseResult {
  const lines = rawInput.replace(/\r/g, '').split('\n');
  const candidates: StalkerCredentialCandidate[] = [];
  const duplicates: StalkerCredentialCandidate[] = [];
  const invalidEntries: StalkerInvalidEntry[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < lines.length;) {
    if (!lines[index].trim()) { index += 1; continue; }
    const panelMatch = lines[index].match(PANEL);
    const macMatch = lines[index + 1]?.match(MAC);
    if (!panelMatch || !macMatch) {
      invalidEntries.push({ id: id(), text: lines[index].trim(), reason: 'Expected a Panel URL followed by a MAC address.' });
      index += 1;
      continue;
    }
    const portalUrl = normalizeStalkerPortalUrl(panelMatch[1]);
    const macAddress = normalizeStalkerMacAddress(macMatch[1]);
    const expiryMatch = lines[index + 2]?.match(EXPIRY);
    // Keep the optional source line in originalText for traceability only.
    // Expiry is authoritative only when returned by portal validation.
    const originalText = [lines[index], lines[index + 1], ...(expiryMatch ? [lines[index + 2]] : [])].join('\n');
    if (!portalUrl) invalidEntries.push({ id: id(), text: originalText, reason: 'Invalid portal URL.' });
    else if (!macAddress) invalidEntries.push({ id: id(), text: originalText, reason: 'Invalid MAC address.' });
    else if (candidates.length >= limit) invalidEntries.push({ id: id(), text: originalText, reason: `Only the first ${limit} unique entries are accepted.` });
    else {
      const candidate: StalkerCredentialCandidate = { id: id(), type: 'stalker', originalText, portalUrl, macAddress, normalizedKey: createStalkerCredentialKey(portalUrl, macAddress) };
      if (seen.has(candidate.normalizedKey)) duplicates.push(candidate); else { seen.add(candidate.normalizedKey); candidates.push(candidate); }
    }
    index += expiryMatch ? 3 : 2;
  }
  return { candidates, duplicates, invalidEntries };
}
