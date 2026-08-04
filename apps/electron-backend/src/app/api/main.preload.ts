/* eslint-disable max-lines */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
    createPreloadPerformanceCapture,
    toPreloadPerformanceTargetMethod,
} from './preload-performance-capture';
import type {
    EmbeddedMpvBounds,
    EmbeddedMpvSession,
    EmbeddedMpvSupport,
    OpenSubtitlesSearchRequest,
    OpenSubtitlesSearchResult,
    OpenSubtitlesDownloadRequest,
    OpenSubtitlesDownloadedSubtitle,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
    ElectronBridgeApi,
    CredentialTestBatchStartRequest,
    CredentialTestProgress,
    ElectronBridgeDbOperationEvent,
    ElectronBridgePlaybackPositionInput,
    ElectronBridgePlaylistInput,
    ElectronBridgePlaylistUpsertInput,
    ElectronBridgeTrustOptions,
    ElectronBridgeWindowState,
    ElectronBridgeXtreamContentStream,
    ExternalPlayerSession,
    ExternalPlayerControlAction,
    GlobalSearchPaginationOptions,
    GlobalSearchResultSource,
    PlaybackPositionData,
    PlayerContentInfo,
    PlaybackNetworkInspection,
    PlayerEngineAvailability,
    Playlist,
    PlaylistRefreshEvent,
    PlaylistRefreshPayload,
    PortalDebugEvent,
    ResolvedPortalPlayback,
    Settings,
    TmdbCacheEntry,
    TmdbCacheMediaType,
    XtreamCategory,
    XtreamContentMetadata,
    XtreamMetadataEnrichmentState,
} from '@arm-nator/shared/interfaces';
import type {
    BrowserViewCommand,
    BrowserViewBounds,
    BrowserViewBoundsTarget,
    BrowserViewMode,
    BrowserViewState,
} from '@arm-nator/shared/interfaces';
import {
    DEBUG_TRACE_EVENT_CHANNEL,
    isPerformanceCaptureEnabled,
    isRendererApiTraceEnabled,
    roundTraceDuration,
    summarizeForTrace,
} from '../services/debug-trace';

const PORTAL_DEBUG_EVENT = 'PORTAL_DEBUG_EVENT';
const EXTERNAL_PLAYER_SESSION_UPDATE = 'EXTERNAL_PLAYER_SESSION_UPDATE';
const EMBEDDED_MPV_SESSION_UPDATE = 'EMBEDDED_MPV_SESSION_UPDATE';
const DB_OPERATION_EVENT = 'DB_OPERATION_EVENT';
const PLAYLIST_REFRESH_EVENT = 'PLAYLIST:REFRESH_EVENT';
const WINDOW_MINIMIZE = 'WINDOW:MINIMIZE';
const WINDOW_TOGGLE_MAXIMIZE = 'WINDOW:TOGGLE_MAXIMIZE';
const WINDOW_CLOSE = 'WINDOW:CLOSE';
const WINDOW_GET_STATE = 'WINDOW:GET_STATE';
const WINDOW_STATE_CHANGED = 'WINDOW:STATE_CHANGED';
const CREDENTIAL_TESTER_IPC = {
    cancel: 'IPTV_CREDENTIAL_TEST_CANCEL',
    progress: 'IPTV_CREDENTIAL_TEST_PROGRESS',
    start: 'IPTV_CREDENTIAL_TEST_START',
} as const;
const BROWSER_VIEW_CLOSE = 'BROWSER:CLOSE';
const BROWSER_VIEW_COMMAND = 'BROWSER:COMMAND';
const BROWSER_VIEW_OPEN = 'BROWSER:OPEN';
const BROWSER_VIEW_SET_BOUNDS = 'BROWSER:SET_BOUNDS';
const BROWSER_VIEW_UPDATE = 'BROWSER:UPDATE';

const dbSaveContentProgressListeners = new Set<
    (
        event: Electron.IpcRendererEvent,
        data: ElectronBridgeDbOperationEvent
    ) => void
>();

const shouldTraceRendererApi = isRendererApiTraceEnabled();
const shouldCapturePerformance = isPerformanceCaptureEnabled();
const preloadPerformanceCapture = createPreloadPerformanceCapture(
    shouldCapturePerformance,
    (channel, marker) => ipcRenderer.send(channel, marker)
);

