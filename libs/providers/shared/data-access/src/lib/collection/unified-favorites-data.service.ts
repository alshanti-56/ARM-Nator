/* eslint-disable max-lines */
import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { PlaylistActions, selectAllPlaylistsMeta } from '@arm-nator/providers/m3u/state';
import { firstValueFrom, map } from 'rxjs';
import {
    DatabaseService,
    PlaylistsService,
} from '@arm-nator/services';
import {
    Channel,
    normalizeDate,
    Playlist,
    PlaylistMeta,
} from '@arm-nator/shared/interfaces';
import {
    buildCollectionUid,
    buildXtreamCollectionUid,
    CollectionScope,
    UnifiedCollectionItem,
    xtreamContentType,
    XtreamFavoriteRow,
} from '@arm-nator/providers/shared/util';

const GLOBAL_FAVORITES_ORDER_KEY = 'global-favorites-channel-order-v1';

type PlaylistWithChannels = Omit<Playlist, 'playlist'> & {
    readonly playlist?: { readonly items?: Channel[] };
};
@Injectable({ providedIn: 'root' })
export class UnifiedFavoritesDataService {
    private readonly store = inject(Store);
    private readonly dbService = inject(DatabaseService);
    private readonly playlistsService = inject(PlaylistsService);

    async getFavorites(
        scope: CollectionScope,
        playlistId?: string,
        portalType?: string
    ): Promise<UnifiedCollectionItem[]> {
        if (scope === 'playlist' && playlistId) {
            return this.getPlaylistFavorites(playlistId, portalType);
        }
        return this.getAllFavorites();
    }

    async addFavorite(item: UnifiedCollectionItem): Promise<void> {
        switch (item.sourceType) {
            case 'm3u':
                await this.addM3uFavorite(item);
                break;
            case 'xtream':
                await this.addXtreamFavorite(item);
                break;
        }
    }

    async removeFavorite(item: UnifiedCollectionItem): Promise<void> {
        switch (item.sourceType) {
            case 'm3u': {
                await this.transformM3uFavorites(item.playlistId, (current) =>
                    current.filter(
                        (favoriteId) =>
                            favoriteId !== item.streamUrl &&
                            favoriteId !== item.channelId
                    )
                );
                break;
            }
            case 'xtream': {
                if (item.contentId == null) {
                    return;
                }
                await this.requireElectronBridge().dbRemoveFavorite(
                    item.contentId,
                    item.playlistId
                );
                break;
            }
        }
    }

    private async addM3uFavorite(item: UnifiedCollectionItem): Promise<void> {
        const favoriteId = item.streamUrl ?? item.channelId;
        if (!favoriteId) {
            return;
        }

        await this.transformM3uFavorites(item.playlistId, (current) =>
            current.includes(favoriteId) ? current : [...current, favoriteId]
        );
    }

    private async addXtreamFavorite(
        item: UnifiedCollectionItem
    ): Promise<void> {
        const contentId =
            item.contentId ??
            (item.xtreamId != null
                ? await this.resolveXtreamContentId(item)
                : null);

        if (contentId == null) {
            return;
        }

        await this.requireElectronBridge().dbAddFavorite(
            contentId,
            item.playlistId,
            item.posterUrl ?? item.logo ?? undefined
        );
    }

    async clearFavorites(items: UnifiedCollectionItem[]): Promise<void> {
        if (items.length === 0) {
            return;
        }

        await Promise.all([
            this.clearM3uFavorites(
                items.filter((item) => item.sourceType === 'm3u')
            ),
            this.clearXtreamFavorites(
                items.filter((item) => item.sourceType === 'xtream')
            ),
        ]);
    }

