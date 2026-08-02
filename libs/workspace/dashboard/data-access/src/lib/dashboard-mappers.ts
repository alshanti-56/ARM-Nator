import {
    GlobalFavoriteItem as DbGlobalFavoriteItem,
    GlobalRecentlyAddedItem as DbGlobalRecentlyAddedItem,
    GlobalRecentItem as DbGlobalRecentItem,
} from '@arm-nator/services';
import {
    PortalAddedItem,
    PlaylistMeta,
    PortalActivityType,
    PortalFavoriteItem,
    PortalRecentItem,
    normalizeDate,
} from '@arm-nator/shared/interfaces';

// ────── Type / label helpers ──────

export function normalizeActivityType(value: string): PortalActivityType {
    return value === 'live' || value === 'series' ? value : 'movie';
}

export function getActivityTypeLabelKey(type: PortalActivityType): string {
    if (type === 'live') return 'WORKSPACE.DASHBOARD.TYPE_LIVE';
    if (type === 'series') return 'WORKSPACE.DASHBOARD.TYPE_SERIES';
    return 'WORKSPACE.DASHBOARD.TYPE_MOVIE';
}

// ────── Xtream DB → ViewModel ──────

export function mapDbFavoriteToItem(
    item: DbGlobalFavoriteItem
): PortalFavoriteItem {
    return {
        id: item.id,
        title: item.title,
        type: normalizeActivityType(item.type),
        playlist_id: item.playlist_id,
        playlist_name: item.playlist_name,
        added_at: normalizeDate(item.added_at),
        category_id: item.category_id,
        xtream_id: item.xtream_id,
        poster_url: item.poster_url,
        backdrop_url: item.backdrop_url ?? undefined,
        source: 'xtream',
    };
}

export function mapDbRecentToItem(item: DbGlobalRecentItem): PortalRecentItem {
    return {
        id: item.id,
        title: item.title,
        type: normalizeActivityType(item.type),
        playlist_id: item.playlist_id,
        playlist_name: item.playlist_name,
        viewed_at: normalizeDate(item.viewed_at),
        category_id: item.category_id,
        xtream_id: item.xtream_id,
        poster_url: item.poster_url,
        backdrop_url: item.backdrop_url ?? undefined,
        source: 'xtream',
    };
}

export function mapDbRecentlyAddedToItem(
    item: DbGlobalRecentlyAddedItem
): PortalAddedItem {
    return {
        id: item.id,
        title: item.title,
        type: normalizeActivityType(item.type),
        playlist_id: item.playlist_id,
        playlist_name: item.playlist_name,
        added_at: normalizeDate(item.added_at),
        category_id: item.category_id,
        xtream_id: item.xtream_id,
        poster_url: item.poster_url,
        source: 'xtream',
    };
}

// ────── Timestamp helpers ──────

export function toDateTimestamp(value: unknown): number {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value <= 0) return 0;
        return value > 10_000_000_000 ? value : value * 1000;
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\d+$/.test(trimmed)) {
            const numeric = Number(trimmed);
            if (Number.isFinite(numeric) && numeric > 0) {
                return numeric > 10_000_000_000 ? numeric : numeric * 1000;
            }
            return 0;
        }
        const parsed = Date.parse(normalizeDate(trimmed) || trimmed);
        return Number.isNaN(parsed) ? 0 : parsed;
    }

    return 0;
}

export function toTimestamp(value?: string | number): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const parsed = Date.parse(normalizeDate(value) || value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}
