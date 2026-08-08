import { ipcMain } from 'electron';
import {
    EMBEDDED_MPV_CREATE_SESSION,
    EMBEDDED_MPV_DISPOSE_SESSION,
    EMBEDDED_MPV_LOAD_PLAYBACK,
    EMBEDDED_MPV_PREPARE,
    EMBEDDED_MPV_SEEK,
    EMBEDDED_MPV_SET_ASPECT,
    EMBEDDED_MPV_SET_PICTURE,
    EMBEDDED_MPV_SET_AUDIO_TRACK,
    EMBEDDED_MPV_SET_BOUNDS,
    EMBEDDED_MPV_SET_PAUSED,
    EMBEDDED_MPV_SET_SPEED,
    EMBEDDED_MPV_SET_SUBTITLE_TRACK,
    EMBEDDED_MPV_SET_SUBTITLE_FILE,
    EMBEDDED_MPV_SET_SUBTITLE_SETTINGS,
    EMBEDDED_MPV_SET_VOLUME,
    EMBEDDED_MPV_SUPPORT,
    EmbeddedMpvBounds,
    ResolvedPortalPlayback,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
} from '@arm-nator/shared/interfaces';
import {
    EmbeddedMpvNativeService,
    embeddedMpvNativeService,
} from '../services/embedded-mpv-native.service';

export default class EmbeddedMpvEvents {
    static bootstrapEmbeddedMpvEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function getService(): EmbeddedMpvNativeService {
    return embeddedMpvNativeService;
}

/**
 * Registers an embedded-MPV IPC handler that logs failures in the main
 * process before rethrowing them to the renderer. The renderer swallows
 * these rejections (the next session snapshot resyncs its state), so
 * without main-side logging addon errors would be invisible.
 */
function handleEmbeddedMpv<Args extends unknown[]>(
    channel: string,
    handler: (...args: Args) => unknown
): void {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        try {
            return await handler(...(args as Args));
        } catch (error) {
            console.error(`[Embedded MPV] ${channel} handler failed:`, error);
            throw error;
        }
    });
}

handleEmbeddedMpv(EMBEDDED_MPV_SUPPORT, () => getService().getSupport());

handleEmbeddedMpv(EMBEDDED_MPV_PREPARE, () => getService().prepareAddon());

handleEmbeddedMpv(
    EMBEDDED_MPV_CREATE_SESSION,
    (
        bounds: EmbeddedMpvBounds,
        title?: string,
        initialVolume?: number
    ) => getService().createSession(bounds, title, initialVolume)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_PICTURE,
    (sessionId: string, picture: PlayerPictureSettings) =>
        getService().setPicture(sessionId, picture)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_LOAD_PLAYBACK,
    (sessionId: string, playback: ResolvedPortalPlayback) =>
        getService().loadPlayback(sessionId, playback)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_BOUNDS,
    (sessionId: string, bounds: EmbeddedMpvBounds) =>
        getService().setBounds(sessionId, bounds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_PAUSED,
    (sessionId: string, paused: boolean) =>
        getService().setPaused(sessionId, paused)
);

handleEmbeddedMpv(EMBEDDED_MPV_SEEK, (sessionId: string, seconds: number) =>
    getService().seek(sessionId, seconds)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_VOLUME,
    (sessionId: string, volume: number) =>
        getService().setVolume(sessionId, volume)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_AUDIO_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setAudioTrack(sessionId, trackId)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setSubtitleTrack(sessionId, trackId)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_FILE,
    (sessionId: string, filePath: string) =>
        getService().setSubtitleFile(sessionId, filePath)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_SUBTITLE_SETTINGS,
    (sessionId: string, settings: PlayerSubtitleSettings) =>
        getService().setSubtitleSettings(sessionId, settings)
);

handleEmbeddedMpv(EMBEDDED_MPV_SET_SPEED, (sessionId: string, speed: number) =>
    getService().setSpeed(sessionId, speed)
);

handleEmbeddedMpv(
    EMBEDDED_MPV_SET_ASPECT,
    (sessionId: string, aspect: string) =>
        getService().setAspect(sessionId, aspect)
);

handleEmbeddedMpv(EMBEDDED_MPV_DISPOSE_SESSION, (sessionId: string) =>
    getService().disposeSession(sessionId)
);

export function shutdownEmbeddedMpv(): void {
    getService().shutdown();
}
