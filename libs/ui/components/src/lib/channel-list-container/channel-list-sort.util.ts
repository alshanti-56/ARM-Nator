const CHANNEL_LIST_SORT_COLLATOR = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

export type PlaylistChannelSortMode = 'server' | 'name-asc' | 'name-desc';

export function isPlaylistChannelSortMode(
    value: unknown
): value is PlaylistChannelSortMode {
    return value === 'server' || value === 'name-asc' || value === 'name-desc';
}

export function restorePlaylistChannelSortMode(
    storageKey: string,
    fallback: PlaylistChannelSortMode = 'server'
): PlaylistChannelSortMode {
    const storedValue = localStorage.getItem(storageKey);
    return isPlaylistChannelSortMode(storedValue) ? storedValue : fallback;
}

export function persistPlaylistChannelSortMode(
    storageKey: string,
    mode: PlaylistChannelSortMode
): void {
    localStorage.setItem(storageKey, mode);
}

export function getPlaylistChannelSortModeLabel(
    mode: PlaylistChannelSortMode
): string {
    if (mode === 'name-asc') {
        return 'Name A-Z';
    }

    if (mode === 'name-desc') {
        return 'Name Z-A';
    }

    return 'Playlist Order';
}

export function sortPlaylistChannelItems<T>(
    items: readonly T[],
    mode: PlaylistChannelSortMode,
    getDisplayName: (item: T) => string | null | undefined
): readonly T[] {
    if (mode === 'server') {
        return items;
    }

    return [...items].sort((a, b) => {
        const result = CHANNEL_LIST_SORT_COLLATOR.compare(
            getDisplayName(a) ?? '',
            getDisplayName(b) ?? ''
        );
        return mode === 'name-asc' ? result : -result;
    });
}
