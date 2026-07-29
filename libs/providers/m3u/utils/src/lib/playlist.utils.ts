import {
    Channel,
    createRandomId,
    ParsedPlaylist,
    ParsedPlaylistItem,
    Playlist,
} from '@arm-nator/shared/interfaces';
import { extractDrmFromRaw } from './kodiprop.utils';

/**
 * Aggregates favorite channels as objects from all available playlists
 * @param playlists all available playlists
 * @returns an array with favorite channels from all playlists
 */
export function aggregateFavoriteChannels(playlists: Playlist[]): Channel[] {
    const favorites: Channel[] = [];

    for (const playlist of playlists) {
        const favoriteIds = new Set(
            (playlist.favorites ?? []).filter(
                (favorite): favorite is string => typeof favorite === 'string'
            )
        );

        if (favoriteIds.size === 0) {
            continue;
        }

        for (const channel of (playlist.playlist as { items?: Channel[] })?.items ?? []) {
            if (favoriteIds.has(channel.id) || favoriteIds.has(channel.url)) {
                favorites.push(channel);
            }
        }
    }

    return favorites;
}

/**
 * Creates a simplified playlist object which is used for global favorites
 * @param channels channels list
 * @returns simplified playlist object
 */
export function createFavoritesPlaylist(
    channels: Channel[]
): Partial<Playlist> {
    return {
        _id: 'global-favorites',
        count: channels.length,
        playlist: {
            items: channels,
        },
        favorites: channels.map((channel) => channel.url),
        filename: 'Global favorites',
    };
}

/**
 * Returns last segment (part after last slash "/") of the given URL
 * @param value URL as string
 */
export const getFilenameFromUrl = (value: string): string => {
    if (value && value.length > 1) {
        return value.substring(value.lastIndexOf('/') + 1);
    }
    return 'Untitled playlist';
};

export const createPlaylistObject = (
    name: string,
    playlist: ParsedPlaylist,
    urlOrPath?: string,
    uploadType?: 'URL' | 'FILE' | 'TEXT'
): Playlist => ({
    _id: createRandomId(),
    filename: name,
    title: name,
    count: playlist.items.length,
    playlist: {
        ...playlist,
        items: playlist.items.map((item: ParsedPlaylistItem) => {
            const drm = extractDrmFromRaw(item.raw);
            return {
                ...item,
                id: createRandomId(),
                ...(drm ? { drm } : {}),
            };
        }),
    },
    importDate: new Date().toISOString(),
    lastUsage: new Date().toISOString(),
    favorites: [],
    autoRefresh: false,
    ...(uploadType === 'URL' ? { url: urlOrPath } : {}),
    ...(uploadType === 'FILE' ? { filePath: urlOrPath } : {}),
});

export const getExtensionFromUrl = (url: string): string | undefined => {
    const path = url.split(/[#?]/)[0];
    const lastSegment = path.split('/').pop() || '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex < 1) return undefined;
    const extension = lastSegment.slice(dotIndex + 1).trim();
    return extension || undefined;
};

export const getStreamExtensionFromUrl = (
    url: string
): string | undefined => {
    try {
        const parsedUrl = new URL(url, 'http://arm-nator.local');
        const queryExtension = parsedUrl.searchParams
            .get('extension')
            ?.trim()
            .replace(/^\.+/, '')
            .toLowerCase();
        return queryExtension || getExtensionFromUrl(url);
    } catch {
        return getExtensionFromUrl(url);
    }
};
