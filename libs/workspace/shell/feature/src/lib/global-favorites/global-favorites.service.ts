/**
 * GlobalFavoritesService
 *
 * Aggregates live TV favorites from Xtream rows in the `favorites` DB table where content.type = 'live'
 *             and do NOT have movie_id / series_id
 *
 * Also handles reordering: persists position for Xtream rows via IPC.
 * The list order is also persisted in the app_state table as a JSON array of UIDs.
 */
import { inject, Injectable } from '@angular/core';
import { DatabaseService } from '@arm-nator/services';
import {
    buildFavoriteUid,
    UnifiedFavoriteChannel,
} from '@arm-nator/providers/shared/util';

const GLOBAL_FAVORITES_ORDER_KEY = 'global-favorites-channel-order-v1';

interface XtreamGlobalFavoriteRow {
    readonly added_at?: string | null;
    readonly id: number;
    readonly playlist_id: string;
    readonly playlist_name: string;
    readonly position?: number | null;
    readonly poster_url?: string | null;
    readonly title: string;
    readonly xtream_id: number;
}

@Injectable({ providedIn: 'root' })
export class GlobalFavoritesService {
    private readonly dbService = inject(DatabaseService);

    /**
     * Fetch and merge live TV favorites from all source types.
     * The returned list is sorted by persisted position first,
     * then by addedAt descending for items without a position.
     */
    async getUnifiedLiveFavorites(): Promise<UnifiedFavoriteChannel[]> {
        const [xtreamItems, savedOrder] = await Promise.all([
            this.getXtreamLiveFavorites(),
            this.getSavedOrder(),
        ]);

        return this.applyOrder(xtreamItems, savedOrder);
    }

    /**
     * Remove a channel from its Xtream favorites.
     */
    async removeFavorite(channel: UnifiedFavoriteChannel): Promise<void> {
        if (channel.sourceType === 'xtream' && window.electron && channel.contentId != null) {
            await window.electron.dbRemoveFavorite(
                channel.contentId,
                channel.playlistId
            );
        }
    }

    /**
     * Persist the new display order.
     * For Xtream items update the DB position column.
     * For all items, persist the UID order in app_state.
     */
    async reorder(channels: UnifiedFavoriteChannel[]): Promise<void> {
        const uidOrder = channels.map((ch) => ch.uid);

        // Persist xtream positions to DB
        const xtreamUpdates = channels
            .filter(
                (ch): ch is UnifiedFavoriteChannel & { contentId: number } =>
                    ch.sourceType === 'xtream' && ch.contentId != null
            )
            .map((ch, index) => ({
                content_id: ch.contentId,
                // The backend UPDATE is scoped by (contentId, playlistId) —
                // without the playlist id the write matches no rows.
                playlist_id: ch.playlistId,
                position: index,
            }));

        await Promise.all([
            xtreamUpdates.length > 0 && window.electron
                ? window.electron.dbReorderGlobalFavorites(xtreamUpdates)
                : Promise.resolve(),
            this.saveOrder(uidOrder),
        ]);
    }

    // ─── Private helpers ───────────────────────────────────────────

    private async getXtreamLiveFavorites(): Promise<UnifiedFavoriteChannel[]> {
        if (!window.electron) return [];

        let items: XtreamGlobalFavoriteRow[];
        try {
            items =
                (await this.dbService.getGlobalFavorites()) as XtreamGlobalFavoriteRow[];
        } catch {
            return [];
        }

        // getGlobalFavorites now only returns type='live'
        return items.map((item) => ({
            uid: buildFavoriteUid('xtream', item.playlist_id, item.xtream_id),
            name: item.title,
            logo: item.poster_url ?? null,
            sourceType: 'xtream' as const,
            playlistId: item.playlist_id,
            playlistName: item.playlist_name,
            xtreamId: item.xtream_id,
            tvgId: String(item.xtream_id),
            addedAt: item.added_at ?? new Date(0).toISOString(),
            position: item.position ?? 0,
            contentId: item.id,
        }));
    }

    private async getSavedOrder(): Promise<string[]> {
        if (!window.electron?.dbGetAppState) return [];
        try {
            const raw = await window.electron.dbGetAppState(
                GLOBAL_FAVORITES_ORDER_KEY
            );
            if (!raw) return [];
            return JSON.parse(raw) as string[];
        } catch {
            return [];
        }
    }

    private async saveOrder(uidOrder: string[]): Promise<void> {
        if (!window.electron?.dbSetAppState) return;
        try {
            await window.electron.dbSetAppState(
                GLOBAL_FAVORITES_ORDER_KEY,
                JSON.stringify(uidOrder)
            );
        } catch {
            // ignore
        }
    }

    private applyOrder(
        channels: UnifiedFavoriteChannel[],
        savedOrder: string[]
    ): UnifiedFavoriteChannel[] {
        if (!savedOrder.length) {
            // Default: sort by addedAt descending, xtream position asc
            return channels.slice().sort((a, b) => {
                if (a.position !== b.position) return a.position - b.position;
                return (
                    new Date(b.addedAt).getTime() -
                    new Date(a.addedAt).getTime()
                );
            });
        }

        const orderMap = new Map(savedOrder.map((uid, i) => [uid, i]));
        const ordered: UnifiedFavoriteChannel[] = [];
        const unordered: UnifiedFavoriteChannel[] = [];

        for (const ch of channels) {
            const position = orderMap.get(ch.uid);
            if (position != null) {
                ordered.push({ ...ch, position });
            } else {
                unordered.push(ch);
            }
        }

        ordered.sort((a, b) => a.position - b.position);
        unordered.sort(
            (a, b) =>
                new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime()
        );

        return [...ordered, ...unordered];
    }
}