    async reorder(
        items: UnifiedCollectionItem[],
        options?: {
            scope: CollectionScope;
            playlistId?: string;
            portalType?: string;
        }
    ): Promise<void> {
        if (
            options?.scope === 'playlist' &&
            options.playlistId &&
            options.portalType === 'm3u'
        ) {
            const orderedIds = items
                .map((item) => item.streamUrl ?? item.channelId ?? '')
                .filter((value) => value.length > 0);
            const orderedIdSet = new Set(orderedIds);
            await this.transformM3uFavorites(options.playlistId, (current) => [
                ...orderedIds,
                ...current.filter((favorite) => !orderedIdSet.has(favorite)),
            ]);
            return;
        }

        const xtreamUpdates = this.buildXtreamPositionUpdates(items);
        const electron = this.requireElectronBridge();

        if (
            options?.scope === 'playlist' &&
            options.playlistId &&
            options.portalType === 'xtream'
        ) {
            if (xtreamUpdates.length > 0) {
                await electron.dbReorderGlobalFavorites(xtreamUpdates);
            }
            return;
        }

        await Promise.all([
            xtreamUpdates.length > 0
                ? electron.dbReorderGlobalFavorites(xtreamUpdates)
                : Promise.resolve(),
            this.saveOrder(items.map((item) => item.uid)),
        ]);
    }

    private async getAllFavorites(): Promise<UnifiedCollectionItem[]> {
        const [m3u, xtream, order] = await Promise.all([
            this.getM3uFavorites(),
            this.getXtreamAllFavorites(),
            this.getSavedOrder(),
        ]);
        return this.applyOrder([...m3u, ...xtream], order);
    }

    private async clearM3uFavorites(
        items: UnifiedCollectionItem[]
    ): Promise<void> {
        const groupedItems = this.groupItemsByPlaylist(items);

        await Promise.all(
            Array.from(groupedItems.entries()).map(
                async ([playlistId, playlistItems]) => {
                    const targetIds = new Set<string>();
                    playlistItems.forEach((item) => {
                        [item.streamUrl, item.channelId].forEach((value) => {
                            const normalized = value?.trim();
                            if (normalized) {
                                targetIds.add(normalized);
                            }
                        });
                    });

                    await this.transformM3uFavorites(playlistId, (current) =>
                        current.filter(
                            (favorite) => !targetIds.has(favorite.trim())
                        )
                    );
                }
            )
        );
    }

    private async clearXtreamFavorites(
        items: UnifiedCollectionItem[]
    ): Promise<void> {
        const electron = this.requireElectronBridge();
        await Promise.all(
            items
                .filter(
                    (
                        item
                    ): item is UnifiedCollectionItem & {
                        readonly contentId: number;
                    } => item.contentId != null
                )
                .map((item) =>
                    electron.dbRemoveFavorite(item.contentId, item.playlistId)
                )
        );
    }

    private async getPlaylistFavorites(
        playlistId: string,
        portalType?: string
    ): Promise<UnifiedCollectionItem[]> {
        if (portalType === 'xtream')
            return this.getXtreamPlaylistFavorites(playlistId);
        return this.getM3uPlaylistFavorites(playlistId);
    }

    private async getM3uFavorites(): Promise<UnifiedCollectionItem[]> {
        const allMeta = await this.getAllMeta();
        const results: UnifiedCollectionItem[] = [];
        for (const meta of allMeta.filter(
            (p) => p._id && !p.serverUrl && !p.macAddress
        )) {
            results.push(...(await this.extractM3uFavorites(meta)));
        }
        return results;
    }

    private async getM3uPlaylistFavorites(
        id: string
    ): Promise<UnifiedCollectionItem[]> {
        const meta = await this.getPlaylistMeta(id);
        return meta ? this.extractM3uFavorites(meta) : [];
    }

