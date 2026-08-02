import { XtreamVodDetails } from './xtream-vod-details.interface';
import { TmdbEnrichedCastMember,
    TmdbRecommendation,
} from './tmdb.interface';

/**
 * Discriminated VOD details wrapper for Xtream content.
 *
 * @example
 * ```typescript
 * function handleVod(item: VodDetailsItem) {
 *   if (item.type === 'xtream') {
 *     // TypeScript knows item.data is XtreamVodDetails
 *     console.log(item.data.movie_data.stream_id);
 *   } else {
 *   }
 * }
 * ```
 */
export type VodDetailsItem = XtreamVodItem;

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
    /** Backdrop image URL (Xtream only) */
    backdropUrl?: string;
    /** Release year (4 digits) */
    year?: string;
    /** Genre(s) */
    genre?: string;
    /** Duration string (e.g., "1h 30m") */
    duration?: string;
    /** Country of origin (Xtream only) */
    country?: string;
    /** Director name */
    director?: string;
    /** Actors/cast (comma-separated) */
    actors?: string;
    /** IMDB rating */
    ratingImdb?: string;
    /** Kinopoisk rating */
    ratingKinopoisk?: string;
    /** YouTube trailer ID (Xtream only) */
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
