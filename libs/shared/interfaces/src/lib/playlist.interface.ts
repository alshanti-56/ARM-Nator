import { PlaylistRecentlyViewedItem } from './playlist-recently-viewed.interface';

/**
 * An interface that describe the possible states of the playlist update/refresh process
 */
export enum PlaylistUpdateState {
    UPDATED,
    IN_PROGRESS,
    NOT_UPDATED,
}

/**
 * Describes playlist interface
 */
export interface Playlist {
    _id: string;
    title: string;
    filename?: string;
    /** The parsed playlist payload (e.g., parsed M3U object or portal payload) */
    playlist?: { items?: any[]; header?: any };
    importDate: string;
    lastUsage: string;
    /** M3U playlists store channel URL strings (`string[]`). */
    favorites?: string[];
    items?: unknown[];
    header?: unknown;
    count: number;
    url?: string;
    userAgent?: string;
    referrer?: string;
    origin?: string;
    filePath?: string;
    autoRefresh: boolean;
    updateDate?: number;
    updateState?: PlaylistUpdateState;
    position?: number;
    isTemporary?: boolean;
    serverUrl?: string;
    username?: string;
    password?: string;
    macAddress?: string;
    portalUrl?: string;
    recentlyViewed?: PlaylistRecentlyViewedItem[];
    /** Xtream server timezone string for catch-up URL construction */
    serverTimezone?: string;
    /** Hidden M3U group titles for the groups view */
    hiddenGroupTitles?: string[];
}
