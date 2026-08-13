import { XtreamVodDetails } from './xtream-vod-details.interface';
import { StalkerVodDetails } from './stalker-vod-details.interface';
import { TmdbEnrichedCastMember,
    TmdbRecommendation,
} from './tmdb.interface';

/**
 * Discriminated VOD details wrapper for supported portal content.
 *
 * @example
 * ```typescript
 * function handleVod(item: VodDetailsItem) {
 *   if (item.type === 'xtream') {
 *     // TypeScript knows item.data is XtreamVodDetails
 *     console.log(item.data.movie_data.stream_id);
 *   } else {
 *     console.log(item.data.info.name);
 *   }
 * }
 * ```
 */
export type VodDetailsItem = XtreamVodItem | StalkerVodItem;

/**
 * Xtream Codes VOD item wrapper with context.
 */
export interface XtreamVodItem {
    /** Discriminator for Xtream Codes portals */
    readonly type: 'xtream';
    /** Full VOD details from Xtream API */
    data: XtreamVodDetails;
    /** Playlist ID for favorites and playback */
    playlistId: string;
    /** Stream ID from Xtream API */
    vodId: number;
}

/**
 * Stalker/Ministra VOD item wrapper with the portal context needed by the
 * shared detail view and playback-position matching.
 */
export interface StalkerVodItem {
    /** Discriminator for Stalker/Ministra portals */
    readonly type: 'stalker';
    /** Full VOD details from the Stalker portal */
    data: StalkerVodDetails;
    /** Original portal playback command */
    cmd: string;
    /** Playlist ID for favorites and playback */
    playlistId: string;
    /** Numeric stream ID when the portal supplied one */
    vodId: number;
}

/**
 * Normalized metadata for display in templates.
 * Provides a consistent interface regardless of portal type.
 */
export interface NormalizedVodMeta {
    /** Movie title */
    title: string;
    /** Plot description */
    description?: string;
    /** Poster/cover image URL */
    posterUrl?: string;
    /** Backdrop image URL when supplied or enriched */
    backdropUrl?: string;
    /** Release year (4 digits) */
    year?: string;
    /** Genre(s) */
    genre?: string;
    /** Duration string (e.g., "1h 30m") */
    duration?: string;
    /** Country of origin when supplied */
    country?: string;
    /** Director name */
    director?: string;
    /** Actors/cast (comma-separated) */
    actors?: string;
    /** IMDB rating */
    ratingImdb?: string;
    /** Kinopoisk rating */
    ratingKinopoisk?: string;
    /** YouTube trailer ID when supplied or enriched */
    youtubeTrailer?: string;
    /** Cast with profile photos, populated by TMDB enrichment */
    tmdbCast?: TmdbEnrichedCastMember[];
    /** Directors (movies) / creators (series) as clickable person chips */
    tmdbDirectors?: TmdbEnrichedCastMember[];
    /** TMDB recommendations (drives the cross-portal "Similar" rail) */
    tmdbRecommendations?: TmdbRecommendation[];
}

/**
 * Type guard to check if item is Xtream VOD.
 */
export function isXtreamVod(item: VodDetailsItem): item is XtreamVodItem {
    return item.type === 'xtream';
}

/** Type guard for Stalker/Ministra VOD items. */
export function isStalkerVod(item: VodDetailsItem): item is StalkerVodItem {
    return item.type === 'stalker';
}
