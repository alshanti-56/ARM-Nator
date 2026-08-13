/* eslint-disable max-lines */
import {
    Injectable,
    NgZone,
    computed,
    effect,
    inject,
    signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import {
    selectAllPlaylistsMeta,
    selectPlaylistsLoadingFlag,
} from '@arm-nator/providers/shared/playlist-state';
import { startWith } from 'rxjs';
import {
    DatabaseService,
    GlobalRecentlyAddedKind,
} from '@arm-nator/services';
import {
    Playlist,
    PortalAddedItem,
    PortalActivityItem,
    PlaylistMeta,
    PortalActivityType,
    PortalFavoriteItem,
    PortalRecentItem,
} from '@arm-nator/shared/interfaces';
import {
    getActivityTypeLabelKey,
    mapDbFavoriteToItem,
    mapDbRecentlyAddedToItem,
    mapDbRecentToItem,
    toDateTimestamp,
    toTimestamp,
} from './dashboard-mappers';
import {
    PORTAL_PLAYBACK_POSITIONS,
    WorkspaceNavigationTarget,
} from '@arm-nator/providers/shared/util';
import type { PlaybackPositionData } from '@arm-nator/shared/interfaces';
import {
    getGlobalFavoriteLink as getGlobalFavoriteLinkUtil,
    getGlobalFavoriteNavigationState as getGlobalFavoriteNavigationStateUtil,
    getPlaylistLink as getPlaylistLinkUtil,
    getRecentItemLink as getRecentItemLinkUtil,
    getRecentItemNavigationState as getRecentItemNavigationStateUtil,
    getRecentlyAddedLink as getRecentlyAddedLinkUtil,
    getRecentlyAddedNavigationState as getRecentlyAddedNavigationStateUtil,
    isTypeInKind as isTypeInKindUtil,
    type DashboardContentKind,
} from './dashboard-navigation.util';

export type { DashboardContentKind };

// Compound key for looking up a playback position by recent item — a single
// playlist can contain the same xtream-id for a VOD and an episode (rare,
// but the schema allows it), so contentType is part of the key.
function playbackPositionMapKey(
    playlistId: string,
    contentXtreamId: number,
    contentType: 'vod' | 'episode'
): string {
    return `${playlistId}::${contentXtreamId}::${contentType}`;
}

function seriesPlaybackPositionMapKey(
    playlistId: string,
    seriesXtreamId: number
): string {
    return `${playlistId}::${seriesXtreamId}`;
}

function newestPlaybackPosition(
    current: PlaybackPositionData | null | undefined,
    candidate: PlaybackPositionData | null | undefined
): PlaybackPositionData | null {
    if (!current) {
        return candidate ?? null;
    }
    if (!candidate) {
        return current;
    }
    return (candidate.updatedAt ?? '') > (current.updatedAt ?? '')
        ? candidate
        : current;
}

/** @deprecated Use {@link PortalRecentItem} from `@arm-nator/shared/interfaces` instead. */
export type GlobalRecentItem = PortalRecentItem;
/** @deprecated Use {@link PortalFavoriteItem} from `@arm-nator/shared/interfaces` instead. */
export type DashboardFavoriteItem = PortalFavoriteItem;
/** @deprecated Use {@link PortalAddedItem} from `@arm-nator/shared/interfaces` instead. */
export type DashboardRecentlyAddedItem = PortalAddedItem;
export type DashboardRecentlyAddedFilterKind = GlobalRecentlyAddedKind;

@Injectable({ providedIn: 'root' })
export class DashboardDataService {
    private readonly store = inject(Store);
    private readonly dbService = inject(DatabaseService);
    private readonly ngZone = inject(NgZone);
    private readonly translate = inject(TranslateService);
    private readonly playbackPositions = inject(PORTAL_PLAYBACK_POSITIONS);
    private readonly languageTick = toSignal(
        this.translate.onLangChange.pipe(startWith(null)),
        { initialValue: null }
    );

    private readonly xtreamGlobalRecentItems = signal<GlobalRecentItem[]>([]);
    private readonly xtreamRecentlyAddedItemsState = signal<
        DashboardRecentlyAddedItem[]
    >([]);
    private readonly xtreamGlobalFavorites = signal<DashboardFavoriteItem[]>(
        []
    );
    private readonly globalRecentLoadingState = signal(true);
    private readonly globalRecentLoadedState = signal(false);
    private readonly globalRecentDbLoadedState = signal(false);
    private readonly globalFavoritesLoadingState = signal(true);
    private readonly globalFavoritesLoadedState = signal(false);
    private readonly xtreamGlobalFavoritesLoadedState = signal(false);
    private readonly xtreamRecentlyAddedLoadingState = signal(true);
    private readonly xtreamRecentlyAddedLoadedState = signal(false);
    readonly playlists = this.store.selectSignal(selectAllPlaylistsMeta);
    readonly playlistsLoaded = this.store.selectSignal(
        selectPlaylistsLoadingFlag
    );
    readonly xtreamPlaylistCount = computed(
        () => this.playlists().filter((playlist) => !!playlist.serverUrl).length
    );
    readonly hasXtreamPlaylists = computed(
        () => this.xtreamPlaylistCount() > 0
    );
    readonly globalRecentLoading = this.globalRecentLoadingState.asReadonly();
    readonly globalRecentLoaded = this.globalRecentLoadedState.asReadonly();
    readonly globalFavoritesLoading =
        this.globalFavoritesLoadingState.asReadonly();
    readonly globalFavoritesLoaded =
        this.globalFavoritesLoadedState.asReadonly();
    readonly xtreamRecentlyAddedLoading =
        this.xtreamRecentlyAddedLoadingState.asReadonly();
    readonly xtreamRecentlyAddedLoaded =
        this.xtreamRecentlyAddedLoadedState.asReadonly();
    readonly xtreamRecentlyAddedItems =
        this.xtreamRecentlyAddedItemsState.asReadonly();

    readonly dashboardReady = computed(
        () =>
            this.playlistsLoaded() &&
            this.globalRecentLoaded() &&
            this.globalFavoritesLoaded() &&
            (!this.hasXtreamPlaylists() || this.xtreamRecentlyAddedLoaded())
    );

    readonly globalRecentItems = computed<GlobalRecentItem[]>(() =>
        this.xtreamGlobalRecentItems()
            .sort(
                (a, b) =>
                    toDateTimestamp(b.viewed_at) - toDateTimestamp(a.viewed_at)
            )
            .slice(0, 200)
    );

    // Split the recent list by content type so the dashboard can render
    // movies/series ("Continue watching") separately from live channels
    // ("Live now on your favorites"). Two card formats — one rail each.
    readonly globalRecentVodItems = computed<GlobalRecentItem[]>(() =>
        this.globalRecentItems().filter(
            (item) => item.type === 'movie' || item.type === 'series'
        )
    );

    readonly globalRecentLiveItems = computed<GlobalRecentItem[]>(() =>
        this.globalRecentItems().filter((item) => item.type === 'live')
    );

    // Favorited live channels — the dashboard's "Live now" rail uses this
    // source only. Recently watched live channels have their own dashboard rail.
    readonly globalFavoriteLiveItems = computed<DashboardFavoriteItem[]>(() =>
        this.globalFavoriteItems().filter((item) => item.type === 'live')
    );

    // Playback positions, keyed by `${playlist_id}::${contentXtreamId}::${type}`.
    // Loaded lazily on dashboard mount (and refreshed when recent items
    // change) so the hero + Continue Watching cards can show "X min left"
    // and a progress bar. Live channels never have positions. Map starts
    // empty and degrades cleanly on missing data.
    private readonly playbackPositionsMap = signal<
        Map<string, PlaybackPositionData>
    >(new Map());
    private readonly playbackPositionsBySeriesMap = signal<
        Map<string, PlaybackPositionData>
    >(new Map());

    readonly playbackPositions$ = this.playbackPositionsMap.asReadonly();

    getPlaybackPositionForItem(
        item: PortalActivityItem
    ): PlaybackPositionData | null {
        if (item.type !== 'movie' && item.type !== 'series') {
            return null;
        }
        const xtreamId =
            typeof item.xtream_id === 'number'
                ? item.xtream_id
                : Number(item.xtream_id);
        if (!Number.isFinite(xtreamId)) {
            return null;
        }

        if (item.type === 'movie') {
            const key = playbackPositionMapKey(
                item.playlist_id,
                xtreamId,
                'vod'
            );
            return this.playbackPositionsMap().get(key) ?? null;
        }

        // Series recent_items rows carry either the series id (the series
        // landing page writes the series itself) or, for direct-play flows,
        // the episode id. Match both shapes through keyed maps so card renders
        // do not scan every saved playback position.
        const episodePosition =
            this.playbackPositionsMap().get(
                playbackPositionMapKey(item.playlist_id, xtreamId, 'episode')
            ) ?? null;
        const seriesPosition =
            this.playbackPositionsBySeriesMap().get(
                seriesPlaybackPositionMapKey(item.playlist_id, xtreamId)
            ) ?? null;
        return newestPlaybackPosition(episodePosition, seriesPosition);
    }

    /**
     * Refresh the in-memory positions map for every playlist that owns at
     * least one VOD/series recent item. Per-playlist bulk fetch is one IPC
     * round-trip each (vs N+1 per content item), so this stays cheap even
     * on heavy libraries.
     */
    async reloadPlaybackPositions(): Promise<void> {
        const playlistIds = new Set<string>();
        for (const item of this.globalRecentItems()) {
            if (item.type === 'movie' || item.type === 'series') {
                playlistIds.add(item.playlist_id);
            }
        }
        if (playlistIds.size === 0) {
            this.playbackPositionsMap.set(new Map());
            this.playbackPositionsBySeriesMap.set(new Map());
            return;
        }

        const next = new Map<string, PlaybackPositionData>();
        const nextBySeries = new Map<string, PlaybackPositionData>();
        for (const playlistId of playlistIds) {
            try {
                const positions =
                    await this.playbackPositions.getAllPlaybackPositions(
                        playlistId
                    );
                for (const position of positions) {
                    next.set(
                        playbackPositionMapKey(
                            playlistId,
                            position.contentXtreamId,
                            position.contentType
                        ),
                        position
                    );
                    if (
                        position.contentType === 'episode' &&
                        Number.isFinite(position.seriesXtreamId)
                    ) {
                        const seriesKey = seriesPlaybackPositionMapKey(
                            playlistId,
                            position.seriesXtreamId as number
                        );
                        nextBySeries.set(
                            seriesKey,
                            newestPlaybackPosition(
                                nextBySeries.get(seriesKey),
                                position
                            ) as PlaybackPositionData
                        );
                    }
                }
            } catch (err) {
                console.warn(
                    '[DashboardData] Failed to load playback positions for playlist',
                    playlistId,
                    err
                );
            }
        }

        this.ngZone.run(() => {
            this.playbackPositionsMap.set(next);
            this.playbackPositionsBySeriesMap.set(nextBySeries);
        });
    }

    readonly globalFavoriteItems = computed(() =>
        this.xtreamGlobalFavorites()
            .sort((a, b) => toTimestamp(b.added_at) - toTimestamp(a.added_at))
            .slice(0, 200)
    );

    private readonly recentPlaylistActivityTimestamps = computed(() => {
        const timestamps = new Map<string, number>();

        for (const item of this.globalRecentItems()) {
            const viewedAt = toDateTimestamp(item.viewed_at);
            const current = timestamps.get(item.playlist_id) ?? 0;

            if (viewedAt > current) {
                timestamps.set(item.playlist_id, viewedAt);
            }
        }

        return timestamps;
    });

    constructor() {
        effect(() => {
            this.playlistsLoaded();
            this.finishInitialGlobalRecentLoadIfReady();
            this.finishInitialGlobalFavoritesLoadIfReady();
        });

        effect(() => {
            if (this.hasXtreamPlaylists()) {
                return;
            }

            this.ngZone.run(() => {
                this.xtreamRecentlyAddedItemsState.set([]);
                this.xtreamRecentlyAddedLoadingState.set(false);
                this.xtreamRecentlyAddedLoadedState.set(true);
            });
        });
    }

    readonly stats = computed(() => {
        const items = this.playlists();
        return {
            total: items.length,
            xtream: items.filter((item) => !!item.serverUrl).length,
            stalker: items.filter((item) => Boolean(item.macAddress || item.portalUrl)).length,
        };
    });

    readonly recentPlaylists = computed(() =>
        [...this.playlists()]
            .sort((a, b) => {
                const activityDelta =
                    this.getPlaylistActivityTimestamp(b) -
                    this.getPlaylistActivityTimestamp(a);
                if (activityDelta !== 0) {
                    return activityDelta;
                }

                const metadataDelta =
                    this.getRecentTimestamp(b) - this.getRecentTimestamp(a);
                if (metadataDelta !== 0) {
                    return metadataDelta;
                }

                return a._id.localeCompare(b._id);
            })
            .slice(0, 12)
    );

    readonly quickRecent = computed(() => this.recentPlaylists().slice(0, 4));

    async reloadGlobalRecentItems(): Promise<void> {
        if (!this.globalRecentLoaded()) {
            this.globalRecentLoadingState.set(true);
        }

        try {
            const recentItems = await this.dbService.getGlobalRecentlyViewed();
            const normalized = recentItems.map((item) =>
                mapDbRecentToItem(item)
            );
            this.ngZone.run(() => this.xtreamGlobalRecentItems.set(normalized));
        } catch (err) {
            console.warn(
                '[DashboardData] Failed to reload global recent items',
                err
            );
            this.ngZone.run(() => this.xtreamGlobalRecentItems.set([]));
        } finally {
            this.globalRecentDbLoadedState.set(true);
            this.finishInitialGlobalRecentLoadIfReady();
        }
    }

    async reloadGlobalFavorites(): Promise<void> {
        if (!this.globalFavoritesLoaded()) {
            this.globalFavoritesLoadingState.set(true);
            this.xtreamGlobalFavoritesLoadedState.set(false);
        }

        const xtreamReload = this.reloadXtreamGlobalFavorites().finally(() => {
            this.ngZone.run(() =>
                this.xtreamGlobalFavoritesLoadedState.set(true)
            );
            this.finishInitialGlobalFavoritesLoadIfReady();
        });
        await xtreamReload;
        this.finishInitialGlobalFavoritesLoadIfReady();
    }

    async getGlobalRecentlyAddedItems(
        kind: DashboardRecentlyAddedFilterKind,
        limit = 200
    ): Promise<DashboardRecentlyAddedItem[]> {
        const items = await this.dbService.getGlobalRecentlyAdded(kind, limit);
        return items
            .map((item) => mapDbRecentlyAddedToItem(item))
            .sort((a, b) => toTimestamp(b.added_at) - toTimestamp(a.added_at));
    }

    async getXtreamRecentlyAddedItems(
        limit = 20
    ): Promise<DashboardRecentlyAddedItem[]> {
        const items = await this.dbService.getGlobalRecentlyAdded(
            'all',
            limit,
            'xtream'
        );
        return items
            .map((item) => mapDbRecentlyAddedToItem(item))
            .sort((a, b) => toTimestamp(b.added_at) - toTimestamp(a.added_at));
    }

    async reloadXtreamRecentlyAddedItems(limit = 20): Promise<void> {
        if (!this.xtreamRecentlyAddedLoaded()) {
            this.xtreamRecentlyAddedLoadingState.set(true);
        }

        try {
            const items = await this.getXtreamRecentlyAddedItems(limit);
            this.ngZone.run(() =>
                this.xtreamRecentlyAddedItemsState.set(items)
            );
        } catch (err) {
            console.warn(
                '[DashboardData] Failed to reload Xtream recently added items',
                err
            );
            this.ngZone.run(() => this.xtreamRecentlyAddedItemsState.set([]));
        } finally {
            this.ngZone.run(() => {
                this.xtreamRecentlyAddedLoadingState.set(false);
                this.xtreamRecentlyAddedLoadedState.set(true);
            });
        }
    }

    private async reloadXtreamGlobalFavorites(): Promise<void> {
        try {
            const favorites = await this.dbService.getAllGlobalFavorites();
            const normalized = favorites.map((item) =>
                mapDbFavoriteToItem(item)
            );
            this.ngZone.run(() => this.xtreamGlobalFavorites.set(normalized));
        } catch (err) {
            console.warn(
                '[DashboardData] Failed to reload global favorites',
                err
            );
            this.ngZone.run(() => this.xtreamGlobalFavorites.set([]));
        }
    }

    private finishInitialGlobalFavoritesLoadIfReady(): void {
        if (
            !this.playlistsLoaded() ||
            !this.xtreamGlobalFavoritesLoadedState()
        ) {
            return;
        }

        this.ngZone.run(() => {
            this.globalFavoritesLoadedState.set(true);
            this.globalFavoritesLoadingState.set(false);
        });
    }

    private finishInitialGlobalRecentLoadIfReady(): void {
        if (!this.playlistsLoaded() || !this.globalRecentDbLoadedState()) {
            return;
        }

        this.ngZone.run(() => {
            this.globalRecentLoadedState.set(true);
            this.globalRecentLoadingState.set(false);
        });
    }

    isTypeInKind(
        type: PortalActivityType,
        kind: DashboardContentKind
    ): boolean {
        return isTypeInKindUtil(type, kind);
    }

    getPlaylistLink(playlist: PlaylistMeta): string[] {
        return getPlaylistLinkUtil(playlist);
    }

    getPlaylistProvider(playlist: PlaylistMeta): string {
        this.languageTick();

        if (playlist.macAddress || playlist.portalUrl || playlist.isFullStalkerPortal) {
            return this.translateText('WORKSPACE.DASHBOARD.STALKER');
        }

        if (playlist.serverUrl) {
            return this.translateText('WORKSPACE.DASHBOARD.XTREAM');
        }

        return this.translateText('WORKSPACE.DASHBOARD.PROVIDER');
    }

    getRecentItemProviderLabel(item: GlobalRecentItem): string {
        this.languageTick();

        if (item.source === 'xtream') {
            return this.translateText('WORKSPACE.DASHBOARD.XTREAM');
        }
        return this.translateText('WORKSPACE.DASHBOARD.PROVIDER');
    }

    getRecentItemTypeLabel(item: GlobalRecentItem): string {
        this.languageTick();
        return this.translateText(getActivityTypeLabelKey(item.type));
    }

    getRecentItemLink(item: GlobalRecentItem): string[] {
        return getRecentItemLinkUtil(item);
    }

    getRecentItemNavigationState(
        item: GlobalRecentItem
    ): WorkspaceNavigationTarget['state'] {
        return getRecentItemNavigationStateUtil(
            item,
            this.getPlaybackPositionForItem(item)
        );
    }

    async removeGlobalRecentItem(item: GlobalRecentItem): Promise<void> {
        if (item.source === 'xtream') {
            await this.dbService.removeRecentItem(
                item.id as number,
                item.playlist_id
            );
            await this.reloadGlobalRecentItems();
            return;
        }

    }

    getFavoriteItemProviderLabel(item: DashboardFavoriteItem): string {
        return this.getActivityItemProviderLabel(item);
    }

    getRecentlyAddedItemProviderLabel(
        item: DashboardRecentlyAddedItem
    ): string {
        return this.getActivityItemProviderLabel(item);
    }

    private getActivityItemProviderLabel(
        item: Pick<PortalActivityItem, 'source'>
    ): string {
        this.languageTick();

        if (item.source === 'xtream') {
            return this.translateText('WORKSPACE.DASHBOARD.XTREAM');
        }
        return this.translateText('WORKSPACE.DASHBOARD.PROVIDER');
    }

    getFavoriteItemTypeLabel(item: DashboardFavoriteItem): string {
        return this.getActivityItemTypeLabel(item);
    }

    getRecentlyAddedItemTypeLabel(item: DashboardRecentlyAddedItem): string {
        return this.getActivityItemTypeLabel(item);
    }

    private getActivityItemTypeLabel(
        item: Pick<PortalActivityItem, 'type'>
    ): string {
        this.languageTick();
        return this.translateText(getActivityTypeLabelKey(item.type));
    }

    getGlobalFavoriteLink(item: DashboardFavoriteItem): string[] {
        return getGlobalFavoriteLinkUtil(item);
    }

    getGlobalFavoriteNavigationState(
        item: DashboardFavoriteItem
    ): WorkspaceNavigationTarget['state'] {
        return getGlobalFavoriteNavigationStateUtil(item);
    }

    getRecentlyAddedLink(item: DashboardRecentlyAddedItem): string[] {
        return getRecentlyAddedLinkUtil(item);
    }

    getRecentlyAddedNavigationState(
        item: DashboardRecentlyAddedItem
    ): WorkspaceNavigationTarget['state'] {
        return getRecentlyAddedNavigationStateUtil(item);
    }

    async removeGlobalFavorite(item: DashboardFavoriteItem): Promise<void> {
        if (item.source === 'xtream') {
            await this.dbService.removeFromFavorites(
                item.id as number,
                item.playlist_id
            );
            await this.reloadGlobalFavorites();
            return;
        }

    }

    formatTimestamp(value?: string | number): string {
        this.languageTick();

        const timestamp = toTimestamp(value);
        if (!timestamp) {
            return this.translateText('WORKSPACE.DASHBOARD.NOT_YET_SYNCED');
        }

        return new Date(timestamp).toLocaleString(this.getLocale());
    }

    private getPlaylistActivityTimestamp(item: PlaylistMeta): number {
        return this.recentPlaylistActivityTimestamps().get(item._id) ?? 0;
    }

    private getRecentTimestamp(item: PlaylistMeta): number {
        return toTimestamp(item.updateDate) || toTimestamp(item.importDate);
    }

    private getLocale(): string | undefined {
        return (
            this.translate.currentLang ||
            this.translate.defaultLang ||
            undefined
        );
    }

    private translateText(
        key: string,
        params?: Record<string, string | number>
    ): string {
        return this.translate.instant(key, params);
    }
}