function emitRendererTrace(payload: {
    method: string;
    phase: 'start' | 'success' | 'error';
    args?: unknown;
    durationMs?: number;
    error?: unknown;
    result?: unknown;
}): void {
    if (!shouldTraceRendererApi) {
        return;
    }

    ipcRenderer.send(DEBUG_TRACE_EVENT_CHANNEL, payload);
}

function wrapElectronApi<T extends object>(api: T): T {
    if (!shouldTraceRendererApi && !shouldCapturePerformance) {
        return api;
    }

    return Object.fromEntries(
        Object.entries(api).map(([name, value]) => {
            if (
                typeof value !== 'function' ||
                name.startsWith('on') ||
                name.startsWith('remove') ||
                (!shouldTraceRendererApi &&
                    !toPreloadPerformanceTargetMethod(name))
            ) {
                return [name, value];
            }

            const original = value as (...args: unknown[]) => unknown;

            return [
                name,
                (...args: unknown[]) => {
                    const startedAt = shouldTraceRendererApi
                        ? (globalThis.performance?.now?.() ?? Date.now())
                        : 0;
                    if (shouldTraceRendererApi) {
                        emitRendererTrace({
                            args: summarizeForTrace(args),
                            method: name,
                            phase: 'start',
                        });
                    }
                    const performanceCall = preloadPerformanceCapture.start(
                        name,
                        args
                    );

                    try {
                        const result = original(...args);

                        if (
                            result &&
                            typeof (result as PromiseLike<unknown>).then ===
                                'function'
                        ) {
                            return (result as Promise<unknown>)
                                .then((resolvedValue) => {
                                    if (shouldTraceRendererApi) {
                                        emitRendererTrace({
                                            durationMs: roundTraceDuration(
                                                (globalThis.performance?.now?.() ??
                                                    Date.now()) - startedAt
                                            ),
                                            method: name,
                                            phase: 'success',
                                            result: summarizeForTrace(
                                                resolvedValue
                                            ),
                                        });
                                    }
                                    preloadPerformanceCapture.success(
                                        performanceCall,
                                        resolvedValue
                                    );
                                    return resolvedValue;
                                })
                                .catch((error: unknown) => {
                                    if (shouldTraceRendererApi) {
                                        emitRendererTrace({
                                            durationMs: roundTraceDuration(
                                                (globalThis.performance?.now?.() ??
                                                    Date.now()) - startedAt
                                            ),
                                            error: summarizeForTrace(error),
                                            method: name,
                                            phase: 'error',
                                        });
                                    }
                                    preloadPerformanceCapture.error(
                                        performanceCall
                                    );
                                    throw error;
                                });
                        }

                        if (shouldTraceRendererApi) {
                            emitRendererTrace({
                                durationMs: roundTraceDuration(
                                    (globalThis.performance?.now?.() ??
                                        Date.now()) - startedAt
                                ),
                                method: name,
                                phase: 'success',
                                result: summarizeForTrace(result),
                            });
                        }
                        preloadPerformanceCapture.success(
                            performanceCall,
                            result
                        );

                        return result;
                    } catch (error) {
                        if (shouldTraceRendererApi) {
                            emitRendererTrace({
                                durationMs: roundTraceDuration(
                                    (globalThis.performance?.now?.() ??
                                        Date.now()) - startedAt
                                ),
                                error: summarizeForTrace(error),
                                method: name,
                                phase: 'error',
                            });
                        }
                        preloadPerformanceCapture.error(performanceCall);
                        throw error;
                    }
                },
            ];
        })
    ) as T;
}

