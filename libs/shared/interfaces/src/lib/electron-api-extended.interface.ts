import type {SourceCandidateQuery,SourcePlaybackCandidate} from './source-playback-evidence';
import type {SourceAccountSnapshot,SourceEvidenceSnapshot,SourceEvidenceWrite} from './source-playback-evidence';
import type { StalkerSearchRequestPayload, StalkerSearchPageResponse } from './stalker-request.interface';
import type { StalkerRequestPayload } from './stalker-request.interface';
import type { TitleTrackPreferences } from './title-track-preferences';
import type { ViewingItem, ViewingStateUpdate, CatalogueItemIdentity, ViewingResume, ViewingHistoryEntry } from './viewing-continuity';
import { EmbeddedMpvBounds, EmbeddedMpvSession, EmbeddedMpvSupport } from './embedded-mpv-session.interface';
import type { ElectronBridgeKsPlayerMetalApi } from './electron-api.interface';
import { ExternalPlayerControlAction, ExternalPlayerSession } from './external-player-session.interface';
import { GlobalSearchPaginationOptions, GlobalSearchResult, GlobalSearchResultSource } from './global-search-result.interface';
import { PlaybackPositionData } from './playback-position.interface';
import { XtreamBackupFavoriteItem, XtreamBackupHiddenCategory, XtreamBackupRecentlyViewedItem } from './playlist-backup.interface';
import { Playlist } from './playlist.interface';
import { AutoPlaybackPreparationResult, PlaybackNetworkInspection, PlayerContentInfo, PlayerEngineAvailability, ResolvedPortalPlayback } from './portal-playback.interface';
import { PortalDebugEvent } from './portal-debug.interface';
import { CatalogTitleMatch } from './catalog-title-match.interface';
import type { PlayerPictureSettings } from './video-picture-settings.interface';
import type { PlayerSubtitleSettings } from './player-subtitle-settings.interface';
import type { PlaybackRequestPolicy, PlaybackResourceKind } from './playback-recovery.interface';
import type {
    XtreamContentMetadata,
    XtreamMetadataEnrichmentState,
} from './catalog-metadata.util';
import { Settings } from './settings.interface';
import { TmdbCacheEntry, TmdbCacheMediaType, TmdbCacheStats } from './tmdb.interface';
import { XtreamCategory } from './xtream-category.interface';
import {
    OpenSubtitlesDownloadRequest,
    OpenSubtitlesDownloadedSubtitle,
    OpenSubtitlesSearchRequest,
    OpenSubtitlesSearchResult,
} from './open-subtitles.interface';
import type {
    BrowserGuestSurfaceState,
    BrowserViewBounds,
    BrowserViewBoundsTarget,
    BrowserViewCommand,
    BrowserViewMode,
    BrowserViewState,
} from './browser-view.interface';
import type {
    CredentialTestBatchStartRequest,
    CredentialTestProgress,
} from './credential-tester.interface';
export const ELECTRON_BRIDGE_CONTENT_TYPES = {
    Episode: "episode",
    Live: "live",
    Movie: "movie",
    Series: "series",
    Vod: "vod",
} as const;
export type ElectronBridgeContentType = (typeof ELECTRON_BRIDGE_CONTENT_TYPES)[keyof typeof ELECTRON_BRIDGE_CONTENT_TYPES];
export type ElectronBridgePortalContentType = typeof ELECTRON_BRIDGE_CONTENT_TYPES.Live | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Movie | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Series;
export type ElectronBridgePlaybackContentType = typeof ELECTRON_BRIDGE_CONTENT_TYPES.Vod | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Episode;
export const ELECTRON_BRIDGE_PLAYLIST_TYPES = {
    Xtream: "xtream",
} as const;
export type ElectronBridgePlaylistType = (typeof ELECTRON_BRIDGE_PLAYLIST_TYPES)[keyof typeof ELECTRON_BRIDGE_PLAYLIST_TYPES];
export const ELECTRON_BRIDGE_SECURITY_ERROR_CODES = {
    InvalidTlsCertificate: "invalid-tls-certificate",
} as const;
export type ElectronBridgeSecurityErrorCode = (typeof ELECTRON_BRIDGE_SECURITY_ERROR_CODES)[keyof typeof ELECTRON_BRIDGE_SECURITY_ERROR_CODES];
export const ELECTRON_BRIDGE_DB_OPERATION_STATUSES = {
    Cancelled: "cancelled",
    Completed: "completed",
    Error: "error",
    Progress: "progress",
    Started: "started",
} as const;
export type ElectronBridgeDbOperationStatus = (typeof ELECTRON_BRIDGE_DB_OPERATION_STATUSES)[keyof typeof ELECTRON_BRIDGE_DB_OPERATION_STATUSES];
export const ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS = {
    All: "all",
    Series: "series",
    Vod: "vod",
} as const;
export type ElectronBridgeGlobalRecentlyAddedKind = (typeof ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS)[keyof typeof ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS];
export interface ElectronBridgeResult {
    success: boolean;
}
export interface ElectronBridgeErrorResult extends ElectronBridgeResult {
    error?: string;
}
export interface ElectronBridgeCountResult extends ElectronBridgeResult {
    count: number;
}
export interface ElectronBridgeDialogFilter {
    name: string;
    extensions: string[];
}
export interface ElectronBridgeWindowState {
    isMaximized: boolean;
    isFullScreen: boolean;
}
export interface ElectronBridgeAiSettings {
    aiProvider: string;
    aiModelName: string;
    aiApiKey: string;
}
export interface ElectronBridgeXtreamRequestPayload {
    url: string;
    params: Record<string, string>;
    requestId?: string;
    sessionId?: string;
    suppressErrorLog?: boolean;
    /** Stable playlist id; contains no provider credentials. */
    accountRef?: string;
}
export interface ElectronBridgeXtreamResponse {
    payload: unknown;
    action: string;
}
export interface ElectronBridgeXtreamFailure {
    error: {
        type: 'ERROR';
        message: string;
        status: number;
        name?: 'AbortError';
    };
}
export interface ElectronBridgeXtreamCancelResult extends ElectronBridgeResult {
    cancelled: number;
}
export interface ElectronBridgeXtreamProbeResult {
    status: number;
    url: string;
}
export interface ElectronBridgeTrustOptions {
    trustedInsecureTlsHosts?: string[];
}
export interface ElectronBridgeDbOperationEvent {
    operationId?: string;
    operation: string;
    playlistId?: string;
    status: ElectronBridgeDbOperationStatus;
    phase?: string;
    current?: number;
    total?: number;
    increment?: number;
    error?: string;
}
export interface ElectronBridgePlaylistInput {
    id?: string;
    _id?: string;
    name?: string;
    title?: string;
    serverUrl?: string;
    username?: string;
    password?: string;
    macAddress?: string;
    url?: string;
    type?: ElectronBridgePlaylistType | string;
    lastUpdated?: string;
}
export interface ElectronBridgePlaylistRow {
    id: string;
    name: string;
    serverUrl: string;
    username: string;
    password: string;
    type: string;
    macAddress?: string;
    url?: string;
    lastUpdated?: string;
}
export type ElectronBridgePlaylistUpsertInput = Playlist | ElectronBridgePlaylistInput;
export interface ElectronBridgeCategoryRow {
    id: number;
    name: string;
    playlist_id: string;
    type: 'movies' | 'live' | 'series';
    xtream_id: number;
    hidden: boolean;
}
export interface ElectronBridgeXtreamContent {
    id: number;
    category_id: number;
    title: string;
    rating: string;
    genre?: string | null;
    releaseDate?: string | null;
    country?: string | null;
    director?: string | null;
    cast?: string | null;
    description?: string | null;
    metadata_status?: 'complete' | 'failed' | null;
    metadata_attempted_at?: string | null;
    metadata_retry_after?: string | null;
    added: string;
    poster_url: string;
    backdrop_url?: string | null;
    direct_source?: string | null;
    xtream_id: number;
    type: string;
    added_at?: string;
    viewed_at?: string;
    position?: number | null;
}
export type ElectronBridgeXtreamContentStream = {
    category_id: string | number;
    rating?: string | number;
    rating_imdb?: string;
    last_modified?: string;
    added?: string;
    stream_icon?: string;
    poster?: string;
    cover?: string;
    name?: string;
    title?: string;
    direct_source?: string;
    series_id?: string | number;
    stream_id?: string | number;
} | Record<string, unknown>;
export type ElectronBridgeGlobalSearchResult = GlobalSearchResult;
export interface ElectronBridgeGlobalRecentItem extends ElectronBridgeXtreamContent {
    playlist_id: string;
    playlist_name: string;
    viewed_at: string;
}
export interface ElectronBridgeGlobalFavoriteItem extends ElectronBridgeXtreamContent {
    playlist_id: string;
    playlist_name: string;
    added_at: string;
}
export interface ElectronBridgeGlobalRecentlyAddedItem extends ElectronBridgeXtreamContent {
    playlist_id: string;
    playlist_name: string;
    added_at: string;
}
export interface ElectronBridgeFavoriteReorderUpdate {
    content_id: number;
    /** Favorites are playlist-scoped — scope the position write per playlist */
    playlist_id: string;
    position: number;
}
export interface ElectronBridgeRecentItemsBatchItem {
    contentId: number;
    playlistId: string;
}
export interface ElectronBridgePlayerError {
    player: string;
    error: string;
    originalError: string;
}
export interface ElectronBridgePlaybackPositionInput extends Omit<PlaybackPositionData, 'playlistId' | 'updatedAt'> {
    playlistType?: ElectronBridgePlaylistType;
}
export interface ElectronBridgeApi extends ElectronBridgeKsPlayerMetalApi {
    dbGetSourcePlaybackCandidates: (input:SourceCandidateQuery)=>Promise<SourcePlaybackCandidate[]>;
    dbGetSourcePlaybackEvidence: (sourceIds:string[]) => Promise<SourceEvidenceSnapshot[]>;
    dbSaveSourcePlaybackEvidence: (input:SourceEvidenceWrite) => Promise<'saved'|'obsolete'>;
    dbSaveSourcePlaybackAccount: (sourceId:string,revision:string,account:SourceAccountSnapshot) => Promise<'saved'|'obsolete'>;

