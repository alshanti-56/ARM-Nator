import {
    PlaylistMeta,
    PlaybackPositionData,
    PortalActivityType,
    PortalAddedItem,
    PortalFavoriteItem,
    PortalRecentItem,
} from '@arm-nator/shared/interfaces';
import {
    buildXtreamNavigationTarget,
    getGlobalFavoriteNavigation,
    getRecentItemNavigation,
    WorkspaceNavigationTarget,
    type SeriesResumeTarget,
} from '@arm-nator/providers/shared/util';

/**
 * Pure navigation/link helpers for dashboard items.
 *
 * Extracted from `DashboardDataService` so the routing logic can be unit-tested
 * in isolation and the service stays a thin facade. None of these functions
 * touch component/service state — they map a dashboard item to a router link
 * (and optional navigation state) using the shared portal navigation builders.
 */

export type DashboardContentKind = 'all' | 'channels' | 'vod' | 'series';

export function isTypeInKind(
    type: PortalActivityType,
    kind: DashboardContentKind
): boolean {
    if (kind === 'all') {
        return true;
    }
    if (kind === 'channels') {
        return type === 'live';
    }
    if (kind === 'vod') {
        return type === 'movie';
    }
    return type === 'series';
}

export function getPlaylistLink(playlist: PlaylistMeta): string[] {
    if (playlist.macAddress || playlist.portalUrl || playlist.isFullStalkerPortal) {
        return ['/workspace', 'stalker', playlist._id, 'itv'];
    }

    if (playlist.serverUrl) {
        return ['/workspace', 'xtreams', playlist._id, 'vod'];
    }

    return ['/workspace', 'xtreams', playlist._id, 'vod'];
}

export function getRecentItemLink(item: PortalRecentItem): string[] {
    return getRecentItemNavigation(item).link;
}

export function getRecentItemNavigationState(
    item: PortalRecentItem,
    playbackPosition?: PlaybackPositionData | null
): WorkspaceNavigationTarget['state'] {
    return getRecentItemNavigation(
        item,
        buildRecentSeriesResumeTarget(item, playbackPosition)
    ).state;
}

function buildRecentSeriesResumeTarget(
    item: PortalRecentItem,
    playbackPosition?: PlaybackPositionData | null
): SeriesResumeTarget | null {
    if (
        item.type !== 'series' ||
        item.source !== 'xtream' ||
        playbackPosition?.contentType !== 'episode'
    ) {
        return null;
    }

    // Episode-keyed recent rows make item.xtream_id an episode id, so only a
    // position row that names its parent series can produce a resume target;
    // legacy rows without seriesXtreamId stay detail-only.
    const seriesXtreamId = Number(playbackPosition.seriesXtreamId);
    const contentXtreamId = Number(playbackPosition.contentXtreamId);
    const seasonNumber = Number(playbackPosition.seasonNumber);
    const episodeNumber = Number(playbackPosition.episodeNumber);

    if (
        !Number.isInteger(seriesXtreamId) ||
        seriesXtreamId <= 0 ||
        !Number.isInteger(contentXtreamId) ||
        contentXtreamId <= 0 ||
        !Number.isInteger(seasonNumber) ||
        seasonNumber < 0 ||
        !Number.isInteger(episodeNumber) ||
        episodeNumber < 0
    ) {
        return null;
    }

    return {
        seriesXtreamId,
        contentXtreamId,
        seasonNumber,
        episodeNumber,
    };
}

export function getGlobalFavoriteLink(item: PortalFavoriteItem): string[] {
    return getGlobalFavoriteNavigation(item).link;
}

export function getGlobalFavoriteNavigationState(
    item: PortalFavoriteItem
): WorkspaceNavigationTarget['state'] {
    return getGlobalFavoriteNavigation(item).state;
}

export function getRecentlyAddedLink(item: PortalAddedItem): string[] {
    return buildXtreamNavigationTarget({
        playlistId: item.playlist_id,
        type: item.type,
        categoryId: item.category_id,
        itemId: item.xtream_id,
        title: item.title,
        imageUrl: item.poster_url,
    }).link;
}

export function getRecentlyAddedNavigationState(
    item: PortalAddedItem
): WorkspaceNavigationTarget['state'] {
    return buildXtreamNavigationTarget({
        playlistId: item.playlist_id,
        type: item.type,
        categoryId: item.category_id,
        itemId: item.xtream_id,
        title: item.title,
        imageUrl: item.poster_url,
    }).state;
}
