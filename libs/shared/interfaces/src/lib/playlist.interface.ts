import { PlaylistRecentlyViewedItem } from './playlist-recently-viewed.interface';

export interface PlaylistHeader {
    raw?: string;
    [key: string]: unknown;
}

export interface PlaylistPayload {
    items?: unknown[];
    header?: PlaylistHeader;
}

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
    playlist?: PlaylistPayload;
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
    isFullStalkerPortal?: boolean;
    stalkerToken?: string;
    stalkerSessionIdentity?: string;
    stalkerSerialNumber?: string;
    serialNumber?: string;
    stalkerDeviceId1?: string;
    stalkerDeviceId2?: string;
    stalkerSignature1?: string;
    stalkerSignature2?: string;
    stalkerWatchdogTimeout?: number;
    stalkerTimeslot?: number;
    stalkerAccountInfo?: {
        login?: string;
        expireDate?: number;
        tariffPlanName?: string;
        status?: number;
    };
    recentlyViewed?: PlaylistRecentlyViewedItem[];
    /** Xtream server timezone string for catch-up URL construction */
    serverTimezone?: string;
    /** Hidden M3U group titles for the groups view */
    hiddenGroupTitles?: string[];
}
