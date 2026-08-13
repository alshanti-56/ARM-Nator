import type {
    DownloadMetadataEpisode,
    DownloadMetadataSnapshot,
    DownloadMetadataSnapshotInput,
} from '@arm-nator/shared/interfaces';

function withoutUndefined<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map((entry) => withoutUndefined(entry)) as T;
    }

    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined) {
                result[key] = withoutUndefined(entry);
            }
        }
        return result as T;
    }

    return value;
}

function createSnapshot(
    input: DownloadMetadataSnapshotInput,
    mediaKind: DownloadMetadataSnapshot['mediaKind'],
    episode?: DownloadMetadataEpisode
): DownloadMetadataSnapshot {
    return withoutUndefined({
        version: 1 as const,
        ...input,
        mediaKind,
        ...(episode ? { episode } : {}),
        enrichedAt: new Date().toISOString(),
    });
}

export function createMovieDownloadSnapshot(
    input: DownloadMetadataSnapshotInput
): DownloadMetadataSnapshot {
    return createSnapshot(input, 'movie');
}

export function createSeriesEpisodeDownloadSnapshot(
    input: DownloadMetadataSnapshotInput & { episode: DownloadMetadataEpisode }
): DownloadMetadataSnapshot {
    return createSnapshot(input, 'series', input.episode);
}
