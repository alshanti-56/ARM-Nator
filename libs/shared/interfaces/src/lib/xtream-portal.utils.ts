export type XtreamPortalStatusType =
    | 'active'
    | 'inactive'
    | 'expired'
    | 'unavailable';

export interface XtreamPortalStatusResponseLike {
    user_info?: {
        auth?: boolean | number | string | null;
        exp_date?: number | string | null;
        status?: string | null;
    } | null;
}

interface XtreamPlaybackServerInfoLike {
    url?: unknown;
    server_protocol?: unknown;
    port?: unknown;
    https_port?: unknown;
}

interface XtreamPlaybackAccountInfoLike {
    user_info?: {
        auth?: boolean | number | string | null;
    } | null;
    server_info?: XtreamPlaybackServerInfoLike | null;
}

export interface XtreamCredentialsFromUrl {
    password: string;
    username: string;
}

const XTREAM_API_ENDPOINT_PATTERN = /\/(?:get|player_api)\.php$/i;

/**
 * Account action variants can help when a panel rejects an unsupported action.
 * Changing the action cannot repair authentication, throttling, or a connection
 * failure, so those errors (including errors with no status) must stop the probe.
 */
export function canTryNextXtreamAccountAction(error: unknown): boolean {
    if (error === null || typeof error !== 'object') {
        return false;
    }

    const { name, status } = error as { name?: unknown; status?: unknown };
    return (
        name !== 'AbortError' &&
        (status === 400 || status === 404 || status === 405 || status === 501)
    );
}

function getExplicitUrlPort(value: string): string | undefined {
    const authority = /^https?:\/\/([^/?#]*)/i.exec(value.trim())?.[1];
    if (!authority) {
        return undefined;
    }

    const host = authority.startsWith('[')
        ? authority.slice(0, authority.indexOf(']') + 1)
        : authority;
    const portSeparator = host === authority
        ? authority.lastIndexOf(':')
        : authority.indexOf(']:');
    if (portSeparator < 0) {
        return undefined;
    }

    const port = authority.slice(portSeparator + (host === authority ? 1 : 2));
    return /^\d{1,5}$/.test(port) ? port : undefined;
}

/**
 * Builds the server URL reported by an Xtream account response.
 * Providers commonly return a bare host plus the active protocol and port
 * as separate fields. Keep an explicit port in the displayed URL, including
 * default ports such as :80 and :443.
 */
export function buildXtreamServerUrl(
    value: string | undefined,
    protocol: string | undefined,
    port: string | undefined
): string {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) {
        return '-';
    }

    const normalizedProtocol =
        protocol?.trim().toLowerCase() === 'https' ? 'https' : 'http';
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
        ? trimmed
        : `${normalizedProtocol}://${trimmed}`;
    const normalizedPort = port?.trim() ?? '';

    if (!/^\d{1,5}$/.test(normalizedPort) || getExplicitUrlPort(candidate)) {
        return candidate;
    }

    const match = /^(https?:\/\/)(\[[^\]]+\]|[^/?#]+)(.*)$/i.exec(candidate);
    return match
        ? `${match[1]}${match[2]}:${normalizedPort}${match[3]}`
        : candidate;
}

export function normalizeXtreamServerUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new Error('Xtream URL is required');
    }

    const explicitPort = getExplicitUrlPort(trimmed);
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https Xtream URLs are supported');
    }

    if (url.username || url.password) {
        throw new Error('URL credentials are not supported');
    }

    const pathWithoutTrailingSlash = url.pathname.replace(/\/+$/, '');
    const basePath = pathWithoutTrailingSlash.replace(
        XTREAM_API_ENDPOINT_PATTERN,
        ''
    );

    const origin =
        !url.port && explicitPort
            ? `${url.origin}:${explicitPort}`
            : url.origin;

    return `${origin}${basePath}`;
}

/**
 * Returns a validated media server URL from an authenticated account response.
 * Undefined tells callers to keep using the playlist's configured API URL.
 */
