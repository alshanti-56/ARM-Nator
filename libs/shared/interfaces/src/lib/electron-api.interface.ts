/* eslint-disable @typescript-eslint/no-unused-vars */
import {
    EmbeddedMpvBounds,
    EmbeddedMpvSession,
    EmbeddedMpvSupport,
    KsPlayerMetalControls,
    KsPlayerMetalSupport,
} from './embedded-mpv-session.interface';
import { ExternalPlayerSession } from './external-player-session.interface';
import {
    GlobalSearchPaginationOptions,
    GlobalSearchResult,
    GlobalSearchResultSource,
} from './global-search-result.interface';
import { PlaybackPositionData } from './playback-position.interface';
import {
    XtreamBackupFavoriteItem,
    XtreamBackupHiddenCategory,
    XtreamBackupRecentlyViewedItem,
} from './playlist-backup.interface';
import { Playlist } from './playlist.interface';
import {
    PlayerContentInfo,
    ResolvedPortalPlayback,
} from './portal-playback.interface';
import { PortalDebugEvent } from './portal-debug.interface';
import { CatalogTitleMatch } from './catalog-title-match.interface';
import { Settings } from './settings.interface';
import { PlayerSubtitleSettings } from './player-subtitle-settings.interface';
import { PlayerPictureSettings } from './video-picture-settings.interface';
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

/**
 * Provider-specific namespaces for persisted episode downloads. Stalker VOD
 * series and regular series can reuse numeric episode IDs, so their download
 * identities must remain distinct even inside one playlist.
 */
export const ELECTRON_BRIDGE_EPISODE_IDENTITY_SCOPES = {
    StalkerEmbeddedVod: 'stalker-embedded-vod',
    StalkerLazyVod: 'stalker-lazy-vod',
    StalkerRegularSeries: 'stalker-regular-series',
} as const;

export type ElectronBridgeEpisodeIdentityScope =
    (typeof ELECTRON_BRIDGE_EPISODE_IDENTITY_SCOPES)[keyof typeof ELECTRON_BRIDGE_EPISODE_IDENTITY_SCOPES];

export const ELECTRON_BRIDGE_PLAYLIST_TYPES = {
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

/** KSPlayer Metal's isolated subset of the renderer bridge. */
export interface ElectronBridgeKsPlayerMetalApi {
    onKsPlayerMetalSessionUpdate?: (callback: (data: EmbeddedMpvSession) => void) => () => void;
    getKsPlayerMetalSupport: () => Promise<KsPlayerMetalSupport>;
    prepareKsPlayerMetal: () => Promise<KsPlayerMetalSupport>;
    createKsPlayerMetalSession: (
        bounds: EmbeddedMpvBounds,
        title?: string,
        initialVolume?: number
    ) => Promise<EmbeddedMpvSession>;
    loadKsPlayerMetalPlayback: (
        sessionId: string,
        playback: ResolvedPortalPlayback
    ) => Promise<void>;
    setKsPlayerMetalBounds: (sessionId: string, bounds: EmbeddedMpvBounds) => Promise<void>;
    setKsPlayerMetalPaused: (
        sessionId: string,
        paused: boolean
    ) => Promise<EmbeddedMpvSession | null>;
    seekKsPlayerMetal: (
        sessionId: string,
        seconds: number
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalVolume: (
        sessionId: string,
        volume: number
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalAudioTrack: (
        sessionId: string,
        trackId: number
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalSubtitleTrack: (
        sessionId: string,
        trackId: number
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalSubtitleFile: (
        sessionId: string,
        filePath: string
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalSubtitleSettings: (
        sessionId: string,
        settings: PlayerSubtitleSettings
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalSpeed: (
        sessionId: string,
        speed: number
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalDisplayMode: (
        sessionId: string,
        mode: string
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalAspect: (
        sessionId: string,
        aspect: string
    ) => Promise<EmbeddedMpvSession | null>;
    setKsPlayerMetalPicture: (
        sessionId: string,
        picture: PlayerPictureSettings
    ) => Promise<EmbeddedMpvSession | null>;
    getKsPlayerMetalSupportedControls: (
        sessionId?: string
    ) => Promise<KsPlayerMetalControls>;
    disposeKsPlayerMetalSession: (sessionId: string) => Promise<EmbeddedMpvSession | null>;
    disposeAllKsPlayerMetal: () => Promise<void>;
}


export * from "./electron-api-extended.interface";
