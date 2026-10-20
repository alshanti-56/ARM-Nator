import type {
    PlaybackPositionData,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';

const SAVE_INTERVAL_MS = 15_000;

export interface InlinePlaybackPositionWriter {
    handleTimeUpdate(event: { currentTime: number; duration: number; persistenceHandled?: boolean }): void;
    reset(): void;
}

export interface InlinePlaybackPositionWriterConfig {
    playback: () => ResolvedPortalPlayback | null;
    save: (playlistId: string, position: PlaybackPositionData) => void | Promise<void>;
    onSaved?: (position: PlaybackPositionData) => void;
}

/**
 * Throttles resume-position writes for an embedded VOD player.
 *
 * Player time updates can be emitted several times per second. Keeping the
 * throttle here makes the Stalker detail presentation behave consistently
 * with the other VOD players while still updating the local resume position
 * immediately when a write is accepted.
 */
export function createInlinePlaybackPositionWriter(
    config: InlinePlaybackPositionWriterConfig
): InlinePlaybackPositionWriter {
    let lastSaveTime = 0;

    return {
        handleTimeUpdate(event): void {
            const playback = config.playback();
            if (!playback?.contentInfo) return;
            if (!Number.isFinite(event.currentTime) || event.currentTime < 0) {
                return;
            }

            const position: PlaybackPositionData = {
                ...playback.contentInfo,
                positionSeconds: event.currentTime,
                durationSeconds:
                    Number.isFinite(event.duration) && event.duration > 0
                        ? event.duration
                        : undefined,
            };

            if (event.persistenceHandled) {
                config.onSaved?.(position);
                return;
            }
            const now = Date.now();
            if (now - lastSaveTime <= SAVE_INTERVAL_MS) return;

            lastSaveTime = now;
            void config.save(playback.contentInfo.playlistId, position);
            config.onSaved?.(position);
        },
        reset(): void {
            lastSaveTime = 0;
        },
    };
}
