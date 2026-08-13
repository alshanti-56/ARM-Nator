import { PlaylistRecentlyViewedItem } from './playlist-recently-viewed.interface';
import { StalkerPortalItem } from './stalker-portal-item.interface';

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
    /** The provider payload used to restore portal state. */
    playlist?: PlaylistPayload;
    importDate: string;
    lastUsage: string;
    favorites?: Array<string | StalkerPortalItem>;
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
    hiddenGroupTitles?: string[];
}