    private async extractM3uFavorites(
        meta: PlaylistMeta
    ): Promise<UnifiedCollectionItem[]> {
        if (!meta.favorites?.length) return [];
        const favoriteIds = (meta.favorites as string[]).map(String);
        let playlist: PlaylistWithChannels | undefined;
        try {
            playlist = (await firstValueFrom(
                this.playlistsService.getPlaylistById(meta._id)
            )) as PlaylistWithChannels | undefined;
        } catch {
            return [];
        }
        const channels = playlist?.playlist?.items ?? [];
        const channelsByFavoriteId = new Map<string, Channel>();
        channels.forEach((channel) => {
            if (channel.url?.trim()) {
                channelsByFavoriteId.set(channel.url.trim(), channel);
            }
            if (channel.id?.trim()) {
                channelsByFavoriteId.set(channel.id.trim(), channel);
            }
        });

        const seenUrls = new Set<string>();
        return favoriteIds
            .map((favoriteId, index) => {
                const channel = channelsByFavoriteId.get(favoriteId.trim());
                if (!channel?.url || seenUrls.has(channel.url)) {
                    return null;
                }
                seenUrls.add(channel.url);
                const sourceItemId = channel.url?.trim() || channel.id?.trim();
                if (!sourceItemId) {
                    return null;
                }

                return {
                    uid: buildCollectionUid('m3u', meta._id, sourceItemId),
                    name: channel.name,
                    contentType: 'live' as const,
                    sourceType: 'm3u' as const,
                    playlistId: meta._id,
                    playlistName: meta.title || meta.filename || 'M3U',
                    logo: channel.tvg?.logo ?? null,
                    streamUrl: channel.url,
                    channelId: channel.id,
                    radio: channel.radio,
                    m3uChannel: channel,
                    tvgId: channel.tvg?.id || channel.tvg?.name || channel.name,
                    addedAt: new Date(0).toISOString(),
                    position: index,
                } satisfies UnifiedCollectionItem;
            })
            .filter((channel) => channel !== null) as UnifiedCollectionItem[];
    }

    private async getXtreamAllFavorites(): Promise<UnifiedCollectionItem[]> {
        try {
            const rows =
                (await this.dbService.getAllGlobalFavorites()) as XtreamFavoriteRow[];
            return rows.map((r) => this.mapXtreamRow(r));
        } catch {
            return [];
        }
    }

    private async getXtreamPlaylistFavorites(
        playlistId: string
    ): Promise<UnifiedCollectionItem[]> {
        try {
            const meta = await this.getPlaylistMeta(playlistId);
            const rows = await this.dbService.getFavorites(playlistId);
            return (rows as unknown as XtreamFavoriteRow[]).map((r) => ({
                ...this.mapXtreamRow(r),
                playlistId,
                playlistName: meta?.title || 'Xtream',
            }));
        } catch {
            return [];
        }
    }

    private async resolveXtreamContentId(
        item: UnifiedCollectionItem
    ): Promise<number | null> {
        if (item.xtreamId == null) {
            return null;
        }

        const content = await this.dbService.getContentByXtreamId(
            item.xtreamId,
            item.playlistId,
            item.contentType
        );

        return content?.id ?? null;
    }

    private mapXtreamRow(row: XtreamFavoriteRow): UnifiedCollectionItem {
        const ct = xtreamContentType(row.type);
        return {
            uid: buildXtreamCollectionUid(row.playlist_id, ct, row.xtream_id),
            name: row.title,
            contentType: ct,
            sourceType: 'xtream',
            playlistId: row.playlist_id,
            playlistName: row.playlist_name ?? 'Xtream',
            logo: ct === 'live' ? (row.poster_url ?? null) : null,
            posterUrl: ct !== 'live' ? (row.poster_url ?? null) : null,
            xtreamId: row.xtream_id,
            categoryId: row.category_id,
            tvgId: ct === 'live' ? String(row.xtream_id) : undefined,
            rating: row.rating ?? undefined,
            tvArchive: row.tv_archive ?? null,
            tvArchiveDuration: row.tv_archive_duration ?? null,
            addedAt:
                normalizeDate(row.added_at) || new Date(0).toISOString(),
            position: row.position ?? 0,
            contentId: row.id,
        };
    }

