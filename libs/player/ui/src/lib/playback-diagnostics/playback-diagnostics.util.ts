import type { PlaybackNetworkFailure } from '@arm-nator/shared/interfaces';
import type {
    HlsPlaybackErrorInput,
    MpegTsPlaybackErrorInput,
    NativePlaybackErrorInput,
    PlaybackDiagnostic,
    PlaybackDiagnosticCode,
    PlaybackDiagnosticSource,
    PlaybackSourceMetadata,
} from './playback-diagnostics.model';
import { PlaybackDiagnosticCode as DiagnosticCode } from './playback-diagnostics.model';
import { PlaybackDiagnosticSource as DiagnosticSource } from './playback-diagnostics.model';
import {
    isBrowserAccessFailure,
    isCodecFailure,
    isDrmOrEncryptionFailure,
    isEarlyEofFailure,
    extractHttpStatusCode,
    isNetworkFailure,
    normalizeErrorDetails,
} from './playback-error-patterns.util';
import {
    isLikelyContainerIssue,
    mergeCodecMetadata,
} from './playback-media-source.util';

export * from './playback-diagnostics.model';
export {
    createPlaybackSourceMetadata,
    getLikelyBrowserUnsupportedCodecLabels,
    getPlaybackMediaExtensionFromUrl,
} from './playback-media-source.util';

const SOURCE_NOT_SUPPORTED_CODE = 4;
const DECODE_ERROR_CODE = 3;
const NETWORK_ERROR_CODE = 2;

export function classifyNativePlaybackIssue(
    error: NativePlaybackErrorInput | MediaError | null | undefined,
    metadata: PlaybackSourceMetadata,
): PlaybackDiagnostic {
    const nativeErrorCode = error?.code;
    const nativeErrorMessage = error?.message || undefined;
    const lowerNativeErrorMessage = nativeErrorMessage?.toLowerCase() ?? '';

    if (nativeErrorCode === NETWORK_ERROR_CODE) {
        // Native MediaError details are often opaque for browser security
        // failures. Only classify browser access when the runtime exposes a
        // concrete CORS/mixed-content/CSP-style message.
        return createPlaybackDiagnostic({
            code: isBrowserAccessFailure(lowerNativeErrorMessage)
                ? DiagnosticCode.BrowserAccessError
                : DiagnosticCode.NetworkError,
            source: DiagnosticSource.Native,
            metadata,
            nativeErrorCode,
            nativeErrorMessage,
        });
    }

    if (nativeErrorCode === DECODE_ERROR_CODE) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.MediaDecodeError,
            source: DiagnosticSource.Native,
            metadata,
            nativeErrorCode,
            nativeErrorMessage,
        });
    }

    if (nativeErrorCode === SOURCE_NOT_SUPPORTED_CODE) {
        return createPlaybackDiagnostic({
            code: isLikelyContainerIssue(metadata)
                ? DiagnosticCode.UnsupportedContainer
                : DiagnosticCode.UnsupportedCodec,
            source: DiagnosticSource.Native,
            metadata,
            nativeErrorCode,
            nativeErrorMessage,
        });
    }

    return createPlaybackDiagnostic({
        code: DiagnosticCode.UnknownPlaybackError,
        source: DiagnosticSource.Native,
        metadata,
        nativeErrorCode,
        nativeErrorMessage,
    });
}

function hlsNetwork(error: HlsPlaybackErrorInput): PlaybackNetworkFailure {
    const code = error.response?.code;
    const details = error.details?.toLowerCase() ?? '';
    let retryAfterSeconds: number | undefined;
    const loader = error.networkDetails as { getResponseHeader?: (name: string) => string | null; headers?: { get(name: string): string | null } } | undefined;
    const retryAfter = loader?.getResponseHeader?.('Retry-After') ?? loader?.headers?.get('Retry-After');
    if (retryAfter) {
        const seconds = Number(retryAfter);
        const duration = Number.isFinite(seconds) ? seconds : (Date.parse(retryAfter) - Date.now()) / 1000;
        if (Number.isFinite(duration)) retryAfterSeconds = Math.max(0, duration);
    }
    return {
        status: typeof code === 'number' && code >= 100 && code <= 599 ? code : null,
        resourceKind: details.includes('key') ? 'encryption-key' : details.includes('frag') ? 'segment' : details.includes('manifest') ? 'manifest' : details.includes('level') || details.includes('audio') || details.includes('subtitle') ? 'playlist' : 'unknown',
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
}

export function classifyHlsPlaybackIssue(
    error: HlsPlaybackErrorInput,
    metadata: PlaybackSourceMetadata,
): PlaybackDiagnostic {
    const details = normalizeErrorDetails(error);
    const lowerDetails = details.toLowerCase();
    const lowerType = (error.type ?? '').toLowerCase();
    const mergedMetadata = mergeCodecMetadata(metadata, {
        audioCodecs: error.audioCodecs,
        videoCodecs: error.videoCodecs,
    });

    if (isNetworkFailure(lowerType, lowerDetails)) {
        return createPlaybackDiagnostic({
            code: isBrowserAccessFailure(lowerDetails)
                ? DiagnosticCode.BrowserAccessError
                : DiagnosticCode.NetworkError,
            source: DiagnosticSource.Hls,
            metadata: mergedMetadata,
            details,
            network: hlsNetwork(error),
        });
    }

    if (isDrmOrEncryptionFailure(lowerDetails)) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.DrmOrEncryption,
            source: DiagnosticSource.Hls,
            metadata: mergedMetadata,
            details,
            network: hlsNetwork(error),
        });
    }

    if (isCodecFailure(lowerDetails)) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.UnsupportedCodec,
            source: DiagnosticSource.Hls,
            metadata: mergedMetadata,
            details,
            network: hlsNetwork(error),
        });
    }

    if (lowerType.includes('media') || lowerType.includes('mux')) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.MediaDecodeError,
            source: DiagnosticSource.Hls,
            metadata: mergedMetadata,
            details,
            network: hlsNetwork(error),
        });
    }

    return createPlaybackDiagnostic({
        code: DiagnosticCode.UnknownPlaybackError,
        source: DiagnosticSource.Hls,
        metadata: mergedMetadata,
        details,
        network: hlsNetwork(error),
    });
}

