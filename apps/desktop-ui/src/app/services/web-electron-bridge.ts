import type { ElectronBridgeApi } from '@arm-nator/shared/interfaces';

type DbCall = {
    operation: string;
    payload: unknown;
};

type DbCallBuilder = (args: readonly unknown[]) => DbCall;

const call = (
    operation: string,
    buildPayload: (args: readonly unknown[]) => unknown = (args) =>
        args[0] ?? {}
): DbCallBuilder => (args) => ({
    operation,
    payload: buildPayload(args),
});

const DB_METHODS: Record<string, DbCallBuilder> = {
    dbCreatePlaylist: call('DB_CREATE_PLAYLIST'),
    dbUpsertAppPlaylist: call('DB_UPSERT_APP_PLAYLIST'),
    dbUpsertAppPlaylists: call('DB_UPSERT_APP_PLAYLISTS'),
    dbGetAppPlaylists: call('DB_GET_APP_PLAYLISTS', () => ({})),
    dbGetAppPlaylistMetas: call('DB_GET_APP_PLAYLIST_METAS', () => ({})),
    dbGetAppPlaylist: call('DB_GET_APP_PLAYLIST', ([playlistId]) => ({
        playlistId,
    })),
    dbGetPlaylist: call('DB_GET_PLAYLIST', ([playlistId]) => ({ playlistId })),
    dbUpdatePlaylist: call(
        'DB_UPDATE_PLAYLIST',
        ([playlistId, updates]) => ({ playlistId, updates })
    ),
    dbDeletePlaylist: call(
        'DB_DELETE_PLAYLIST',
        ([playlistId, operationId]) => ({ playlistId, operationId })
    ),
    dbDeleteAllPlaylists: call(
        'DB_DELETE_ALL_PLAYLISTS',
        ([operationId]) => ({ operationId })
    ),
    dbGetAppState: call('DB_GET_APP_STATE', ([key]) => ({ key })),
    dbSetAppState: call('DB_SET_APP_STATE', ([key, value]) => ({ key, value })),

    dbHasCategories: call('DB_HAS_CATEGORIES', ([playlistId, type]) => ({
        playlistId,
        type,
    })),
    dbGetCategories: call('DB_GET_CATEGORIES', ([playlistId, type]) => ({
        playlistId,
        type,
    })),
    dbSaveCategories: call(
        'DB_SAVE_CATEGORIES',
        ([playlistId, categories, type, hiddenCategoryXtreamIds]) => ({
            playlistId,
            categories,
            type,
            hiddenCategoryXtreamIds,
        })
    ),
    dbGetAllCategories: call('DB_GET_ALL_CATEGORIES', ([playlistId, type]) => ({
        playlistId,
        type,
    })),
    dbUpdateCategoryVisibility: call(
        'DB_UPDATE_CATEGORY_VISIBILITY',
        ([categoryIds, hidden]) => ({ categoryIds, hidden })
    ),

    dbHasContent: call('DB_HAS_CONTENT', ([playlistId, type]) => ({
        playlistId,
        type,
    })),
    dbGetContent: call('DB_GET_CONTENT', ([playlistId, type]) => ({
        playlistId,
        type,
    })),
    dbGetGlobalRecentlyAdded: call(
        'DB_GET_GLOBAL_RECENTLY_ADDED',
        ([kind = 'all', limit = 200, playlistType]) => ({
            kind,
            limit,
            playlistType,
        })
    ),
    dbSaveContent: call(
        'DB_SAVE_CONTENT',
        ([playlistId, streams, type, operationId]) => ({
            playlistId,
            streams,
            type,
            operationId,
        })
    ),
    dbClearXtreamImportCache: call(
        'DB_CLEAR_XTREAM_IMPORT_CACHE',
        ([playlistId, type]) => ({ playlistId, type })
    ),
    dbGetContentByXtreamId: call(
        'DB_GET_CONTENT_BY_XTREAM_ID',
        ([xtreamId, playlistId, contentType]) => ({
            xtreamId,
            playlistId,
            contentType,
        })
    ),
    dbSetContentBackdropIfMissing: call(
        'DB_SET_CONTENT_BACKDROP_IF_MISSING',
        ([contentId, backdropUrl]) => ({ contentId, backdropUrl })
    ),
    dbUpdateXtreamContentMetadata: call(
        'DB_UPDATE_XTREAM_CONTENT_METADATA',
        ([contentId, metadata, enrichment]) => ({
            contentId,
            metadata,
            enrichment,
        })
    ),
    dbSearchContent: call(
        'DB_SEARCH_CONTENT',
        ([playlistId, searchTerm, types, excludeHidden, options]) => ({
            playlistId,
            searchTerm,
            types,
            excludeHidden,
            options,
        })
    ),
    dbGlobalSearch: call(
        'DB_GLOBAL_SEARCH',
        ([searchTerm, types, excludeHidden, sources, options]) => ({
            searchTerm,
            types,
            excludeHidden,
            sources,
            options,
        })
    ),
    dbDeleteXtreamContent: call(
        'DB_DELETE_XTREAM_CONTENT',
        ([playlistId, operationId]) => ({ playlistId, operationId })
    ),
    dbRestoreXtreamUserData: call(
        'DB_RESTORE_XTREAM_USER_DATA',
        ([playlistId, favorites, recentlyViewed, operationId]) => ({
            playlistId,
            favorites,
            recentlyViewed,
            operationId,
        })
    ),

    dbAddFavorite: call(
        'DB_ADD_FAVORITE',
        ([contentId, playlistId, backdropUrl]) => ({
            contentId,
            playlistId,
            backdropUrl,
        })
    ),
    dbRemoveFavorite: call(
        'DB_REMOVE_FAVORITE',
        ([contentId, playlistId]) => ({ contentId, playlistId })
    ),
    dbIsFavorite: call(
        'DB_IS_FAVORITE',
        ([contentId, playlistId]) => ({ contentId, playlistId })
    ),
    dbGetFavorites: call('DB_GET_FAVORITES', ([playlistId]) => ({ playlistId })),
    dbGetGlobalFavorites: call('DB_GET_GLOBAL_FAVORITES', () => ({})),
    dbGetAllGlobalFavorites: call('DB_GET_ALL_GLOBAL_FAVORITES', () => ({})),
    dbReorderGlobalFavorites: call(
        'DB_REORDER_GLOBAL_FAVORITES',
        ([updates]) => ({ updates })
    ),

    dbGetRecentlyViewed: call('DB_GET_RECENTLY_VIEWED', () => ({})),
    dbClearRecentlyViewed: call('DB_CLEAR_RECENTLY_VIEWED', () => ({})),
    dbGetRecentItems: call('DB_GET_RECENT_ITEMS', ([playlistId]) => ({
        playlistId,
    })),
    dbAddRecentItem: call(
        'DB_ADD_RECENT_ITEM',
        ([contentId, playlistId, backdropUrl]) => ({
            contentId,
            playlistId,
            backdropUrl,
        })
    ),
    dbClearPlaylistRecentItems: call(
        'DB_CLEAR_PLAYLIST_RECENT_ITEMS',
        ([playlistId]) => ({ playlistId })
    ),
    dbRemoveRecentItem: call(
        'DB_REMOVE_RECENT_ITEM',
        ([contentId, playlistId]) => ({ contentId, playlistId })
    ),
    dbRemoveRecentItemsBatch: call(
        'DB_REMOVE_RECENT_ITEMS_BATCH',
        ([items]) => ({ items })
    ),

    dbSavePlaybackPosition: call(
        'DB_SAVE_PLAYBACK_POSITION',
        ([playlistId, data]) => ({ playlistId, data })
    ),
    dbGetPlaybackPosition: call(
        'DB_GET_PLAYBACK_POSITION',
        ([playlistId, contentXtreamId, contentType]) => ({
            playlistId,
            contentXtreamId,
            contentType,
        })
    ),
    dbGetSeriesPlaybackPositions: call(
        'DB_GET_SERIES_PLAYBACK_POSITIONS',
        ([playlistId, seriesXtreamId]) => ({ playlistId, seriesXtreamId })
    ),
    dbGetRecentPlaybackPositions: call(
        'DB_GET_RECENT_PLAYBACK_POSITIONS',
        ([playlistId, limit]) => ({ playlistId, limit })
    ),
    dbGetAllPlaybackPositions: call(
        'DB_GET_ALL_PLAYBACK_POSITIONS',
        ([playlistId]) => ({ playlistId })
    ),
    dbClearAllPlaybackPositions: call(
        'DB_CLEAR_ALL_PLAYBACK_POSITIONS',
        ([playlistId]) => ({ playlistId })
    ),
    dbClearPlaybackPosition: call(
        'DB_CLEAR_PLAYBACK_POSITION',
        ([playlistId, contentXtreamId, contentType]) => ({
            playlistId,
            contentXtreamId,
            contentType,
        })
    ),

    dbGetTmdbMetadata: call(
        'DB_GET_TMDB_METADATA',
        ([mediaType, lookupKey, language]) => ({
            mediaType,
            lookupKey,
            language,
        })
    ),
    dbSetTmdbMetadata: call('DB_SET_TMDB_METADATA', ([entry]) => ({ entry })),
    dbGetTmdbCacheStats: call('DB_GET_TMDB_CACHE_STATS', () => ({})),
    dbClearTmdbMetadata: call('DB_CLEAR_TMDB_METADATA', () => ({})),
    dbMatchTitles: call('DB_MATCH_TITLES', ([titles]) => ({ titles })),
};

