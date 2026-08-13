const PLAYLIST_AUTHORITY_LOCK = 'iptvnator:playlist-authority';

export interface PlaylistAuthorityReservation {
    readonly status: 'acquired' | 'unavailable';
    readonly release: () => void;
    readonly released: Promise<void>;
}

function getLockManager(): LockManager | null {
    return typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks
        : null;
}

/**
 * Reserve one playlist across browser contexts until `release` is called.
 *
 * The shared parent lock makes the authority namespace explicit; the
 * per-playlist lock is the actual exclusion boundary. `ifAvailable` keeps
 * repair/edit callers fail-closed instead of waiting behind another tab.
 */
export async function reservePlaylistAuthority(
    playlistId: string
): Promise<PlaylistAuthorityReservation> {
    const locks = getLockManager();
    if (!locks || !playlistId) {
        return {
            status: 'unavailable',
            release: () => undefined,
            released: Promise.resolve(),
        };
    }

    let resolveReady!: (acquired: boolean) => void;
    const ready = new Promise<boolean>((resolve) => {
        resolveReady = resolve;
    });
    let resolveRelease!: () => void;
    const releaseRequested = new Promise<void>((resolve) => {
        resolveRelease = resolve;
    });
    let released = false;

    const holdingRequest = locks
        .request(
            PLAYLIST_AUTHORITY_LOCK,
            { mode: 'shared' },
            async (authorityLock) => {
                if (!authorityLock) {
                    resolveReady(false);
                    return;
                }

                await locks.request(
                    `${PLAYLIST_AUTHORITY_LOCK}:${playlistId}`,
                    { ifAvailable: true, mode: 'exclusive' },
                    async (playlistLock) => {
                        if (!playlistLock) {
                            resolveReady(false);
                            return;
                        }

                        resolveReady(true);
                        await releaseRequested;
                    }
                );
            }
        )
        .catch(() => {
            resolveReady(false);
        });

    if (!(await ready)) {
        await holdingRequest;
        return {
            status: 'unavailable',
            release: () => undefined,
            released: Promise.resolve(),
        };
    }

    return {
        status: 'acquired',
        release: () => {
            if (!released) {
                released = true;
                resolveRelease();
            }
        },
        released: holdingRequest.then(() => undefined),
    };
}

/**
 * Edit reservations require the lock to be available. Throwing here gives
 * discovery a stable fail-closed error while repair can use the status API.
 */
export async function acquirePlaylistAuthorityEditReservation(
    playlistId: string
): Promise<() => void> {
    const reservation = await reservePlaylistAuthority(playlistId);
    if (reservation.status !== 'acquired') {
        if (getLockManager()) {
            throw new Error('Stalker playlist edit already in progress');
        }
        throw new Error(
            'Cross-context playlist edit locking is unavailable'
        );
    }
    return reservation.release;
}
