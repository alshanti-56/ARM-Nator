import { PlaylistMeta } from './playlist-meta.type';
import { PortalRecentItem } from './portal-activity-item.interface';
import { normalizeDate } from './date-normalizer';
import {
    PlaylistRecentlyViewedItem,
    isM3uRecentlyViewedItem,
} from './playlist-recently-viewed.interface';

interface PlaylistRecentLabels {
    m3u: string;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
    return values.map((value) => value?.trim()).find(Boolean);
}

function getPlaylistRecentItems(
    playlist: PlaylistMeta
): PlaylistRecentlyViewedItem[] {
    return Array.isArray(playlist.recentlyViewed)
        ? (playlist.recentlyViewed as PlaylistRecentlyViewedItem[])
        : [];
}

function mapM3uPlaylistRecentItems(
    playlist: PlaylistMeta,
    defaultPlaylistName: string
): PortalRecentItem[] {
    return getPlaylistRecentItems(playlist).reduce<PortalRecentItem[]>(
        (acc, rawItem) => {
            if (!isM3uRecentlyViewedItem(rawItem)) {
                return acc;
            }

            const channelUrl = rawItem.url.trim();
            if (!channelUrl) {
                return acc;
            }

            acc.push({
                id: rawItem.id || channelUrl,
                title:
                    firstNonEmpty(
                        rawItem.title,
                        rawItem.tvg_name,
                        rawItem.channel_id
                    ) ||
                    channelUrl,
                type: 'live',
                playlist_id: playlist._id,
                playlist_name: playlist.title || defaultPlaylistName,
                viewed_at: normalizeDate(rawItem.added_at),
                category_id: rawItem.category_id || 'live',
                xtream_id: channelUrl,
                poster_url: rawItem.poster_url || undefined,
                source: 'm3u',
            });

            return acc;
        },
        []
    );
}

export function buildPlaylistRecentItems(
    playlists: PlaylistMeta[],
    labels: PlaylistRecentLabels
): PortalRecentItem[] {
    return playlists.reduce<PortalRecentItem[]>((acc, playlist) => {
        if (!playlist.serverUrl) {
            acc.push(...mapM3uPlaylistRecentItems(playlist, labels.m3u));
        }

        return acc;
    }, []);
}
