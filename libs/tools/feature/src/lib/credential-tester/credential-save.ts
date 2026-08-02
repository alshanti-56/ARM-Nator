import type { Playlist } from '@arm-nator/shared/interfaces';
import type { BulkTestCandidate } from '@arm-nator/tools/core';

export const CREDENTIAL_SAVE_M3U_CONCURRENCY = 3;

export interface CredentialSaveResult {
    readonly imported: readonly Playlist[];
    readonly importFailures: number;
    readonly persistenceFailed: boolean;
    readonly skippedExisting: number;
}

export interface CredentialSaveDependencies {
    readonly createM3uPlaylist: (candidate: BulkTestCandidate) => Promise<Playlist>;
    readonly createXtreamPlaylist: (candidate: BulkTestCandidate) => Playlist;
    readonly persist: (playlists: Playlist[]) => Promise<unknown>;
    readonly sourceKey: (candidate: BulkTestCandidate) => string;
}

/**
 * Reloads the provider list after persistence and guarantees that the sources
 * saved by this operation are present even if the storage refresh is stale or
 * temporarily unavailable.
 */
export async function resolveCredentialProviderList(
    saved: readonly Playlist[],
    loadProviderPlaylists: () => Promise<readonly Playlist[]>
): Promise<Playlist[]> {
    let persisted: readonly Playlist[] = [];
    try {
        persisted = await loadProviderPlaylists();
    } catch {
        // The save already succeeded; publish the saved rows as the fallback.
    }

    const playlistsById = new Map<string, Playlist>();
    for (const playlist of [...persisted, ...saved]) {
        playlistsById.set(playlist._id, playlist);
    }
    return [...playlistsById.values()];
}

async function mapBounded<T, TResult>(
    values: readonly T[],
    concurrency: number,
    mapper: (value: T) => Promise<TResult>
): Promise<TResult[]> {
    const results = new Array<TResult>(values.length);
    let nextIndex = 0;
    const runNext = async (): Promise<void> => {
        for (
            let index = nextIndex++;
            index < values.length;
            index = nextIndex++
        ) {
            results[index] = await mapper(values[index]);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, runNext)
    );
    return results;
}

/** Imports M3U sources with a bounded fan-out, then persists the whole batch once. */
export async function saveCredentialSources(
    candidates: readonly BulkTestCandidate[],
    existingKeys: ReadonlySet<string>,
    dependencies: CredentialSaveDependencies
): Promise<CredentialSaveResult> {
    const seen = new Set(existingKeys);
    const unique = candidates.filter((candidate) => {
        const key = dependencies.sourceKey(candidate);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    const imported = new Array<Playlist | null>(unique.length).fill(null);
    let importFailures = 0;

    for (const [index, candidate] of unique.entries()) {
        if (candidate.type !== 'xtream') {
            continue;
        }
        try {
            imported[index] = dependencies.createXtreamPlaylist(candidate);
        } catch {
            importFailures += 1;
        }
    }

    const m3uEntries = unique
        .map((candidate, index) => ({ candidate, index }))
        .filter((entry) => entry.candidate.type === 'm3u');
    const m3uResults = await mapBounded(
        m3uEntries,
        CREDENTIAL_SAVE_M3U_CONCURRENCY,
        async (entry) => {
            try {
                return {
                    index: entry.index,
                    playlist: await dependencies.createM3uPlaylist(entry.candidate),
                };
            } catch {
                return { index: entry.index, playlist: null };
            }
        }
    );
    for (const result of m3uResults) {
        imported[result.index] = result.playlist;
        if (!result.playlist) {
            importFailures += 1;
        }
    }

    const playlists = imported.filter(
        (playlist): playlist is Playlist => playlist !== null
    );
    if (playlists.length === 0) {
        return {
            imported: [],
            importFailures,
            persistenceFailed: false,
            skippedExisting: candidates.length - unique.length,
        };
    }

    try {
        await dependencies.persist(playlists);
        return {
            imported: playlists,
            importFailures,
            persistenceFailed: false,
            skippedExisting: candidates.length - unique.length,
        };
    } catch {
        return {
            imported: [],
            importFailures,
            persistenceFailed: true,
            skippedExisting: candidates.length - unique.length,
        };
    }
}