const electronApi: ElectronBridgeApi = {
    openBrowserView: (mode: BrowserViewMode, url?: string) =>
        ipcRenderer.invoke(BROWSER_VIEW_OPEN, mode, url) as Promise<BrowserViewState>,
    setBrowserViewBounds: (
        bounds: BrowserViewBounds,
        target?: BrowserViewBoundsTarget
    ) => ipcRenderer.invoke(BROWSER_VIEW_SET_BOUNDS, bounds, target),
    executeBrowserCommand: (command: BrowserViewCommand) =>
        ipcRenderer.invoke(BROWSER_VIEW_COMMAND, command) as Promise<BrowserViewState | null>,
    closeBrowserView: (mode?: BrowserViewMode, terminate?: boolean) =>
        ipcRenderer.invoke(BROWSER_VIEW_CLOSE, mode, terminate),
    onBrowserViewUpdate: (callback: (state: BrowserViewState) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, state: BrowserViewState) =>
            callback(state);
        ipcRenderer.on(BROWSER_VIEW_UPDATE, handler);
        return () => ipcRenderer.off(BROWSER_VIEW_UPDATE, handler);
    },
    // Player error listener
    onPlayerError: (
        callback: (data: {
            player: string;
            error: string;
            originalError: string;
        }) => void
    ) => {
        ipcRenderer.on('player-error', (_event, data) => callback(data));
    },
    onPortalDebugEvent: (callback: (data: PortalDebugEvent) => void) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: PortalDebugEvent
        ) => callback(data);
        ipcRenderer.on(PORTAL_DEBUG_EVENT, handler);
        return () => ipcRenderer.off(PORTAL_DEBUG_EVENT, handler);
    },
    // Playback position update listener - returns unsubscribe function
    onPlaybackPositionUpdate: (
        callback: (data: PlaybackPositionData) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: PlaybackPositionData
        ) => callback(data);
        ipcRenderer.on('playback-position-update', handler);
        return () => ipcRenderer.off('playback-position-update', handler);
    },
    onExternalPlayerSessionUpdate: (
        callback: (data: ExternalPlayerSession) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: ExternalPlayerSession
        ) => callback(data);
        ipcRenderer.on(EXTERNAL_PLAYER_SESSION_UPDATE, handler);
        return () => ipcRenderer.off(EXTERNAL_PLAYER_SESSION_UPDATE, handler);
    },
    onEmbeddedMpvSessionUpdate: (
        callback: (data: EmbeddedMpvSession) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: EmbeddedMpvSession
        ) => callback(data);
        ipcRenderer.on(EMBEDDED_MPV_SESSION_UPDATE, handler);
        return () => ipcRenderer.off(EMBEDDED_MPV_SESSION_UPDATE, handler);
    },
    onDbOperationEvent: (
        callback: (data: ElectronBridgeDbOperationEvent) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: ElectronBridgeDbOperationEvent
        ) => callback(data);
        ipcRenderer.on(DB_OPERATION_EVENT, handler);
        return () => ipcRenderer.off(DB_OPERATION_EVENT, handler);
    },
    onPlaylistRefreshEvent: (
        callback: (data: PlaylistRefreshEvent) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: PlaylistRefreshEvent
        ) => callback(data);
        ipcRenderer.on(PLAYLIST_REFRESH_EVENT, handler);
        return () => ipcRenderer.off(PLAYLIST_REFRESH_EVENT, handler);
    },
    // DB save content progress listener
    onDbSaveContentProgress: (callback: (count: number) => void) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            data: ElectronBridgeDbOperationEvent
        ) => {
            if (
                data.operation !== 'save-content' ||
                data.status !== 'progress'
            ) {
                return;
            }

            callback(data.increment ?? data.current ?? 0);
        };

        dbSaveContentProgressListeners.add(handler);
        ipcRenderer.on(DB_OPERATION_EVENT, handler);
    },
    // Remove DB save content progress listener
    removeDbSaveContentProgress: () => {
        dbSaveContentProgressListeners.forEach((handler) => {
            ipcRenderer.off(DB_OPERATION_EVENT, handler);
        });
        dbSaveContentProgressListeners.clear();
    },
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    platform: process.platform,
    minimizeWindow: () => ipcRenderer.invoke(WINDOW_MINIMIZE),
    toggleMaximizeWindow: () => ipcRenderer.invoke(WINDOW_TOGGLE_MAXIMIZE),
    closeWindow: () => ipcRenderer.invoke(WINDOW_CLOSE),
    getWindowState: () => ipcRenderer.invoke(WINDOW_GET_STATE),
    onWindowStateChange: (
        callback: (state: ElectronBridgeWindowState) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            state: ElectronBridgeWindowState
        ) => callback(state);
        ipcRenderer.on(WINDOW_STATE_CHANGED, handler);
        return () => ipcRenderer.off(WINDOW_STATE_CHANGED, handler);
    },
    fetchPlaylistByUrl: (
        url: string,
        title?: string,
        options?: ElectronBridgeTrustOptions
    ) => ipcRenderer.invoke('fetch-playlist-by-url', url, title, options),
    updatePlaylistFromFilePath: (filePath: string, title: string) =>
        ipcRenderer.invoke('update-playlist-from-file-path', filePath, title),
    openPlaylistFromFile: () => ipcRenderer.invoke('open-playlist-from-file'),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    saveFileDialog: (
        defaultPath: string,
        filters?: { name: string; extensions: string[] }[]
    ) => ipcRenderer.invoke('save-file-dialog', defaultPath, filters),
    writeFile: (filePath: string, content: string) =>
        ipcRenderer.invoke('write-file', filePath, content),
    setUserAgent: (
        userAgent?: string | null,
        referer?: string | null,
        scopeUrl?: string | null
    ) => ipcRenderer.invoke('set-user-agent', userAgent, referer, scopeUrl),
    openInMpv: (
        url: string,
        title: string,
        thumbnail: string,
        userAgent: string | undefined,
        referer?: string,
        origin?: string,
        contentInfo?: PlayerContentInfo,
        startTime?: number,
        headers?: Record<string, string>,
        subtitleUrl?: string
    ): Promise<ExternalPlayerSession> =>
        ipcRenderer.invoke(
            'OPEN_MPV_PLAYER',
            url,
            title,
            thumbnail,
            userAgent,
            referer,
            origin,
            contentInfo,
            startTime,
            headers,
            subtitleUrl
        ),
    openInVlc: (
        url: string,
        title: string,
        thumbnail: string,
        userAgent: string | undefined,
        referer?: string,
        origin?: string,
        contentInfo?: PlayerContentInfo,
        startTime?: number,
        headers?: Record<string, string>,
        subtitleUrl?: string
    ): Promise<ExternalPlayerSession> =>
        ipcRenderer.invoke(
            'OPEN_VLC_PLAYER',
            url,
            title,
            thumbnail,
            userAgent,
            referer,
            origin,
            contentInfo,
            startTime,
            headers,
            subtitleUrl
        ),
    inspectPlaybackUrl: (
        url: string,
        headers?: Record<string, string>
    ): Promise<PlaybackNetworkInspection> =>
        ipcRenderer.invoke('INSPECT_PLAYBACK_URL', url, headers),
    getPlayerEngineAvailability: (): Promise<PlayerEngineAvailability[]> =>
        ipcRenderer.invoke('GET_PLAYER_ENGINE_AVAILABILITY'),
    closeExternalPlayerSession: (sessionId: string) =>
        ipcRenderer.invoke('CLOSE_EXTERNAL_PLAYER_SESSION', sessionId),
    controlExternalPlayerSession: (
        sessionId: string,
        action: ExternalPlayerControlAction,
        value?: number
    ) =>
        ipcRenderer.invoke(
            'CONTROL_EXTERNAL_PLAYER_SESSION',
            sessionId,
            action,
            value
        ),
    getEmbeddedMpvSupport: (): Promise<EmbeddedMpvSupport> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SUPPORT'),
    prepareEmbeddedMpv: (): Promise<EmbeddedMpvSupport> =>
        ipcRenderer.invoke('EMBEDDED_MPV_PREPARE'),
    createEmbeddedMpvSession: (
        bounds: EmbeddedMpvBounds,
        title?: string,
        initialVolume?: number
    ): Promise<EmbeddedMpvSession> =>
        ipcRenderer.invoke(
            'EMBEDDED_MPV_CREATE_SESSION',
            bounds,
            title,
            initialVolume
        ),
    loadEmbeddedMpvPlayback: (
        sessionId: string,
        playback: ResolvedPortalPlayback
    ): Promise<void> =>
        ipcRenderer.invoke('EMBEDDED_MPV_LOAD_PLAYBACK', sessionId, playback),
    setEmbeddedMpvBounds: (
        sessionId: string,
        bounds: EmbeddedMpvBounds
    ): Promise<void> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_BOUNDS', sessionId, bounds),
    setEmbeddedMpvPaused: (
        sessionId: string,
        paused: boolean
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_PAUSED', sessionId, paused),
    seekEmbeddedMpv: (
        sessionId: string,
        seconds: number
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SEEK', sessionId, seconds),
    setEmbeddedMpvVolume: (
        sessionId: string,
        volume: number
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_VOLUME', sessionId, volume),
    setEmbeddedMpvAudioTrack: (
        sessionId: string,
        trackId: number
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_AUDIO_TRACK', sessionId, trackId),
    setEmbeddedMpvSubtitleTrack: (
        sessionId: string,
        trackId: number
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke(
            'EMBEDDED_MPV_SET_SUBTITLE_TRACK',
            sessionId,
            trackId
        ),
    setEmbeddedMpvSubtitleFile: (
        sessionId: string,
        filePath: string
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke(
            'EMBEDDED_MPV_SET_SUBTITLE_FILE',
            sessionId,
            filePath
        ),
    setEmbeddedMpvSubtitleSettings: (
        sessionId: string,
        settings: PlayerSubtitleSettings
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke(
            'EMBEDDED_MPV_SET_SUBTITLE_SETTINGS',
            sessionId,
            settings
        ),
    setEmbeddedMpvSpeed: (
        sessionId: string,
        speed: number
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_SPEED', sessionId, speed),
    setEmbeddedMpvAspect: (
        sessionId: string,
        aspect: string
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_ASPECT', sessionId, aspect),
    setEmbeddedMpvPicture: (
        sessionId: string,
        picture: PlayerPictureSettings
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_SET_PICTURE', sessionId, picture),
    disposeEmbeddedMpvSession: (
        sessionId: string
    ): Promise<EmbeddedMpvSession | null> =>
        ipcRenderer.invoke('EMBEDDED_MPV_DISPOSE_SESSION', sessionId),
    autoUpdatePlaylists: (
        playlists: Playlist[],
        options?: ElectronBridgeTrustOptions
    ) => ipcRenderer.invoke('AUTO_UPDATE', playlists, options),
    setMpvPlayerPath: (mpvPlayerPath: string) =>
        ipcRenderer.invoke('SET_MPV_PLAYER_PATH', mpvPlayerPath),
    setVlcPlayerPath: (vlcPlayerPath: string) =>
        ipcRenderer.invoke('SET_VLC_PLAYER_PATH', vlcPlayerPath),
    updateSettings: (settings: Partial<Settings>) =>
        ipcRenderer.invoke('SETTINGS_UPDATE', settings),
    getAiSettings: () => ipcRenderer.invoke('GET_AI_SETTINGS'),
    searchOpenSubtitles: (
        request: OpenSubtitlesSearchRequest
    ): Promise<OpenSubtitlesSearchResult[]> =>
        ipcRenderer.invoke('OPEN_SUBTITLES_SEARCH', request),
    downloadOpenSubtitle: (
        request: OpenSubtitlesDownloadRequest
    ): Promise<OpenSubtitlesDownloadedSubtitle> =>
        ipcRenderer.invoke('OPEN_SUBTITLES_DOWNLOAD', request),
    clearOpenSubtitlesCache: (): Promise<void> =>
        ipcRenderer.invoke('OPEN_SUBTITLES_CLEAR_CACHE'),
    xtreamRequest: (payload: {
        url: string;
        params: Record<string, string>;
        requestId?: string;
        sessionId?: string;
        suppressErrorLog?: boolean;
    }) => ipcRenderer.invoke('XTREAM_REQUEST', payload),
    xtreamCancelSession: (sessionId: string) =>
        ipcRenderer.invoke('XTREAM_CANCEL_SESSION', sessionId),
    xtreamProbeUrl: (url: string, method?: 'GET' | 'HEAD') =>
        ipcRenderer.invoke('XTREAM_PROBE_URL', { url, method }),
    startCredentialTestBatch: (request: CredentialTestBatchStartRequest) =>
        ipcRenderer.invoke(CREDENTIAL_TESTER_IPC.start, request),
    cancelCredentialTestBatch: (batchId: string) =>
        ipcRenderer.invoke(CREDENTIAL_TESTER_IPC.cancel, batchId),
    onCredentialTestProgress: (
        callback: (progress: CredentialTestProgress) => void
    ) => {
        const handler = (
            _event: Electron.IpcRendererEvent,
            progress: CredentialTestProgress
        ) => callback(progress);
        ipcRenderer.on(CREDENTIAL_TESTER_IPC.progress, handler);
        return () => ipcRenderer.off(CREDENTIAL_TESTER_IPC.progress, handler);
    },
    refreshPlaylist: (payload: PlaylistRefreshPayload) =>
        ipcRenderer.invoke('PLAYLIST:REFRESH', payload),
    cancelPlaylistRefresh: (operationId: string) =>
        ipcRenderer.invoke('PLAYLIST:CANCEL_REFRESH', operationId),
    // Database operations
    dbCreatePlaylist: (playlist: ElectronBridgePlaylistUpsertInput) =>
        ipcRenderer.invoke('DB_CREATE_PLAYLIST', playlist),
    dbGetPlaylist: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_PLAYLIST', playlistId),
    dbUpsertAppPlaylist: (playlist: Playlist, _operationId?: string) =>
        ipcRenderer.invoke('DB_UPSERT_APP_PLAYLIST', playlist),
    dbUpsertAppPlaylists: (playlists: Playlist[]) =>
        ipcRenderer.invoke('DB_UPSERT_APP_PLAYLISTS', playlists),
    dbGetAppPlaylists: () => ipcRenderer.invoke('DB_GET_APP_PLAYLISTS'),
    dbGetAppPlaylistMetas: () =>
        ipcRenderer.invoke('DB_GET_APP_PLAYLIST_METAS'),
    dbGetAppPlaylist: (playlistId: string, _operationId?: string) =>
        ipcRenderer.invoke('DB_GET_APP_PLAYLIST', playlistId),
    dbGetAppPlaylistFavoriteChannels: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_APP_PLAYLIST_FAVORITE_CHANNELS', playlistId),
    dbUpdatePlaylist: (
        playlistId: string,
        updates: Partial<Playlist> | ElectronBridgePlaylistInput
    ) => ipcRenderer.invoke('DB_UPDATE_PLAYLIST', playlistId, updates),
    dbDeletePlaylist: (playlistId: string, operationId?: string) =>
        ipcRenderer.invoke('DB_DELETE_PLAYLIST', playlistId, operationId),
    dbDeleteXtreamContent: (playlistId: string, operationId?: string) =>
        ipcRenderer.invoke('DB_DELETE_XTREAM_CONTENT', playlistId, operationId),
    dbRestoreXtreamUserData: (
        playlistId: string,
        favorites: unknown[],
        recentlyViewed: unknown[],
        operationId?: string
    ) =>
        ipcRenderer.invoke(
            'DB_RESTORE_XTREAM_USER_DATA',
            playlistId,
            favorites,
            recentlyViewed,
            operationId
        ),
    dbHasCategories: (playlistId: string, type: string) =>
        ipcRenderer.invoke('DB_HAS_CATEGORIES', playlistId, type),
    dbGetCategories: (playlistId: string, type: string) =>
        ipcRenderer.invoke('DB_GET_CATEGORIES', playlistId, type),
    dbSaveCategories: (
        playlistId: string,
        categories: XtreamCategory[],
        type: string,
        hiddenCategoryXtreamIds?: number[]
    ) =>
        ipcRenderer.invoke(
            'DB_SAVE_CATEGORIES',
            playlistId,
            categories,
            type,
            hiddenCategoryXtreamIds
        ),
    dbGetAllCategories: (playlistId: string, type: string) =>
        ipcRenderer.invoke('DB_GET_ALL_CATEGORIES', playlistId, type),
    dbUpdateCategoryVisibility: (categoryIds: number[], hidden: boolean) =>
        ipcRenderer.invoke(
            'DB_UPDATE_CATEGORY_VISIBILITY',
            categoryIds,
            hidden
        ),
    dbHasContent: (playlistId: string, type: string) =>
        ipcRenderer.invoke('DB_HAS_CONTENT', playlistId, type),
    dbGetContent: (playlistId: string, type: string) =>
        ipcRenderer.invoke('DB_GET_CONTENT', playlistId, type),
    dbGetXtreamMetadataIndexStatus: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_XTREAM_METADATA_INDEX_STATUS', playlistId),
    dbSaveContent: (
        playlistId: string,
        streams: ElectronBridgeXtreamContentStream[],
        type: string,
        operationId?: string
    ) =>
        ipcRenderer.invoke(
            'DB_SAVE_CONTENT',
            playlistId,
            streams,
            type,
            operationId
        ),
    dbClearXtreamImportCache: (
        playlistId: string,
        type: 'live' | 'movie' | 'series'
    ) => ipcRenderer.invoke('DB_CLEAR_XTREAM_IMPORT_CACHE', playlistId, type),
    dbSearchContent: (
        playlistId: string,
        searchTerm: string,
        types: string[],
        excludeHidden?: boolean
    ) =>
        ipcRenderer.invoke(
            'DB_SEARCH_CONTENT',
            playlistId,
            searchTerm,
            types,
            excludeHidden
        ),
    dbGlobalSearch: (
        searchTerm: string,
        types: string[],
        excludeHidden?: boolean,
        sources?: GlobalSearchResultSource[],
        options?: GlobalSearchPaginationOptions
    ) => {
        if (sources?.length || options) {
            return ipcRenderer.invoke(
                'DB_GLOBAL_SEARCH',
                searchTerm,
                types,
                excludeHidden,
                sources,
                options
            );
        }

        return ipcRenderer.invoke(
            'DB_GLOBAL_SEARCH',
            searchTerm,
            types,
            excludeHidden
        );
    },
    dbGetGlobalRecentlyAdded: (
        kind: 'all' | 'vod' | 'series',
        limit?: number,
        playlistType?:
            'xtream' | 'm3u-file' | 'm3u-text' | 'm3u-url'
    ) =>
        ipcRenderer.invoke(
            'DB_GET_GLOBAL_RECENTLY_ADDED',
            kind,
            limit,
            playlistType
        ),
    dbGetRecentlyViewed: () => ipcRenderer.invoke('DB_GET_RECENTLY_VIEWED'),
    dbClearRecentlyViewed: () => ipcRenderer.invoke('DB_CLEAR_RECENTLY_VIEWED'),
    // Favorites
    dbAddFavorite: (
        contentId: number,
        playlistId: string,
        backdropUrl?: string
    ) =>
        ipcRenderer.invoke(
            'DB_ADD_FAVORITE',
            contentId,
            playlistId,
            backdropUrl
        ),
    dbRemoveFavorite: (contentId: number, playlistId: string) =>
        ipcRenderer.invoke('DB_REMOVE_FAVORITE', contentId, playlistId),
    dbIsFavorite: (contentId: number, playlistId: string) =>
        ipcRenderer.invoke('DB_IS_FAVORITE', contentId, playlistId),
    dbGetFavorites: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_FAVORITES', playlistId),
    dbGetGlobalFavorites: () => ipcRenderer.invoke('DB_GET_GLOBAL_FAVORITES'),
    dbGetAllGlobalFavorites: () =>
        ipcRenderer.invoke('DB_GET_ALL_GLOBAL_FAVORITES'),
    dbReorderGlobalFavorites: (
        updates: { content_id: number; playlist_id: string; position: number }[]
    ) => ipcRenderer.invoke('DB_REORDER_GLOBAL_FAVORITES', updates),
    // Recently viewed (playlist-specific)
    dbGetRecentItems: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_RECENT_ITEMS', playlistId),
    dbAddRecentItem: (
        contentId: number,
        playlistId: string,
        backdropUrl?: string
    ) =>
        ipcRenderer.invoke(
            'DB_ADD_RECENT_ITEM',
            contentId,
            playlistId,
            backdropUrl
        ),
    dbClearPlaylistRecentItems: (playlistId: string) =>
        ipcRenderer.invoke('DB_CLEAR_PLAYLIST_RECENT_ITEMS', playlistId),
    dbRemoveRecentItem: (contentId: number, playlistId: string) =>
        ipcRenderer.invoke('DB_REMOVE_RECENT_ITEM', contentId, playlistId),
    dbRemoveRecentItemsBatch: (
        items: { contentId: number; playlistId: string }[]
    ) => ipcRenderer.invoke('DB_REMOVE_RECENT_ITEMS_BATCH', items),
    dbGetContentByXtreamId: (
        xtreamId: number,
        playlistId: string,
        contentType?: 'live' | 'movie' | 'series'
    ) =>
        ipcRenderer.invoke(
            'DB_GET_CONTENT_BY_XTREAM_ID',
            xtreamId,
            playlistId,
            contentType
        ),
    dbSetContentBackdropIfMissing: (contentId: number, backdropUrl?: string) =>
        ipcRenderer.invoke(
            'DB_SET_CONTENT_BACKDROP_IF_MISSING',
            contentId,
            backdropUrl
        ),
    dbUpdateXtreamContentMetadata: (
        contentId: number,
        metadata: XtreamContentMetadata,
        enrichment?: XtreamMetadataEnrichmentState
    ) =>
        ipcRenderer.invoke(
            'DB_UPDATE_XTREAM_CONTENT_METADATA',
            contentId,
            metadata,
            enrichment
        ),
    dbDeleteAllPlaylists: (operationId?: string) =>
        ipcRenderer.invoke('DB_DELETE_ALL_PLAYLISTS', operationId),
    dbCancelOperation: (operationId: string) =>
        ipcRenderer.invoke('DB_CANCEL_OPERATION', operationId),
    dbGetAppState: (key: string) => ipcRenderer.invoke('DB_GET_APP_STATE', key),
    dbSetAppState: (key: string, value: string) =>
        ipcRenderer.invoke('DB_SET_APP_STATE', key, value),
    // TMDB metadata cache
    dbGetTmdbMetadata: (
        mediaType: TmdbCacheMediaType,
        lookupKey: string,
        language: string
    ) =>
        ipcRenderer.invoke(
            'DB_GET_TMDB_METADATA',
            mediaType,
            lookupKey,
            language
        ),
    dbSetTmdbMetadata: (entry: TmdbCacheEntry) =>
        ipcRenderer.invoke('DB_SET_TMDB_METADATA', entry),
    dbGetTmdbCacheStats: () => ipcRenderer.invoke('DB_GET_TMDB_CACHE_STATS'),
    dbClearTmdbMetadata: () => ipcRenderer.invoke('DB_CLEAR_TMDB_METADATA'),
    dbMatchTitles: (titles: string[]) =>
        ipcRenderer.invoke('DB_MATCH_TITLES', titles),
    // Playback Positions
    dbSavePlaybackPosition: (
        playlistId: string,
        data: ElectronBridgePlaybackPositionInput
    ) => ipcRenderer.invoke('DB_SAVE_PLAYBACK_POSITION', playlistId, data),
    dbGetPlaybackPosition: (
        playlistId: string,
        contentXtreamId: number,
        contentType: 'vod' | 'episode'
    ) =>
        ipcRenderer.invoke(
            'DB_GET_PLAYBACK_POSITION',
            playlistId,
            contentXtreamId,
            contentType
        ),
    dbGetSeriesPlaybackPositions: (
        playlistId: string,
        seriesXtreamId: number
    ) =>
        ipcRenderer.invoke(
            'DB_GET_SERIES_PLAYBACK_POSITIONS',
            playlistId,
            seriesXtreamId
        ),
    dbGetRecentPlaybackPositions: (playlistId: string, limit?: number) =>
        ipcRenderer.invoke(
            'DB_GET_RECENT_PLAYBACK_POSITIONS',
            playlistId,
            limit
        ),
    dbGetAllPlaybackPositions: (playlistId: string) =>
        ipcRenderer.invoke('DB_GET_ALL_PLAYBACK_POSITIONS', playlistId),
    dbClearAllPlaybackPositions: (playlistId: string) =>
        ipcRenderer.invoke('DB_CLEAR_ALL_PLAYBACK_POSITIONS', playlistId),
    dbClearPlaybackPosition: (
        playlistId: string,
        contentXtreamId: number,
        contentType: 'vod' | 'episode'
    ) =>
        ipcRenderer.invoke(
            'DB_CLEAR_PLAYBACK_POSITION',
            playlistId,
            contentXtreamId,
            contentType
        ),
};

contextBridge.exposeInMainWorld('electron', wrapElectronApi(electronApi));
