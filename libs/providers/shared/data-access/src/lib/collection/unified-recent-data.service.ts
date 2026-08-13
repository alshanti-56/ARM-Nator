import { inject, Injectable } from '@angular/core';
import { DatabaseService } from '@arm-nator/services';
import type { XtreamContent } from '@arm-nator/services';
import { normalizeDate } from '@arm-nator/shared/interfaces';
import {
    buildXtreamCollectionUid,
    CollectionScope,
    UnifiedCollectionItem,
    xtreamContentType,
} from '@arm-nator/providers/shared/util';

@Injectable({ providedIn: 'root' })
export class UnifiedRecentDataService {
    private readonly dbService = inject(DatabaseService);

    async getRecentItems(
        scope: CollectionScope,
        playlistId?: string,
        _portalType?: string
    ): Promise<UnifiedCollectionItem[]> {
        if (scope === 'playlist' && playlistId) {
            return this.getXtreamPlaylistRecent(playlistId);
        }
        return this.getXtreamGlobalRecent();
    }

    async removeRecentItem(item: UnifiedCollectionItem): Promise<void> {
        if (item.contentId == null) return;
        await this.dbService.removeRecentItem(item.contentId, item.playlistId);
    }

    async removeRecentItemsBatch(
        items: UnifiedCollectionItem[]
    ): Promise<void> {
        const batch = items
            .filter((item) => item.contentId != null)
            .map((item) => ({
                contentId: item.contentId as number,
                playlistId: item.playlistId,
            }));
        if (batch.length > 0) {
            await this.dbService.removeRecentItemsBatch(batch);
        }
    }

    async clearRecentItems(
        scope: CollectionScope,
        playlistId?: string
    ): Promise<void> {
        if (scope === 'playlist' && playlistId) {
            await this.dbService.clearPlaylistRecentItems(playlistId);
            return;
        }
        await this.dbService.clearGlobalRecentlyViewed();
    }

    async recordLivePlayback(
        item: UnifiedCollectionItem
    ): Promise<UnifiedCollectionItem> {
        const contentId =
            item.contentId ??
            (item.xtreamId != null
                ? await this.resolveXtreamContentId(item)
                : null);
        if (contentId == null) return item;
        await this.dbService.addRecentItem(contentId, item.playlistId);
        return {
            ...item,
            contentId,
            viewedAt: new Date().toISOString(),
        };
    }

    private async getXtreamGlobalRecent(): Promise<UnifiedCollectionItem[]> {
        try {
            const rows = await this.dbService.getGlobalRecentlyViewed();
            return (rows || []).map((row) => this.mapRecentRow(row));
        } catch {
            return [];
        }
    }

    private async getXtreamPlaylistRecent(
        playlistId: string
    ): Promise<UnifiedCollectionItem[]> {
        try {
            const rows = await this.dbService.getRecentItems(playlistId);
            return (rows || []).map((row) =>
                this.mapRecentRow(row, playlistId, 'Xtream')
            );
        } catch {
            return [];
        }
    }

    private mapRecentRow(
        row: XtreamContent & {
            playlist_id?: string;
            playlist_name?: string;
        },
        fallbackPlaylistId?: string,
        fallbackPlaylistName = 'Xtream'
    ): UnifiedCollectionItem {
        const contentType = xtreamContentType(row.type);
        return {
            uid: buildXtreamCollectionUid(
                row.playlist_id ?? fallbackPlaylistId ?? '',
                contentType,
                row.xtream_id
            ),
            name: row.title,
            contentType,
            sourceType: 'xtream',
            playlistId: row.playlist_id ?? fallbackPlaylistId ?? '',
            playlistName: row.playlist_name ?? fallbackPlaylistName,
            logo: contentType === 'live' ? (row.poster_url ?? null) : null,
            posterUrl: contentType !== 'live' ? (row.poster_url ?? null) : null,
            xtreamId: row.xtream_id,
            categoryId: row.category_id ?? undefined,
            tvgId: contentType === 'live' ? String(row.xtream_id) : undefined,
            tvArchive: row.tv_archive ?? null,
            tvArchiveDuration: row.tv_archive_duration ?? null,
            contentId: row.id,
            viewedAt: normalizeDate(row.viewed_at ?? ''),
        };
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
}
