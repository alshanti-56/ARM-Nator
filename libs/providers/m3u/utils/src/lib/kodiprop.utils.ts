import { ChannelDrm, ChannelDrmClearKeys } from '@arm-nator/shared/interfaces';

/**
 * `#KODIPROP:` DRM extraction.
 *
 * The playlist parser does not understand `#KODIPROP:` lines, but it appends
 * every unknown line between `#EXTINF` and the stream URL to `item.raw`
 * (the dominant Kodi/TiviMate layout). This module post-processes that raw
 * block into a typed {@link ChannelDrm} value.
 *
 * Supported properties:
 * - `inputstream.adaptive.license_type` + `inputstream.adaptive.license_key`
 * - `inputstream.adaptive.drm_legacy` (`<license type>|<license key>`)
 *
 * ClearKey key formats: single `kid:key` hex pair, comma-separated pairs, the
 * W3C ClearKey license JSON (`{"keys":[{"kty":"oct","k":...,"kid":...}]}`)
 * and the plain `{kid: key}` JSON map. Widevine/PlayReady license keys may use
 * the Kodi form `https://license.example|Header=value&Other=value`; the URL
 * and headers are preserved for the browser DRM engine.
 */

const KODIPROP_PREFIX = '#kodiprop:';
const LICENSE_TYPE_PROP = 'inputstream.adaptive.license_type';
const LICENSE_KEY_PROP = 'inputstream.adaptive.license_key';
const LICENSE_URL_PROP = 'inputstream.adaptive.license_url';
const DRM_LEGACY_PROP = 'inputstream.adaptive.drm_legacy';

const CLEARKEY_LICENSE_TYPES = new Set(['clearkey', 'org.w3.clearkey']);
const LICENSE_SERVER_TYPES = new Set([
    'com.widevine.alpha',
    'widevine',
    'com.microsoft.playready',
    'com.microsoft.playready.recommendation',
    'com.microsoft.playready.hardware',
    'playready',
]);

const HEX_128_BIT_PATTERN = /^[0-9a-f]{32}$/;

export function isClearKeyLicenseType(licenseType: string): boolean {
    return CLEARKEY_LICENSE_TYPES.has(licenseType.trim().toLowerCase());
}

/**
 * Extracts DRM configuration from a playlist item's raw M3U block.
 * Returns `undefined` when the block carries no DRM-related `#KODIPROP` lines,
 * so channels without KODIPROP metadata stay untouched.
 */
export function extractDrmFromRaw(
    raw: string | undefined
): ChannelDrm | undefined {
    const props = collectKodipropValues(raw);
    if (props.size === 0) {
        return undefined;
    }

    let licenseType = props.get(LICENSE_TYPE_PROP)?.trim() ?? '';
    let licenseKey = props.get(LICENSE_KEY_PROP)?.trim() ?? '';

    const drmLegacy = props.get(DRM_LEGACY_PROP)?.trim();
    if (drmLegacy && (!licenseType || !licenseKey)) {
        const [legacyType, ...legacyKeyParts] = drmLegacy.split('|');
        licenseType ||= legacyType?.trim() ?? '';
        licenseKey ||= legacyKeyParts.join('|').trim();
    }

    if (!licenseType && !licenseKey) {
        return undefined;
    }

    const normalizedType = licenseType.toLowerCase();
    const normalizedLicenseType = normalizeLicenseType(normalizedType);
    const clearKeys = isClearKeyLicenseType(normalizedType)
        ? parseClearKeys(licenseKey)
        : !normalizedType
          ? // No explicit type: a parseable kid:key value is ClearKey in practice.
            parseClearKeys(licenseKey)
          : undefined;

    const license = parseLicenseServer(
        props.get(LICENSE_URL_PROP) || licenseKey
    );

    if (clearKeys) {
        return {
            licenseType: normalizedLicenseType || 'org.w3.clearkey',
            supported: true,
            clearKeys,
        };
    }

    return {
        licenseType: normalizedLicenseType,
        supported:
            LICENSE_SERVER_TYPES.has(normalizedType) &&
            Boolean(license?.url),
        ...(license?.url ? { licenseServerUrl: license.url } : {}),
        ...(license?.headers ? { licenseRequestHeaders: license.headers } : {}),
    };
}

function collectKodipropValues(
    raw: string | undefined
): Map<string, string> {
    const props = new Map<string, string>();
    if (!raw) {
        return props;
    }

    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.toLowerCase().startsWith(KODIPROP_PREFIX)) {
            continue;
        }

        const assignment = trimmed.slice(KODIPROP_PREFIX.length);
        const separatorIndex = assignment.indexOf('=');
        if (separatorIndex < 1) {
            continue;
        }

        const name = assignment.slice(0, separatorIndex).trim().toLowerCase();
        const value = assignment.slice(separatorIndex + 1).trim();
        if (
            name === LICENSE_TYPE_PROP ||
            name === LICENSE_KEY_PROP ||
            name === LICENSE_URL_PROP ||
            name === DRM_LEGACY_PROP
        ) {
            props.set(name, value);
        }
    }

    return props;
}

function normalizeLicenseType(licenseType: string): string {
    switch (licenseType) {
        case 'clearkey':
            return 'org.w3.clearkey';
        case 'widevine':
            return 'com.widevine.alpha';
        case 'playready':
            return 'com.microsoft.playready';
        default:
            return licenseType;
    }
}

