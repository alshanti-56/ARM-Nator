import { ipcMain } from 'electron';
import {
    EmbeddedMpvBounds,
    KSPLAYER_METAL_CREATE_SESSION,
    KSPLAYER_METAL_DISPOSE_ALL,
    KSPLAYER_METAL_DISPOSE_SESSION,
    KSPLAYER_METAL_GET_SUPPORTED_CONTROLS,
    KSPLAYER_METAL_LOAD_PLAYBACK,
    KSPLAYER_METAL_PREPARE,
    KSPLAYER_METAL_SEEK,
    KSPLAYER_METAL_SET_BOUNDS,
    KSPLAYER_METAL_SET_AUDIO_TRACK,
    KSPLAYER_METAL_SET_SUBTITLE_TRACK,
    KSPLAYER_METAL_SET_SUBTITLE_FILE,
    KSPLAYER_METAL_SET_SUBTITLE_SETTINGS,
    KSPLAYER_METAL_SET_PAUSED,
    KSPLAYER_METAL_SET_VOLUME,
    KSPLAYER_METAL_SET_SPEED,
    KSPLAYER_METAL_SUPPORT,
    ResolvedPortalPlayback,
    PlayerSubtitleSettings,
} from '@arm-nator/shared/interfaces';
import {
    KsPlayerMetalNativeService,
    ksPlayerMetalNativeService,
} from '../services/ksplayer-metal-native.service';

export default class KsPlayerMetalEvents {
    static bootstrapKsPlayerMetalEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function getService(): KsPlayerMetalNativeService {
    return ksPlayerMetalNativeService;
}

function handleKsPlayerMetal<Args extends unknown[]>(
    channel: string,
    handler: (...args: Args) => unknown
): void {
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        try {
            return await handler(...(args as Args));
        } catch (error) {
            console.error(`[KSPlayer Metal] ${channel} handler failed:`, error);
            throw error;
        }
    });
}

handleKsPlayerMetal(KSPLAYER_METAL_SUPPORT, () => getService().getSupport());

handleKsPlayerMetal(KSPLAYER_METAL_PREPARE, () => getService().prepare());

handleKsPlayerMetal(
    KSPLAYER_METAL_CREATE_SESSION,
    (bounds: EmbeddedMpvBounds, title?: string, initialVolume?: number) =>
        getService().createSession(bounds, title, initialVolume)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_LOAD_PLAYBACK,
    (sessionId: string, playback: ResolvedPortalPlayback) =>
        getService().loadPlayback(sessionId, playback)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_BOUNDS,
    (sessionId: string, bounds: EmbeddedMpvBounds) =>
        getService().setBounds(sessionId, bounds)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_PAUSED,
    (sessionId: string, paused: boolean) =>
        getService().setPaused(sessionId, paused)
);

handleKsPlayerMetal(KSPLAYER_METAL_SEEK, (sessionId: string, seconds: number) =>
    getService().seek(sessionId, seconds)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_VOLUME,
    (sessionId: string, volume: number) => getService().setVolume(sessionId, volume)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_AUDIO_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setAudioTrack(sessionId, trackId)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_SUBTITLE_TRACK,
    (sessionId: string, trackId: number) =>
        getService().setSubtitleTrack(sessionId, trackId)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_SUBTITLE_FILE,
    (sessionId: string, filePath: string) =>
        getService().setSubtitleFile(sessionId, filePath)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_SUBTITLE_SETTINGS,
    (sessionId: string, settings: PlayerSubtitleSettings) =>
        getService().setSubtitleSettings(sessionId, settings)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_SET_SPEED,
    (sessionId: string, speed: number) => getService().setSpeed(sessionId, speed)
);

handleKsPlayerMetal(
    KSPLAYER_METAL_GET_SUPPORTED_CONTROLS,
    (sessionId?: string) => getService().getSupportedControls(sessionId)
);

handleKsPlayerMetal(KSPLAYER_METAL_DISPOSE_SESSION, (sessionId: string) =>
    getService().disposeSession(sessionId)
);

handleKsPlayerMetal(KSPLAYER_METAL_DISPOSE_ALL, () =>
    getService().disposeAll()
);

export function shutdownKsPlayerMetal(): void {
    getService().shutdown();
}
