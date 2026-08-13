/**
 * Unified interface for displaying favorites or recently-viewed items
 * from supported portal sources in one list.
 *
 * Extends the previous live-only UnifiedFavoriteChannel to cover
 * all content types: live TV, movies, and series.
 */
export type CollectionSourceType = 'xtream';
export type CollectionContentType = 'live' | 'movie' | 'series';

export interface UnifiedCollectionItem {
    /** Unique identifier: `{sourceType}::{playlistId}::{sourceItemId}` */
    uid: string;

    /** Display name */
    name: string;

    /** Content type — determines which tab / layout to use */
    contentType: CollectionContentType;

    /** Source type — determines how to resolve playback */
    sourceType: CollectionSourceType;

    /** Parent playlist ID */
    playlistId: string;

    /** Human-readable playlist name */
    playlistName: string;

    /** Logo / thumbnail URL (live channels) */
    logo?: string | null;

    /** Poster image URL (movies / series) */
    posterUrl?: string | null;

    /** Stable TVG identifier from the source playlist */
    tvgId?: string;

    /** Xtream numeric stream ID */
    xtreamId?: number;

    /** Xtream DB content id — used for reorder / remove IPC */
    contentId?: number;

    /** Whether the Xtream provider has timeshift / archive enabled for this stream */
    tvArchive?: number | null;
    /** Timeshift / archive window in days — passed through as-is, matching
     *  `live-stream-layout.controlledArchiveDays`. */
    tvArchiveDuration?: number | null;

    /** Category ID for VOD/Series navigation */
    categoryId?: string | number;

    /** Content rating (VOD) */
    rating?: string;

    /** ISO timestamp when added to favorites */
    addedAt?: string;

    /** Display order (favorites) */
    position?: number;

    /** ISO timestamp when viewed (recently-viewed) */
    viewedAt?: string;

}

/**
 * Build a stable UID string for a unified collection item.
 */
export function buildCollectionUid(
    sourceType: CollectionSourceType,
    playlistId: string,
    sourceItemId: string | number
): string {
    return `${sourceType}::${playlistId}::${sourceItemId}`;
}

export function buildXtreamCollectionUid(
    playlistId: string,
    contentType: CollectionContentType,
    xtreamId: string | number
): string {
    return buildCollectionUid(
        'xtream',
        playlistId,
        `${contentType}:${xtreamId}`
    );
}
