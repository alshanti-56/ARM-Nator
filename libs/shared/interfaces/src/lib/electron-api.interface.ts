/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    EmbeddedMpvBounds,
    EmbeddedMpvSession,
    EmbeddedMpvSupport,
} from './embedded-mpv-session.interface';
import { ExternalPlayerSession } from './external-player-session.interface';
import {
    GlobalSearchPaginationOptions,
    GlobalSearchResult,
    GlobalSearchResultSource,
} from './global-search-result.interface';
import { M3uFavoriteChannel } from './m3u-favorite-channel.interface';
import { PlaybackPositionData } from './playback-position.interface';
import { AutoUpdatePlaylistsResult } from './playlist-auto-update.interface';
import {
    XtreamBackupFavoriteItem,
    XtreamBackupHiddenCategory,
    XtreamBackupRecentlyViewedItem,
} from './playlist-backup.interface';
import {
    PlaylistRefreshCancelledResult,
    PlaylistRefreshEvent,
    PlaylistRefreshPayload,
} from './playlist-refresh.interface';
import { Playlist } from './playlist.interface';
import {
    PlayerContentInfo,
    ResolvedPortalPlayback,
} from './portal-playback.interface';
import { PortalDebugEvent } from './portal-debug.interface';
import { CatalogTitleMatch } from './catalog-title-match.interface';
import { Settings } from './settings.interface';
import {
    TmdbCacheEntry,
    TmdbCacheMediaType,
    TmdbCacheStats,
} from './tmdb.interface';
import { XtreamCategory } from './xtream-category.interface';

export const ELECTRON_BRIDGE_CONTENT_TYPES = {
    Episode: 'episode',
    Live: 'live',
    Movie: 'movie',
    Series: 'series',
    Vod: 'vod',
} as const;

export type ElectronBridgeContentType =
    (typeof ELECTRON_BRIDGE_CONTENT_TYPES)[keyof typeof ELECTRON_BRIDGE_CONTENT_TYPES];

export type ElectronBridgePortalContentType =
    | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Live
    | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Movie
    | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Series;

export type ElectronBridgePlaybackContentType =
    | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Vod
    | typeof ELECTRON_BRIDGE_CONTENT_TYPES.Episode;

export const ELECTRON_BRIDGE_PLAYLIST_TYPES = {
    M3uFile: 'm3u-file',
    M3uText: 'm3u-text',
    M3uUrl: 'm3u-url',
    Xtream: 'xtream',
} as const;

export type ElectronBridgePlaylistType =
    (typeof ELECTRON_BRIDGE_PLAYLIST_TYPES)[keyof typeof ELECTRON_BRIDGE_PLAYLIST_TYPES];

export const ELECTRON_BRIDGE_SECURITY_ERROR_CODES = {
    InvalidTlsCertificate: 'invalid-tls-certificate',
} as const;

export type ElectronBridgeSecurityErrorCode =
    (typeof ELECTRON_BRIDGE_SECURITY_ERROR_CODES)[keyof typeof ELECTRON_BRIDGE_SECURITY_ERROR_CODES];

export const ELECTRON_BRIDGE_DB_OPERATION_STATUSES = {
    Cancelled: 'cancelled',
    Completed: 'completed',
    Error: 'error',
    Progress: 'progress',
    Started: 'started',
} as const;

export type ElectronBridgeDbOperationStatus =
    (typeof ELECTRON_BRIDGE_DB_OPERATION_STATUSES)[keyof typeof ELECTRON_BRIDGE_DB_OPERATION_STATUSES];

export const ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS = {
    All: 'all',
    Series: 'series',
    Vod: 'vod',
} as const;

export type ElectronBridgeGlobalRecentlyAddedKind =
    (typeof ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS)[keyof typeof ELECTRON_BRIDGE_GLOBAL_RECENTLY_ADDED_KINDS];

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
}

export interface ElectronBridgeXtreamResponse {
    payload: unknown;
    action: string;
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


export * from "./electron-api-extended.interface";