export function classifyMpegTsPlaybackIssue(
    error: MpegTsPlaybackErrorInput,
    metadata: PlaybackSourceMetadata,
): PlaybackDiagnostic {
    const details = normalizeErrorDetails(error);
    const lowerDetails = details.toLowerCase();
    const lowerType = (error.type ?? '').toLowerCase();
    const httpStatus = extractHttpStatusCode(error.type, details, error.info);

    // Some IPTV/Stalker providers use non-standard 4xx statuses (for
    // example 456/458) to reject a stream. Retrying the same short-lived URL
    // cannot repair that response and only delays the useful diagnostic.
    if (
        httpStatus !== null &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        httpStatus !== 408 &&
        httpStatus !== 425 &&
        httpStatus !== 429
    ) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.ProviderRejected,
            source: DiagnosticSource.MpegTs,
            metadata,
            details: `HTTP ${httpStatus}${details ? ` — ${details}` : ''}`,
        });
    }

    if (isEarlyEofFailure(lowerDetails)) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.NetworkError,
            source: DiagnosticSource.MpegTs,
            metadata,
            details,
        });
    }

    if (isNetworkFailure(lowerType, lowerDetails)) {
        return createPlaybackDiagnostic({
            code: isBrowserAccessFailure(lowerDetails)
                ? DiagnosticCode.BrowserAccessError
                : DiagnosticCode.NetworkError,
            source: DiagnosticSource.MpegTs,
            metadata,
            details,
        });
    }

    if (lowerDetails.includes('codec')) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.UnsupportedCodec,
            source: DiagnosticSource.MpegTs,
            metadata,
            details,
        });
    }

    if (lowerDetails.includes('format') || lowerDetails.includes('mse')) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.UnsupportedContainer,
            source: DiagnosticSource.MpegTs,
            metadata,
            details,
        });
    }

    if (lowerType.includes('media')) {
        return createPlaybackDiagnostic({
            code: DiagnosticCode.MediaDecodeError,
            source: DiagnosticSource.MpegTs,
            metadata,
            details,
        });
    }

    return createPlaybackDiagnostic({
        code: DiagnosticCode.UnknownPlaybackError,
        source: DiagnosticSource.MpegTs,
        metadata,
        details,
    });
}

export function classifyUnsupportedHlsManifestCodecs(
    metadata: PlaybackSourceMetadata,
): PlaybackDiagnostic | null {
    if (!hasCodecs(metadata) || typeof MediaSource === 'undefined') {
        return null;
    }

    const codecList = [...metadata.videoCodecs, ...metadata.audioCodecs];
    const mimeType = `video/mp4; codecs="${codecList.join(',')}"`;

    if (MediaSource.isTypeSupported(mimeType)) {
        return null;
    }

    return createPlaybackDiagnostic({
        code: DiagnosticCode.UnsupportedCodec,
        source: DiagnosticSource.Source,
        metadata,
        details: mimeType,
    });
}

export function redactPlaybackErrorText(value: string): string {
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[media request]')
        .replace(/(authorization|cookie|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]');
}

export function createPlaybackDiagnostic(options: {
    readonly code: PlaybackDiagnosticCode;
    readonly source: PlaybackDiagnosticSource;
    readonly metadata: PlaybackSourceMetadata;
    readonly details?: string;
    readonly network?: PlaybackNetworkFailure;
    readonly nativeErrorCode?: number;
    readonly nativeErrorMessage?: string;
    /** Overrides the code-derived recommendation, e.g. when external players
     * are known to be unable to handle the stream either. */
    readonly externalFallbackRecommended?: boolean;
}): PlaybackDiagnostic {
    const {
        code,
        source,
        metadata,
        details,
        nativeErrorCode,
        nativeErrorMessage,
    } = options;

    return {
        code,
        source,
        sourceUrl: metadata.url,
        container: metadata.container,
        mimeType: metadata.mimeType,
        player: metadata.player,
        audioCodecs: metadata.audioCodecs,
        videoCodecs: metadata.videoCodecs,
        details: details ? redactPlaybackErrorText(details) : undefined,
        network: options.network,
        nativeErrorCode,
        nativeErrorMessage: nativeErrorMessage ? redactPlaybackErrorText(nativeErrorMessage) : undefined,
        externalFallbackRecommended:
            options.externalFallbackRecommended ??
            isExternalFallbackRecommended(code),
    };
}

function isExternalFallbackRecommended(code: PlaybackDiagnosticCode): boolean {
    return (
        code === DiagnosticCode.UnsupportedContainer ||
        code === DiagnosticCode.UnsupportedCodec ||
        code === DiagnosticCode.MediaDecodeError ||
        code === DiagnosticCode.BrowserAccessError ||
        code === DiagnosticCode.DrmOrEncryption
    );
}

function hasCodecs(metadata: PlaybackSourceMetadata): boolean {
    return metadata.audioCodecs.length > 0 || metadata.videoCodecs.length > 0;
}