export function deriveXtreamPlaybackServerUrl(
    response: XtreamPlaybackAccountInfoLike | null | undefined
): string | undefined {
    const auth = response?.user_info?.auth;
    if (!(auth === true || auth === 1 || auth === '1')) {
        return undefined;
    }

    const serverInfo = response?.server_info;
    const urlValue = serverInfo?.url;
    if (typeof urlValue !== 'string') {
        return undefined;
    }

    const rawUrl = urlValue.trim();
    if (!rawUrl) {
        return undefined;
    }

    const protocolValue = serverInfo?.server_protocol;
    if (
        protocolValue !== null &&
        protocolValue !== undefined &&
        typeof protocolValue !== 'string'
    ) {
        return undefined;
    }

    const protocol =
        typeof protocolValue === 'string'
            ? protocolValue.trim().toLowerCase()
            : undefined;
    const explicitScheme =
        /^([a-z][a-z\d+.-]*):\/\//i.exec(rawUrl)?.[1]?.toLowerCase();
    const hasExplicitScheme = Boolean(explicitScheme);
    if (
        (protocol && protocol !== 'http' && protocol !== 'https') ||
        (!protocol && !hasExplicitScheme)
    ) {
        return undefined;
    }

    const resolvedProtocol = protocol || explicitScheme;
    const httpsPortValue = serverInfo?.https_port;
    const hasHttpsPort =
        httpsPortValue !== null &&
        httpsPortValue !== undefined &&
        !(typeof httpsPortValue === 'string' && !httpsPortValue.trim());
    const portValue =
        resolvedProtocol === 'https' && hasHttpsPort
            ? httpsPortValue
            : serverInfo?.port;
    if (
        portValue !== null &&
        portValue !== undefined &&
        typeof portValue !== 'string' &&
        typeof portValue !== 'number'
    ) {
        return undefined;
    }
    const port =
        portValue === null || portValue === undefined
            ? ''
            : String(portValue).trim();
    if (
        port &&
        (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    ) {
        return undefined;
    }

    const candidate = buildXtreamServerUrl(
        rawUrl,
        protocol || undefined,
        port || undefined
    );
    try {
        const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(
            candidate
        )?.[1];
        const parsed = new URL(candidate);
        if (
            (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
            !authority ||
            authority.includes('@') ||
            parsed.username ||
            parsed.password ||
            !isSaneXtreamHostname(parsed.hostname) ||
            (parsed.port !== '' && Number(parsed.port) < 1) ||
            parsed.search ||
            parsed.hash
        ) {
            return undefined;
        }

        if (protocol && parsed.protocol !== `${protocol}:`) {
            return undefined;
        }

        return normalizeXtreamServerUrl(candidate);
    } catch {
        return undefined;
    }
}

function isSaneXtreamHostname(hostname: string): boolean {
    if (!hostname || hostname.length > 253) {
        return false;
    }

    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        return /^[\da-f:.]+$/i.test(hostname.slice(1, -1));
    }

    return hostname.split('.').every(
        (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)
    );
}

export function extractXtreamCredentialsFromUrl(
    value: string
): XtreamCredentialsFromUrl | null {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }

    const username = url.searchParams.get('username')?.trim() ?? '';
    const password = url.searchParams.get('password')?.trim() ?? '';

    if (!username || !password) {
        return null;
    }

    return { username, password };
}

export function resolveXtreamPortalStatus(
    response: XtreamPortalStatusResponseLike | null | undefined,
    now = new Date()
): XtreamPortalStatusType {
    const userInfo = response?.user_info;
    if (!userInfo) {
        return 'unavailable';
    }

    const auth = normalizeAuthValue(userInfo.auth);
    if (auth === false) {
        return 'inactive';
    }

    const normalizedStatus = userInfo.status?.trim().toLowerCase() ?? '';
    if (normalizedStatus === 'expired') {
        return 'expired';
    }

    const isActive =
        normalizedStatus === 'active' ||
        (auth === true && normalizedStatus.length === 0);

    if (!isActive) {
        return normalizedStatus ? 'inactive' : 'unavailable';
    }

    const expirationTimestamp = parseXtreamExpiration(userInfo.exp_date);
    if (
        expirationTimestamp !== null &&
        expirationTimestamp * 1000 < now.getTime()
    ) {
        return 'expired';
    }

    return 'active';
}

function normalizeAuthValue(
    value: boolean | number | string | null | undefined
): boolean | null {
    if (value === true || value === 1 || value === '1') {
        return true;
    }

    if (value === false || value === 0 || value === '0') {
        return false;
    }

    return null;
}

function parseXtreamExpiration(
    value: number | string | null | undefined
): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
}