function parseLicenseServer(
    value: string
): { url: string; headers?: Record<string, string> } | undefined {
    const [urlPart, headerPart] = value.split('|', 2);
    if (!urlPart || !/^https?:\/\//i.test(urlPart)) {
        return undefined;
    }

    let url: URL;
    try {
        url = new URL(urlPart);
    } catch {
        return undefined;
    }

    const headers = parseLicenseHeaders(headerPart);
    return headers && Object.keys(headers).length > 0
        ? { url: url.toString(), headers }
        : { url: url.toString() };
}

function parseLicenseHeaders(
    value: string | undefined
): Record<string, string> | undefined {
    if (!value) {
        return undefined;
    }

    const headers: Record<string, string> = {};
    for (const pair of value.split('&')) {
        const separatorIndex = pair.indexOf('=');
        if (separatorIndex <= 0) {
            continue;
        }
        const name = decodeLicensePart(pair.slice(0, separatorIndex));
        const headerValue = decodeLicensePart(pair.slice(separatorIndex + 1));
        if (name && headerValue) {
            headers[name] = headerValue;
        }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}

function decodeLicensePart(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' ')).trim();
    } catch {
        return value.trim();
    }
}

function parseClearKeys(value: string): ChannelDrmClearKeys | undefined {
    if (!value) {
        return undefined;
    }

    return value.startsWith('{')
        ? parseClearKeysFromJson(value)
        : parseClearKeysFromPairs(value);
}

function parseClearKeysFromPairs(
    value: string
): ChannelDrmClearKeys | undefined {
    const keys: ChannelDrmClearKeys = {};

    for (const pair of value.split(',')) {
        const [kid, key, ...rest] = pair.split(':');
        if (rest.length > 0) {
            return undefined;
        }

        const kidHex = normalizeKeyComponent(kid);
        const keyHex = normalizeKeyComponent(key);
        if (!kidHex || !keyHex) {
            return undefined;
        }

        keys[kidHex] = keyHex;
    }

    return Object.keys(keys).length > 0 ? keys : undefined;
}

function parseClearKeysFromJson(
    value: string
): ChannelDrmClearKeys | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return undefined;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return undefined;
    }

    const record = parsed as Record<string, unknown>;
    return Array.isArray(record['keys'])
        ? parseW3cClearKeyLicense(record['keys'])
        : parseClearKeyMap(record);
}

/** W3C ClearKey license form: `{"keys":[{"kty":"oct","k":...,"kid":...}]}`. */
function parseW3cClearKeyLicense(
    entries: unknown[]
): ChannelDrmClearKeys | undefined {
    const keys: ChannelDrmClearKeys = {};

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') {
            return undefined;
        }

        const { kid, k } = entry as { kid?: unknown; k?: unknown };
        const kidHex = normalizeKeyComponent(
            typeof kid === 'string' ? kid : undefined
        );
        const keyHex = normalizeKeyComponent(
            typeof k === 'string' ? k : undefined
        );
        if (!kidHex || !keyHex) {
            return undefined;
        }

        keys[kidHex] = keyHex;
    }

    return Object.keys(keys).length > 0 ? keys : undefined;
}

function parseClearKeyMap(
    record: Record<string, unknown>
): ChannelDrmClearKeys | undefined {
    const keys: ChannelDrmClearKeys = {};

    for (const [kid, key] of Object.entries(record)) {
        if (typeof key !== 'string') {
            return undefined;
        }

        const kidHex = normalizeKeyComponent(kid);
        const keyHex = normalizeKeyComponent(key);
        if (!kidHex || !keyHex) {
            return undefined;
        }

        keys[kidHex] = keyHex;
    }

    return Object.keys(keys).length > 0 ? keys : undefined;
}

/**
 * Normalizes a 128-bit key component to 32 lowercase hex chars. Accepts plain
 * or dashed (UUID-style) hex and base64url (the W3C license encoding).
 */
function normalizeKeyComponent(value: string | undefined): string | undefined {
    const compact = value?.trim().replace(/-/g, '').toLowerCase();
    if (!compact) {
        return undefined;
    }

    if (HEX_128_BIT_PATTERN.test(compact)) {
        return compact;
    }

    const fromBase64 = base64UrlToHex(value?.trim() ?? '');
    return fromBase64 && HEX_128_BIT_PATTERN.test(fromBase64)
        ? fromBase64
        : undefined;
}

function base64UrlToHex(value: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) {
        return undefined;
    }

    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    try {
        const binary = decodeBase64(base64);
        let hex = '';
        for (let index = 0; index < binary.length; index += 1) {
            hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
        }
        return hex;
    } catch {
        return undefined;
    }
}

/** Works in both the browser (atob) and Node workers (Buffer). */
function decodeBase64(base64: string): string {
    if (typeof atob === 'function') {
        return atob(base64);
    }

    const nodeBuffer = (
        globalThis as {
            Buffer?: {
                from(
                    data: string,
                    encoding: string
                ): { toString(encoding: string): string };
            };
        }
    ).Buffer;
    if (!nodeBuffer) {
        throw new Error('No base64 decoder available');
    }
    return nodeBuffer.from(base64, 'base64').toString('binary');
}