    onPortalDebugEvent?: (callback: (data: PortalDebugEvent) => void) => () => void;
    getAppVersion: () => Promise<string>;
    platform: string;
    minimizeWindow: () => Promise<void>;
    toggleMaximizeWindow: () => Promise<ElectronBridgeWindowState>;
    closeWindow: () => Promise<void>;
    getWindowState: () => Promise<ElectronBridgeWindowState>;
    onWindowStateChange: (callback: (state: ElectronBridgeWindowState) => void) => () => void;
    saveFileDialog: (defaultPath: string, filters?: ElectronBridgeDialogFilter[]) => Promise<string | null>;
    writeFile: (filePath: string, content: string) => Promise<ElectronBridgeResult>;
    setUserAgent: (userAgent?: string | null, referer?: string | null, scopeUrl?: string | null) => Promise<boolean>;
    openInMpv: (url: string, title: string, thumbnail: string, userAgent: string | undefined, referer?: string, origin?: string, contentInfo?: PlayerContentInfo, startTime?: number, headers?: Record<string, string>, subtitleUrl?: string) => Promise<ExternalPlayerSession>;
    openInVlc: (url: string, title: string, thumbnail: string, userAgent: string | undefined, referer?: string, origin?: string, contentInfo?: PlayerContentInfo, startTime?: number, headers?: Record<string, string>, subtitleUrl?: string) => Promise<ExternalPlayerSession>;
    inspectPlaybackUrl: (url: string, headers?: Record<string, string>) => Promise<PlaybackNetworkInspection>;
    prepareAutoPlayback: (url: string, headers: Record<string, string> | undefined, isLive: boolean, attemptId: string, policy?: PlaybackRequestPolicy) => Promise<AutoPlaybackPreparationResult>;
    cancelAutoPlaybackPreparation: (attemptId: string) => Promise<void>;
    releaseAutoPlaybackSession: (sessionId: string) => Promise<void>;
    recordAutomaticPlaybackDecision: (decision: { sourceUrl: string; sessionId?: string; engine: string; reason: string }) => Promise<void>;
    createHlsProxySession: (url: string, headers?: Record<string, string>, policy?: PlaybackRequestPolicy) => Promise<{ id: string; url: string }>;
    releaseHlsProxySession: (sessionId: string) => Promise<void>;
    createProgressiveVodProxySession: (url: string, headers?: Record<string, string>, policy?: PlaybackRequestPolicy) => Promise<{ id: string; url: string }>;
    releaseProgressiveVodProxySession: (sessionId: string) => Promise<void>;
    createMpegTsProxySession: (url: string, headers?: Record<string, string>, isLive?: boolean, policy?: PlaybackRequestPolicy) => Promise<{ id: string; url: string }>;
    releaseMpegTsProxySession: (sessionId: string) => Promise<void>;
    createDashProxySession: (url: string, headers?: Record<string, string>, policy?: PlaybackRequestPolicy) => Promise<{ id: string; url: string }>;
    registerDashProxyResource: (sessionId: string, targetUrl: string, resourceKind?: PlaybackResourceKind) => Promise<string>;
    registerDashProxyLicense: (sessionId: string, licenseUrl: string, licenseHeaders?: Record<string, string>) => Promise<string>;
    releaseDashProxySession: (sessionId: string) => Promise<void>;
    getPlaybackRecoveryAvailability: (accountRef: string) => Promise<{ loginCookies: boolean; portalCredentials: boolean }>;
    clearPlaybackAccountProfile: (accountRef: string) => Promise<void>;
    getPlayerEngineAvailability: () => Promise<PlayerEngineAvailability[]>;
    updateSettings: (settings: Partial<Settings>) => Promise<void>;
    getAiSettings: () => Promise<ElectronBridgeAiSettings>;
    searchOpenSubtitles: (
        request: OpenSubtitlesSearchRequest
    ) => Promise<OpenSubtitlesSearchResult[]>;
    downloadOpenSubtitle: (
        request: OpenSubtitlesDownloadRequest
    ) => Promise<OpenSubtitlesDownloadedSubtitle>;
    clearOpenSubtitlesCache: () => Promise<void>;
    setMpvPlayerPath: (mpvPlayerPath: string) => Promise<void>;
    setVlcPlayerPath: (vlcPlayerPath: string) => Promise<void>;
    xtreamRequest: (payload: ElectronBridgeXtreamRequestPayload) => Promise<ElectronBridgeXtreamResponse | ElectronBridgeXtreamFailure>;
    stalkerRequest: (payload: StalkerRequestPayload) => Promise<unknown>;
    stalkerSearchPage: (payload: StalkerSearchRequestPayload) => Promise<StalkerSearchPageResponse>;
    stalkerCancelRequest: (requestId: string) => Promise<{ cancelled: boolean }>;
    xtreamCancelSession: (sessionId: string) => Promise<ElectronBridgeXtreamCancelResult>;
    xtreamProbeUrl: (url: string, method?: 'GET' | 'HEAD') => Promise<ElectronBridgeXtreamProbeResult>;
    startCredentialTestBatch: (request: CredentialTestBatchStartRequest) => Promise<string>;
    cancelCredentialTestBatch: (batchId: string) => Promise<void>;
    onCredentialTestProgress: (callback: (progress: CredentialTestProgress) => void) => () => void;
    dbCreatePlaylist: (playlist: ElectronBridgePlaylistUpsertInput) => Promise<ElectronBridgeResult>;
    dbGetPlaylist: (playlistId: string) => Promise<ElectronBridgePlaylistRow | null>;
    dbUpsertAppPlaylist: (playlist: Playlist, 
    /**
     * Instrumentation-only; stripped before the DB invoke.
     * Never enters the DB worker payload or persisted playlist data.
     */
    operationId?: string) => Promise<ElectronBridgeResult>;
    dbUpsertAppPlaylists: (playlists: Playlist[]) => Promise<ElectronBridgeCountResult>;
    dbGetAppPlaylists: () => Promise<Playlist[]>;
    dbGetAppPlaylistMetas: () => Promise<Playlist[]>;
    dbGetAppPlaylist: (playlistId: string, 
    /**
     * Instrumentation-only; stripped before the DB invoke.
     * Never enters the DB worker payload or persisted playlist data.
     */
    operationId?: string) => Promise<Playlist | null>;
    dbUpdatePlaylist: (playlistId: string, updates: Partial<Playlist> | ElectronBridgePlaylistInput) => Promise<ElectronBridgeResult>;
    dbDeletePlaylist: (playlistId: string, operationId?: string) => Promise<ElectronBridgeResult>;
    nativePlayerCompositionEnabled?: boolean;
    performanceCaptureEnabled?: boolean;
    reportUiPerformance?: (sample: { name: 'dashboard' | 'category' | 'search'; phase?: 'catalogue-read'; startedAt: number; paintedAt: number }) => void;
    dbReplaceXtreamCatalogue: (playlistId: string, snapshot: import('./xtream-catalogue.interface').XtreamCatalogueSnapshot, account: import('./xtream-catalogue.interface').XtreamCatalogueAccountIdentity, operationId?: string) => Promise<import('./xtream-catalogue.interface').XtreamCatalogueRefreshResult>;
    dbDeleteXtreamContent: (playlistId: string, operationId?: string) => Promise<{
        success: boolean;
        favorites: XtreamBackupFavoriteItem[];
        recentlyViewed: XtreamBackupRecentlyViewedItem[];
        hiddenCategories: XtreamBackupHiddenCategory[];
    }>;
    dbRestoreXtreamUserData: (playlistId: string, favorites: XtreamBackupFavoriteItem[], recentlyViewed: XtreamBackupRecentlyViewedItem[], operationId?: string) => Promise<ElectronBridgeResult>;
    dbHasCategories: (playlistId: string, type: string) => Promise<boolean>;
    dbGetCategories: (playlistId: string, type: string) => Promise<ElectronBridgeCategoryRow[]>;
    dbSaveCategories: (playlistId: string, categories: XtreamCategory[], type: string, hiddenCategoryXtreamIds?: number[]) => Promise<ElectronBridgeResult>;
    dbGetAllCategories: (playlistId: string, type: string) => Promise<ElectronBridgeCategoryRow[]>;
    dbUpdateCategoryVisibility: (categoryIds: number[], hidden: boolean) => Promise<ElectronBridgeResult>;
    dbHasContent: (playlistId: string, type: string) => Promise<boolean>;
    dbGetContent: (playlistId: string, type: string) => Promise<ElectronBridgeXtreamContent[]>;
    dbGetContentSerialized?: (playlistId: string, type: ElectronBridgePortalContentType) => Promise<string>;
    dbSaveContent: (playlistId: string, streams: ElectronBridgeXtreamContentStream[], type: string, operationId?: string) => Promise<ElectronBridgeCountResult>;
    dbClearXtreamImportCache: (playlistId: string, type: ElectronBridgePortalContentType) => Promise<ElectronBridgeResult>;
    dbSearchContent: (playlistId: string, searchTerm: string, types: string[], excludeHidden?: boolean, options?: GlobalSearchPaginationOptions) => Promise<ElectronBridgeXtreamContent[]>;
    dbGlobalSearch: (searchTerm: string, types: string[], excludeHidden?: boolean, sources?: GlobalSearchResultSource[], options?: GlobalSearchPaginationOptions) => Promise<ElectronBridgeGlobalSearchResult[]>;
    dbGetGlobalRecentlyAdded: (kind: ElectronBridgeGlobalRecentlyAddedKind, limit?: number, playlistType?: ElectronBridgePlaylistType) => Promise<ElectronBridgeGlobalRecentlyAddedItem[]>;
    dbGetRecentlyViewed: () => Promise<ElectronBridgeGlobalRecentItem[]>;
    dbClearRecentlyViewed: () => Promise<ElectronBridgeResult>;
    dbAddFavorite: (contentId: number, playlistId: string, backdropUrl?: string) => Promise<ElectronBridgeResult>;
    dbRemoveFavorite: (contentId: number, playlistId: string) => Promise<ElectronBridgeResult>;
    dbIsFavorite: (contentId: number, playlistId: string) => Promise<boolean>;
    dbGetFavorites: (playlistId: string) => Promise<ElectronBridgeXtreamContent[]>;
    dbGetGlobalFavorites: () => Promise<ElectronBridgeGlobalFavoriteItem[]>;
    dbGetAllGlobalFavorites: () => Promise<ElectronBridgeGlobalFavoriteItem[]>;
    dbReorderGlobalFavorites: (updates: ElectronBridgeFavoriteReorderUpdate[]) => Promise<ElectronBridgeResult>;
    dbGetRecentItems: (playlistId: string) => Promise<ElectronBridgeXtreamContent[]>;
    dbAddRecentItem: (contentId: number, playlistId: string, backdropUrl?: string) => Promise<ElectronBridgeResult>;
    dbClearPlaylistRecentItems: (playlistId: string) => Promise<ElectronBridgeResult>;
    dbRemoveRecentItem: (contentId: number, playlistId: string) => Promise<ElectronBridgeResult>;
    dbRemoveRecentItemsBatch: (items: ElectronBridgeRecentItemsBatchItem[]) => Promise<ElectronBridgeCountResult>;
    dbGetContentByXtreamId: (xtreamId: number, playlistId: string, contentType?: ElectronBridgePortalContentType) => Promise<ElectronBridgeXtreamContent | null>;
    dbUpdateXtreamContentMetadata: (contentId: number, metadata: XtreamContentMetadata, enrichment?: XtreamMetadataEnrichmentState) => Promise<ElectronBridgeResult>;
    dbSetContentBackdropIfMissing: (contentId: number, backdropUrl?: string) => Promise<ElectronBridgeResult>;
    dbGetAppState: (key: string) => Promise<string | null>;
    dbSetAppState: (key: string, value: string) => Promise<ElectronBridgeResult>;
    dbGetTmdbMetadata: (mediaType: TmdbCacheMediaType, lookupKey: string, language: string) => Promise<TmdbCacheEntry | null>;
    dbSetTmdbMetadata: (entry: TmdbCacheEntry) => Promise<ElectronBridgeResult>;
    /** Row count + payload bytes for the settings cache panel */
    dbGetTmdbCacheStats: () => Promise<TmdbCacheStats>;
    dbClearTmdbMetadata: () => Promise<ElectronBridgeResult & {
        deleted: number;
    }>;
    /** Cross-playlist title matching (actor page "All portals" scope) */
    dbMatchTitles: (titles: string[]) => Promise<CatalogTitleMatch[]>;
    onPlayerError?: (callback: (data: ElectronBridgePlayerError) => void) => void;
    onDbSaveContentProgress: (callback: (count: number) => void) => void;
    removeDbSaveContentProgress: () => void;
    onDbOperationEvent?: (callback: (data: ElectronBridgeDbOperationEvent) => void) => () => void;
    dbDeleteAllPlaylists: (operationId?: string) => Promise<ElectronBridgeResult>;
    dbCancelOperation: (operationId: string) => Promise<ElectronBridgeResult>;
    dbGetViewingHistory?: (playlistId?: string) => Promise<ViewingHistoryEntry[]>;
    dbReconcileViewingItem?: (item: ViewingItem) => Promise<{ identityKey: string; workId: string }>;
    dbSaveViewingState?: (update: ViewingStateUpdate) => Promise<{ success: boolean }>;
    dbGetTitlePreferences?: (item: ViewingItem) => Promise<TitleTrackPreferences | null>;
    dbSaveTitlePreferences?: (item: ViewingItem, patch: TitleTrackPreferences, confirmedAt: number) => Promise<{ success: boolean }>;
    dbGetViewingResume?: (identity: CatalogueItemIdentity, actualDuration?: number) => Promise<ViewingResume | null>;
    dbSavePlaybackPosition: (playlistId: string, data: ElectronBridgePlaybackPositionInput) => Promise<ElectronBridgeResult>;
    dbGetPlaybackPosition: (playlistId: string, contentXtreamId: number, contentType: ElectronBridgePlaybackContentType) => Promise<PlaybackPositionData | null>;
    dbGetSeriesPlaybackPositions: (playlistId: string, seriesXtreamId: number) => Promise<PlaybackPositionData[]>;
    dbGetRecentPlaybackPositions: (playlistId: string, limit?: number) => Promise<PlaybackPositionData[]>;
    dbGetAllPlaybackPositions: (playlistId: string) => Promise<PlaybackPositionData[]>;
    dbClearAllPlaybackPositions: (playlistId: string) => Promise<ElectronBridgeResult>;
    dbClearPlaybackPosition: (playlistId: string, contentXtreamId: number, contentType: ElectronBridgePlaybackContentType) => Promise<ElectronBridgeResult>;
    onPlaybackProgressFlush?: (callback: () => Promise<string | null>) => () => void;
    onPlaybackPositionUpdate: (callback: (data: PlaybackPositionData) => void) => () => void;
    onExternalPlayerSessionUpdate?: (callback: (data: ExternalPlayerSession) => void) => () => void;
    onEmbeddedMpvSessionUpdate?: (callback: (data: EmbeddedMpvSession) => void) => () => void;
    closeExternalPlayerSession: (sessionId: string) => Promise<ExternalPlayerSession | null>;
    controlExternalPlayerSession: (sessionId: string, action: ExternalPlayerControlAction, value?: number) => Promise<ExternalPlayerSession | null>;
    getEmbeddedMpvSupport: () => Promise<EmbeddedMpvSupport>;
    prepareEmbeddedMpv?: () => Promise<EmbeddedMpvSupport>;
    createEmbeddedMpvSession: (bounds: EmbeddedMpvBounds, title?: string, initialVolume?: number) => Promise<EmbeddedMpvSession>;
    loadEmbeddedMpvPlayback: (sessionId: string, playback: ResolvedPortalPlayback) => Promise<void>;
    setEmbeddedMpvBounds: (sessionId: string, bounds: EmbeddedMpvBounds) => Promise<void>;
    setEmbeddedMpvPaused: (sessionId: string, paused: boolean) => Promise<EmbeddedMpvSession | null>;
    seekEmbeddedMpv: (sessionId: string, seconds: number) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvVolume: (sessionId: string, volume: number) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvAudioTrack: (sessionId: string, trackId: number) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvSubtitleTrack?: (sessionId: string, trackId: number) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvSubtitleFile?: (sessionId: string, filePath: string) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvSubtitleSettings?: (sessionId: string, settings: PlayerSubtitleSettings) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvSpeed?: (sessionId: string, speed: number) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvAspect?: (sessionId: string, aspect: string) => Promise<EmbeddedMpvSession | null>;
    setEmbeddedMpvPicture?: (sessionId: string, picture: PlayerPictureSettings) => Promise<EmbeddedMpvSession | null>;
    disposeEmbeddedMpvSession: (sessionId: string) => Promise<EmbeddedMpvSession | null>;
    captureWebVideoFrame?: (bounds: EmbeddedMpvBounds) => Promise<string | null>;
    registerBrowserGuest?: (id: number, mode: BrowserViewMode) => Promise<void>;
    onBrowserGuestSurfaces?: (callback: (surfaces: BrowserGuestSurfaceState[]) => void) => () => void;
    openBrowserView: (
        mode: BrowserViewMode,
        url?: string
    ) => Promise<BrowserViewState>;
    setBrowserViewBounds: (
        bounds: BrowserViewBounds,
        target?: BrowserViewBoundsTarget
    ) => Promise<void>;
    executeBrowserCommand: (
        command: BrowserViewCommand
    ) => Promise<BrowserViewState | null>;
    closeBrowserView: (
        mode?: BrowserViewMode,
        terminate?: boolean
    ) => Promise<void>;
    onBrowserViewUpdate: (callback: (state: BrowserViewState) => void) => () => void;
}