    private async getAllMeta(): Promise<PlaylistMeta[]> {
        return firstValueFrom(
            this.store
                .select(selectAllPlaylistsMeta)
                .pipe(map((m) => m as PlaylistMeta[]))
        );
    }

    private async getPlaylistMeta(
        id: string
    ): Promise<PlaylistMeta | undefined> {
        return (await this.getAllMeta()).find((p) => p._id === id);
    }

    private async getSavedOrder(): Promise<string[]> {
        const electron = this.requireElectronBridge();
        try {
            const raw = await electron.dbGetAppState(
                GLOBAL_FAVORITES_ORDER_KEY
            );
            return raw ? (JSON.parse(raw) as string[]) : [];
        } catch {
            return [];
        }
    }

    private async saveOrder(uidOrder: string[]): Promise<void> {
        const electron = this.requireElectronBridge();
        try {
            await electron.dbSetAppState(
                GLOBAL_FAVORITES_ORDER_KEY,
                JSON.stringify(uidOrder)
            );
        } catch {
            /* ignore */
        }
    }

    private async transformM3uFavorites(
        playlistId: string,
        transform: (currentFavorites: string[]) => string[]
    ): Promise<void> {
        const updatedPlaylist = await firstValueFrom(
            this.playlistsService.transformPlaylistFavorites(
                playlistId,
                (current) =>
                    transform(
                        current.filter(
                            (favorite): favorite is string =>
                                typeof favorite === 'string'
                        )
                    )
            )
        );
        this.store.dispatch(
            PlaylistActions.updatePlaylistMeta({
                playlist: {
                    _id: playlistId,
                    favorites: updatedPlaylist.favorites,
                } as PlaylistMeta,
            })
        );
    }

    private applyOrder(
        items: UnifiedCollectionItem[],
        savedOrder: string[]
    ): UnifiedCollectionItem[] {
        if (!savedOrder.length) {
            return items.slice().sort((a, b) => {
                const pa = a.position ?? 0;
                const pb = b.position ?? 0;
                if (pa !== pb) return pa - pb;
                return (
                    new Date(b.addedAt ?? 0).getTime() -
                    new Date(a.addedAt ?? 0).getTime()
                );
            });
        }
        const orderMap = new Map(savedOrder.map((uid, i) => [uid, i]));
        const ordered: UnifiedCollectionItem[] = [];
        const unordered: UnifiedCollectionItem[] = [];
        for (const item of items) {
            const pos = orderMap.get(item.uid);
            if (pos != null) {
                ordered.push({ ...item, position: pos });
            } else {
                unordered.push(item);
            }
        }
        ordered.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        unordered.sort(
            (a, b) =>
                new Date(b.addedAt ?? 0).getTime() -
                new Date(a.addedAt ?? 0).getTime()
        );
        return [...ordered, ...unordered];
    }

    private buildXtreamPositionUpdates(items: UnifiedCollectionItem[]) {
        const updates: {
            content_id: number;
            playlist_id: string;
            position: number;
        }[] = [];

        for (const item of items) {
            if (item.sourceType === 'xtream' && item.contentId != null) {
                updates.push({
                    content_id: item.contentId,
                    playlist_id: item.playlistId,
                    position: updates.length,
                });
            }
        }

        return updates;
    }

    private groupItemsByPlaylist(
        items: UnifiedCollectionItem[]
    ): Map<string, UnifiedCollectionItem[]> {
        return items.reduce((groups, item) => {
            const group = groups.get(item.playlistId);
            if (group) {
                group.push(item);
            } else {
                groups.set(item.playlistId, [item]);
            }

            return groups;
        }, new Map<string, UnifiedCollectionItem[]>());
    }

    private requireElectronBridge(): NonNullable<Window['electron']> {
        if (!window.electron) {
            throw new Error('Electron bridge is unavailable');
        }
        return window.electron;
    }
}
