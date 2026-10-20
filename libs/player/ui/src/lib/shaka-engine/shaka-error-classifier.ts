import type {
    PlaybackNetworkFailure,
    PlaybackResourceKind,
} from '@arm-nator/shared/interfaces';
import type {
    PlaybackDiagnostic,
    PlaybackSourceMetadata,
} from '../playback-diagnostics/playback-diagnostics.model';
import {
    PlaybackDiagnosticCode as DiagnosticCode,
    PlaybackDiagnosticSource as DiagnosticSource,
} from '../playback-diagnostics/playback-diagnostics.model';
import { createPlaybackDiagnostic } from '../playback-diagnostics/playback-diagnostics.util';
import {
    isBrowserAccessFailure,
    isCodecFailure,
    isDrmOrEncryptionFailure,
} from '../playback-diagnostics/playback-error-patterns.util';
import type { ShakaErrorLike } from './shaka-module.types';

/**
 * Numeric `shaka.util.Error.Category` values (stable public Shaka API). Kept
 * local so classification stays a pure function that does not need the lazily
 * loaded module.
 */
const SHAKA_CATEGORY = {
    Network: 1,
    Text: 2,
    Media: 3,
    Manifest: 4,
    Streaming: 5,
    Drm: 6,
} as const;

/** `shaka.util.Error.Code.RESTRICTIONS_CANNOT_BE_MET` — in practice this fires
 * when every variant is restricted by unusable decryption keys. */
const RESTRICTIONS_CANNOT_BE_MET = 4012;
const SHAKA_BAD_HTTP_STATUS = 1001;

export function extractShakaNetworkFailure(
    error: Partial<ShakaErrorLike> | null | undefined
): PlaybackNetworkFailure | undefined {
    const data = error?.data;
    if (!data) return undefined;
    const badStatus = error?.code === SHAKA_BAD_HTTP_STATUS;
    const statusValue = badStatus ? data[1] : undefined;
    const status = typeof statusValue === 'number' &&
        Number.isInteger(statusValue) &&
        statusValue >= 100 &&
        statusValue <= 599
        ? statusValue
        : null;
    const responseHeaders = badStatus ? data[3] : undefined;
    const requestType = badStatus ? data[4] : data[2];
    const requestId = getResponseHeader(responseHeaders, 'x-arm-nator-request-id');
    const resourceKindHeader = getResponseHeader(
        responseHeaders,
        'x-arm-nator-resource-kind'
    );
    const resourceKind = parseResourceKind(resourceKindHeader) ??
        resourceKindFromShakaRequestType(requestType);
    const retryAfterSeconds = parseRetryAfter(
        getResponseHeader(responseHeaders, 'retry-after')
    );
    if (status === null && !resourceKind && !requestId && retryAfterSeconds === undefined) return undefined;
    return {
        status,
        resourceKind: resourceKind ?? 'unknown',
        ...(requestId ? { requestId } : {}),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
}

function parseRetryAfter(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds);
    }
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function getResponseHeader(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const candidate = headers as Record<string, unknown> & {
        get?: (headerName: string) => string | null;
    };
    const fromGet = candidate.get?.(name);
    if (typeof fromGet === 'string' && fromGet) return fromGet;
    const entry = Object.entries(candidate).find(
        ([key]) => key.toLowerCase() === name
    )?.[1];
    return typeof entry === 'string' && entry ? entry : undefined;
}

function parseResourceKind(value: string | undefined): PlaybackResourceKind | undefined {
    switch (value?.toLowerCase()) {
        case 'manifest':
        case 'playlist':
        case 'segment':
        case 'encryption-key':
        case 'license':
        case 'unknown':
            return value.toLowerCase() as PlaybackResourceKind;
        default:
            return undefined;
    }
}

function resourceKindFromShakaRequestType(value: unknown): PlaybackResourceKind | undefined {
    switch (value) {
        case 0: return 'manifest';
        case 1: return 'segment';
        case 2: return 'license';
        case 6: return 'encryption-key';
        case 11: return 'playlist';
        default: return undefined;
    }
}

