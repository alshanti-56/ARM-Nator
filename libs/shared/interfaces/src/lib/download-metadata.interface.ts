/**
 * Provider-neutral metadata persisted with a downloaded movie or episode.
 *
 * The snapshot is deliberately small and JSON-friendly. It lets the download
 * UI keep the title/artwork/details that were visible when the download was
 * started, even when the provider is no longer reachable later.
 */
export interface DownloadMetadataPerson {
    name: string;
    role?: string;
    profileUrl?: string;
    tmdbPersonId?: number;
}

export interface DownloadMetadataEpisode {
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    plot?: string;
    stillUrl?: string;
}

export interface DownloadMetadataSnapshotInput {
    language: string;
    title: string;
    originalTitle?: string;
    plot?: string;
    releaseDate?: string;
    year?: number;
    genres?: readonly string[];
    rating?: number;
    status?: string;
    posterUrl?: string;
    backdropUrl?: string;
    tmdbId?: number | string;
    providerCategoryId?: string;
    cast?: readonly DownloadMetadataPerson[];
    creators?: readonly DownloadMetadataPerson[];
}

export interface DownloadMetadataSnapshot
    extends DownloadMetadataSnapshotInput {
    version: 1;
    mediaKind: 'movie' | 'series';
    episode?: DownloadMetadataEpisode;
    enrichedAt: string;
}
