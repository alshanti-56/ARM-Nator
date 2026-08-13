import type { Playlist } from '@arm-nator/shared/interfaces';
import type { BulkTestCandidate } from '@arm-nator/tools/core';

export interface CredentialSaveResult {
    readonly imported: readonly Playlist[];
    readonly importFailures: number;
    readonly persistenceFailed: boolean;
    readonly skippedExisting: number;
}

export interface CredentialSaveDependencies {
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

/** Imports Xtream sources, then persists the whole batch once. */
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
