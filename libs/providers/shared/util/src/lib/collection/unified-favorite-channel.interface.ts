/**
 * Unified interface for displaying live TV favorites from any source
 * (Xtream and Stalker portals) in one list.
 */
export type FavoriteSourceType = 'xtream';

export interface UnifiedFavoriteChannel {
    /**
     * Unique identifier within the global-favorites list.
     * Format: `{sourceType}::{playlistId}::{sourceItemId}`
     */
    uid: string;

    /** Display name of the channel */
    name: string;

    /** Logo / thumbnail URL */
    logo: string | null;

    /** Source type – determines how to resolve the stream URL */
    sourceType: FavoriteSourceType;

    /** ID of the parent playlist */
    playlistId: string;

    /** Human-readable playlist name */
    playlistName: string;

    /** Xtream numeric stream ID */
    xtreamId?: number;

    /** TVG identifier for live channels. */
    tvgId?: string;

    /** ISO timestamp when added to favorites */
    addedAt: string;

    /**
     * Display order within the unified list.
     * Lower values appear first. 0 = unset (sort by addedAt desc).
     */
    position: number;

    /** Xtream DB content id — used for REORDER IPC call */
    contentId?: number;

}

/**
 * Build a stable UID string for a unified favorite channel.
 */
export function buildFavoriteUid(
    sourceType: FavoriteSourceType,
    playlistId: string,
    sourceItemId: string | number
): string {
    return `${sourceType}::${playlistId}::${sourceItemId}`;
}