const webApiBaseUrl =
    (globalThis as typeof globalThis & { ARM_NATOR_WEB_API_URL?: string })
        .ARM_NATOR_WEB_API_URL ?? 'http://127.0.0.1:4310/api';

async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${webApiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const payload = (await response.json()) as {
        result?: T;
        error?: string;
    };
    if (!response.ok) {
        throw Object.assign(
            new Error(payload.error ?? `Web API request failed (${response.status})`),
            { status: response.status }
        );
    }
    return Object.prototype.hasOwnProperty.call(payload, 'result')
        ? (payload.result as T)
        : (payload as T);
}

function createWebBridge(): ElectronBridgeApi {
    const bridge = new Proxy(
        { platform: 'web' },
        {
            get(target, property: string | symbol) {
                if (property === 'platform') {
                    return target.platform;
                }

                if (typeof property !== 'string') {
                    return undefined;
                }

                const dbMethod = DB_METHODS[property];
                if (dbMethod) {
                    return (...args: unknown[]) => {
                        const request = dbMethod(args);
                        return postJson('/db', request);
                    };
                }

                if (property === 'dbCancelOperation') {
                    return (operationId: string) =>
                        postJson('/db/cancel', { operationId });
                }

                if (property === 'xtreamRequest') {
                    return (payload: unknown) => postJson('/xtream', payload);
                }

                if (property === 'stalkerRequest') {
                    return (payload: unknown) => postJson('/stalker', payload);
                }

                if (property === 'getPlaybackRecoveryAvailability') {
                    return (accountRef: string) =>
                        postJson('/playback/recovery-availability', { accountRef });
                }

                if (property === 'clearPlaybackAccountProfile') {
                    return (accountRef: string) =>
                        postJson('/playback/clear-profile', { accountRef });
                }

                if (
                    property === 'createDashProxySession' ||
                    property === 'registerDashProxyResource' ||
                    property === 'registerDashProxyLicense'
                ) {
                    return async () => {
                        throw new Error('DASH media proxy sessions require the Electron desktop app.');
                    };
                }

                if (property === 'releaseDashProxySession') {
                    return async () => undefined;
                }

                if (property === 'onBrowserViewUpdate') {
                    return () => () => undefined;
                }

                if (property === 'openBrowserView') {
                    return async () => {
                        throw new Error(
                            'The in-app browser is available in the Electron desktop app.'
                        );
                    };
                }

                if (property === 'setBrowserViewBounds') {
                    return async () => undefined;
                }

                if (property === 'executeBrowserCommand') {
                    return async () => {
                        throw new Error(
                            'Browser commands are unavailable on the web.'
                        );
                    };
                }

                if (property === 'closeBrowserView') {
                    return async () => undefined;
                }

                return undefined;
            },
        }
    );

    return bridge as unknown as ElectronBridgeApi;
}

export function installWebElectronBridge(): void {
    if (typeof window === 'undefined' || window.electron) {
        return;
    }

    window.electron = createWebBridge();
}
