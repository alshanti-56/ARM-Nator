import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { selectAllPlaylistsMeta } from '@arm-nator/providers/shared/playlist-state';
import { DatabaseService } from '@arm-nator/services';
import { normalizeDate, PlaylistMeta } from '@arm-nator/shared/interfaces';
import {
    buildXtreamCollectionUid,
    CollectionScope,
    UnifiedCollectionItem,
    xtreamContentType,
    XtreamFavoriteRow,
} from '@arm-nator/providers/shared/util';

const GLOBAL_FAVORITES_ORDER_KEY = 'global-favorites-channel-order-v1';

@Injectable({ providedIn: 'root' })
export class UnifiedFavoritesDataService {
    private readonly store = inject(Store);
    private readonly dbService = inject(DatabaseService);

    async getFavorites(
        scope: CollectionScope,
        playlistId?: string,
        _portalType?: string
    ): Promise<UnifiedCollectionItem[]> {
        if (scope === 'playlist' && playlistId) {
            return this.getXtreamPlaylistFavorites(playlistId);
        }
        return this.getAllFavorites();
    }

    async addFavorite(item: UnifiedCollectionItem): Promise<void> {
        if (item.contentId == null && item.xtreamId == null) return;
        const contentId =
            item.contentId ?? (await this.resolveXtreamContentId(item));
        if (contentId == null) return;
        await this.requireElectronBridge().dbAddFavorite(
            contentId,
            item.playlistId,
            item.posterUrl ?? item.logo ?? undefined
        );
    }

    async removeFavorite(item: UnifiedCollectionItem): Promise<void> {
        if (item.contentId == null) return;
        await this.requireElectronBridge().dbRemoveFavorite(
            item.contentId,
            item.playlistId
        );
    }

    async clearFavorites(items: UnifiedCollectionItem[]): Promise<void> {
        const electron = this.requireElectronBridge();
        await Promise.all(
            items
                .filter((item) => item.contentId != null)
                .map((item) => {
                    const contentId = item.contentId as number;
                    return electron.dbRemoveFavorite(contentId, item.playlistId);
                })
        );
    }

    async reorder(
        items: UnifiedCollectionItem[],
        options?: {
            scope: CollectionScope;
            playlistId?: string;
            portalType?: string;
        }
    ): Promise<void> {
        const updates = this.buildXtreamPositionUpdates(items);
        const electron = this.requireElectronBridge();
        if (
            options?.scope === 'playlist' &&
            options.playlistId &&
            updates.length > 0
        ) {
            await electron.dbReorderGlobalFavorites(updates);
            return;
        }
        if (updates.length > 0) {
            await electron.dbReorderGlobalFavorites(updates);
        }
        await this.saveOrder(items.map((item) => item.uid));
    }

    private async getAllFavorites(): Promise<UnifiedCollectionItem[]> {
        const [items, order] = await Promise.all([
            this.getXtreamAllFavorites(),
            this.getSavedOrder(),
        ]);
        return this.applyOrder(items, order);
    }

    private async getXtreamAllFavorites(): Promise<UnifiedCollectionItem[]> {
        try {
            const rows =
                (await this.dbService.getAllGlobalFavorites()) as XtreamFavoriteRow[];
            return rows.map((row) => this.mapXtreamRow(row));
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
            return (rows as unknown as XtreamFavoriteRow[]).map((row) => ({
                ...this.mapXtreamRow(row),
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
        if (item.xtreamId == null) return null;
        const content = await this.dbService.getContentByXtreamId(
            item.xtreamId,
            item.playlistId,
            item.contentType
        );
        return content?.id ?? null;
    }

    private mapXtreamRow(row: XtreamFavoriteRow): UnifiedCollectionItem {
        const contentType = xtreamContentType(row.type);
        return {
            uid: buildXtreamCollectionUid(
                row.playlist_id,
                contentType,
                row.xtream_id
            ),
            name: row.title,
            contentType,
            sourceType: 'xtream',
            playlistId: row.playlist_id,
            playlistName: row.playlist_name ?? 'Xtream',
            logo: contentType === 'live' ? (row.poster_url ?? null) : null,
            posterUrl: contentType !== 'live' ? (row.poster_url ?? null) : null,
            xtreamId: row.xtream_id,
            categoryId: row.category_id,
            tvgId: contentType === 'live' ? String(row.xtream_id) : undefined,
            rating: row.rating ?? undefined,
            addedAt: normalizeDate(row.added_at) || new Date(0).toISOString(),
            position: row.position ?? 0,
            contentId: row.id,
        };
    }

    private async getPlaylistMeta(id: string): Promise<PlaylistMeta | undefined> {
        const playlists = await firstValueFrom(
            this.store.select(selectAllPlaylistsMeta)
        );
        return (playlists as PlaylistMeta[]).find((playlist) => playlist._id === id);
    }

    private async getSavedOrder(): Promise<string[]> {
        try {
            const raw = await this.requireElectronBridge().dbGetAppState(
                GLOBAL_FAVORITES_ORDER_KEY
            );
            return raw ? (JSON.parse(raw) as string[]) : [];
        } catch {
            return [];
        }
    }

    private async saveOrder(uidOrder: string[]): Promise<void> {
        try {
            await this.requireElectronBridge().dbSetAppState(
                GLOBAL_FAVORITES_ORDER_KEY,
                JSON.stringify(uidOrder)
            );
        } catch {
            // Ordering is best effort; the database remains authoritative.
        }
    }

    private applyOrder(
        items: UnifiedCollectionItem[],
        savedOrder: string[]
    ): UnifiedCollectionItem[] {
        if (savedOrder.length === 0) {
            return items.slice().sort((a, b) => {
                const positionDelta = (a.position ?? 0) - (b.position ?? 0);
                return positionDelta !== 0
                    ? positionDelta
                    : new Date(b.addedAt ?? 0).getTime() -
                          new Date(a.addedAt ?? 0).getTime();
            });
        }
        const orderMap = new Map(savedOrder.map((uid, index) => [uid, index]));
        return items
            .map((item) => ({
                item,
                position: orderMap.get(item.uid) ?? Number.MAX_SAFE_INTEGER,
            }))
            .sort((a, b) => a.position - b.position)
            .map(({ item, position }) => ({ ...item, position }));
    }

    private buildXtreamPositionUpdates(items: UnifiedCollectionItem[]) {
        return items
            .filter((item) => item.contentId != null)
            .map((item, position) => ({
                content_id: item.contentId as number,
                playlist_id: item.playlistId,
                position,
            }));
    }

    private requireElectronBridge(): NonNullable<Window['electron']> {
        if (!window.electron) {
            throw new Error('Electron bridge is unavailable');
        }
        return window.electron;
    }
}