export function classifyShakaPlaybackIssue(
    error: Partial<ShakaErrorLike> | null | undefined,
    metadata: PlaybackSourceMetadata
): PlaybackDiagnostic {
    const details = formatShakaErrorDetails(error);
    const lowerDetails = details.toLowerCase();
    const category = error?.category;
    const network = extractShakaNetworkFailure(error);

    if (
        network?.resourceKind === 'license' &&
        network.status !== null &&
        network.status >= 400
    ) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.ProviderRejected,
            source: DiagnosticSource.Shaka,
            metadata,
            details: `DRM license server returned HTTP ${network.status}`,
            network,
            externalFallbackRecommended: false,
        });
    }

    if (
        network?.resourceKind !== 'license' &&
        (network?.status === 401 || network?.status === 403)
    ) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.ProviderRejected,
            source: DiagnosticSource.Shaka,
            metadata,
            details: `Media request was rejected with HTTP ${network.status}`,
            network,
        });
    }

    if (
        category === SHAKA_CATEGORY.Drm ||
        error?.code === RESTRICTIONS_CANNOT_BE_MET ||
        isDrmOrEncryptionFailure(lowerDetails)
    ) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.DrmOrEncryption,
            source: DiagnosticSource.Shaka,
            metadata,
            details,
            network,
        });
    }

    if (category === SHAKA_CATEGORY.Network) {
        return createPlaybackDiagnostic({
            code: isBrowserAccessFailure(lowerDetails)
                ? DiagnosticCode.BrowserAccessError
                : DiagnosticCode.NetworkError,
            source: DiagnosticSource.Shaka,
            metadata,
            details,
            network,
        });
    }

    if (
        category === SHAKA_CATEGORY.Media ||
        category === SHAKA_CATEGORY.Streaming
    ) {
        return createPlaybackDiagnostic({
            code: isCodecFailure(lowerDetails)
                ? DiagnosticCode.UnsupportedCodec
                : DiagnosticCode.MediaDecodeError,
            source: DiagnosticSource.Shaka,
            metadata,
            details,
            network,
        });
    }

    if (category === SHAKA_CATEGORY.Manifest) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.UnsupportedContainer,
            source: DiagnosticSource.Shaka,
            metadata,
            details,
            network,
        });
    }

    return createPlaybackDiagnostic({
        code: DiagnosticCode.UnknownPlaybackError,
        source: DiagnosticSource.Shaka,
        metadata,
        details,
        ...(network ? { network } : {}),
    });
}

/**
 * Diagnostic for `.mpd` channels that declare a DRM system the app cannot
 * handle (Widevine, PlayReady, malformed ClearKey config, …). Emitted before
 * any Shaka engine is started.
 */
export function createUnsupportedDrmDiagnostic(
    licenseType: string,
    metadata: PlaybackSourceMetadata
): PlaybackDiagnostic {
    return createPlaybackDiagnostic({
        code: DiagnosticCode.DrmOrEncryption,
        source: DiagnosticSource.Shaka,
        metadata,
        details: licenseType
            ? `Unsupported DRM license configuration: ${licenseType}`
            : 'Unsupported DRM license configuration',
        // External MPV/VLC cannot receive the KODIPROP license config either,
        // so offering them as a fallback would just fail differently.
        externalFallbackRecommended: false,
    });
}

/** Narrows an unknown rejection to a Shaka-error-like shape, if it is one. */
export function asShakaError(
    error: unknown
): Partial<ShakaErrorLike> | null {
    if (!error || typeof error !== 'object') {
        return null;
    }

    const candidate = error as Partial<ShakaErrorLike>;
    return typeof candidate.code === 'number' ||
        typeof candidate.category === 'number'
        ? candidate
        : null;
}

export function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return typeof error === 'string' ? error : String(error);
}

function formatShakaErrorDetails(
    error: Partial<ShakaErrorLike> | null | undefined
): string {
    if (!error) {
        return '';
    }

    const parts = [
        typeof error.category === 'number'
            ? `Shaka category ${error.category}`
            : '',
        typeof error.code === 'number' ? `code ${error.code}` : '',
        error.message ?? '',
        stringifyErrorData(error.data),
    ];

    return parts.filter((part) => part.length > 0).join(' ');
}

function stringifyErrorData(data: unknown[] | undefined): string {
    if (!data || data.length === 0) {
        return '';
    }

    try {
        const serialized = JSON.stringify(data);
        return serialized === '[]' ? '' : serialized;
    } catch {
        return '';
    }
}
