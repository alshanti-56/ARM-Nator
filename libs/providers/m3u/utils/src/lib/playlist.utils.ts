import { Channel, Playlist } from '@arm-nator/shared/interfaces';

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

export {
    createPlaylistObject,
    extractM3uEpgUrls,
    filterPlaylistEpgUrlsForFetch,
    getExtensionFromUrl,
    getStreamExtensionFromUrl,
    M3U_AUTO_IMPORT_EPG_URL_LIMIT,
    M3U_RECOMMENDED_EPG_URL_LIMIT,
    normalizeEpgUrls,
    resolveM3uEpgUrlSelection,
    resolvePlaylistEpgSourceState,
    type M3uEpgUrlSelection,
    type PlaylistEpgSourceState,
    type PlaylistEpgSourceStateInput,
} from './playlist-epg.utils';
