/**
 * Playback Position IPC event handlers
 * Operations for managing video playback progress
 */

import type { ViewingItem, ViewingStateUpdate, CatalogueItemIdentity, TitleTrackPreferences } from '@arm-nator/shared/interfaces';
import { handleWorkerRequest } from './worker-events.utils';

handleWorkerRequest(
    'DB_SAVE_PLAYBACK_POSITION',
    (playlistId: string, data: unknown) => ({
        playlistId,
        data,
    })
);

handleWorkerRequest(
    'DB_GET_PLAYBACK_POSITION',
    (
        playlistId: string,
        contentXtreamId: number,
        contentType: 'vod' | 'episode'
    ) => ({
        playlistId,
        contentXtreamId,
        contentType,
    })
);

handleWorkerRequest(
    'DB_GET_SERIES_PLAYBACK_POSITIONS',
    (playlistId: string, seriesXtreamId: number) => ({
        playlistId,
        seriesXtreamId,
    })
);

handleWorkerRequest(
    'DB_GET_RECENT_PLAYBACK_POSITIONS',
    (playlistId: string, limit?: number) => ({
        playlistId,
        limit,
    })
);

handleWorkerRequest('DB_GET_ALL_PLAYBACK_POSITIONS', (playlistId: string) => ({
    playlistId,
}));

handleWorkerRequest(
    'DB_CLEAR_ALL_PLAYBACK_POSITIONS',
    (playlistId: string) => ({
        playlistId,
    })
);

handleWorkerRequest(
    'DB_CLEAR_PLAYBACK_POSITION',
    (
        playlistId: string,
        contentXtreamId: number,
        contentType: 'vod' | 'episode'
    ) => ({
        playlistId,
        contentXtreamId,
        contentType,
    })
);

handleWorkerRequest('DB_RECONCILE_VIEWING_ITEM', (item: ViewingItem) => item);
handleWorkerRequest('DB_SAVE_VIEWING_STATE', (update: ViewingStateUpdate) => update);
handleWorkerRequest('DB_GET_VIEWING_RESUME', (identity: CatalogueItemIdentity, actualDuration?: number) => ({ identity, actualDuration }));

handleWorkerRequest('DB_GET_TITLE_PREFERENCES', (item: ViewingItem) => item);
handleWorkerRequest('DB_SAVE_TITLE_PREFERENCES', (item: ViewingItem, patch: TitleTrackPreferences, confirmedAt: number) => ({ item, patch, confirmedAt }));

handleWorkerRequest('DB_GET_VIEWING_HISTORY', (playlistId?: string) => ({ playlistId }));
