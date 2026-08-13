import { PlaybackPositionData } from './playback-position.interface';

export const PLAYLIST_BACKUP_KIND = 'arm-nator-playlist-backup';
export const PLAYLIST_BACKUP_VERSION = 1;

export type PlaylistBackupPortalType = 'xtream';
export type XtreamBackupContentType = 'live' | 'movie' | 'series';
export type XtreamBackupCategoryType = 'live' | 'movies' | 'series';

export type PlaylistBackupSettings = Record<string, never>;

export interface PlaylistBackupBaseEntry {
    portalType: PlaylistBackupPortalType;
    exportedId: string;
    title: string;
    autoRefresh: boolean;
    position?: number;
}

export interface XtreamBackupHiddenCategory {
    categoryType: XtreamBackupCategoryType;
    xtreamId: number;
}

export interface XtreamBackupFavoriteItem {
    contentType: XtreamBackupContentType;
    xtreamId: number;
    addedAt?: string;
    position?: number | null;
}

export interface XtreamBackupRecentlyViewedItem {
    contentType: XtreamBackupContentType;
    xtreamId: number;
    viewedAt: string;
}

export interface XtreamBackupUserState {
    hiddenCategories: XtreamBackupHiddenCategory[];
    favorites: XtreamBackupFavoriteItem[];
    recentlyViewed: XtreamBackupRecentlyViewedItem[];
    playbackPositions: PlaybackPositionData[];
}

export interface XtreamPlaylistBackupEntry extends PlaylistBackupBaseEntry {
    portalType: 'xtream';
    connection: {
        serverUrl: string;
        username: string;
        password?: string;
    };
    userState: XtreamBackupUserState;
}

export type PlaylistBackupEntry =
    XtreamPlaylistBackupEntry;

export interface PlaylistBackupManifestV1 {
    kind: typeof PLAYLIST_BACKUP_KIND;
    version: typeof PLAYLIST_BACKUP_VERSION;
    exportedAt: string;
    includeSecrets: boolean;
    settings?: PlaylistBackupSettings;
    playlists: PlaylistBackupEntry[];
}
