import { getPlaybackMediaExtensionFromUrl } from '../playback-diagnostics/playback-diagnostics.util';
import type { AutoPlaybackPreparation } from '@arm-nator/shared/interfaces';
import {
    getPreparedProxyMediaExtension,
    getPreparedProxyPlayerType,
} from '../web-video-support/prepared-proxy-source.util';

/** Disable ArtPlayer chrome so ARM-Nator's controls are the sole owner. */
export function buildArtPlayerChrome(): Record<string, unknown> {
    return {
        controls: [],
        pip: false,
        autoPlayback: false,
        autoSize: false,
        autoMini: false,
        setting: false,
        playbackRate: false,
        aspectRatio: false,
        fullscreen: false,
        fullscreenWeb: false,
        airplay: false,
        hotkey: false,
        fastForward: false,
        autoOrientation: false,
        lock: false,
        gesture: false,
        miniProgressBar: false,
        subtitleOffset: false,
    };
}

export function resolveArtPlayerIsLive(
    authoritativeIsLive: boolean
): boolean {
    return authoritativeIsLive;
}

export function getArtPlayerVideoType(
    url: string,
    preparedProxy?: AutoPlaybackPreparation,
): string {
    const preparedType = getPreparedProxyPlayerType(preparedProxy);
    if (preparedType) {
        return preparedType;
    }
    const extension = getPreparedProxyMediaExtension(preparedProxy) ??
        getPlaybackMediaExtensionFromUrl(url);
    switch (extension) {
        case 'mkv':
            return 'video/matroska';
        case 'm3u8':
            return 'm3u8';
        case 'mp4':
            return 'mp4';
        case 'mpd':
            return 'mpd';
        case 'm2ts':
        case 'ts':
            return 'ts';
        default:
            // Extensionless IPTV proxy/script URLs are predominantly raw
            // MPEG-TS and retain the established ArtPlayer fallback.
            return extension ? 'auto' : 'ts';
    }
}

export function exitOwnedArtPlayerFullscreen(
    surface: HTMLElement | undefined,
    reportError: (error: unknown) => void
): void {
    if (
        document.fullscreenElement !== surface ||
        typeof document.exitFullscreen !== 'function'
    ) {
        return;
    }

    try {
        void Promise.resolve(document.exitFullscreen()).catch(reportError);
    } catch (error: unknown) {
        reportError(error);
    }
}
