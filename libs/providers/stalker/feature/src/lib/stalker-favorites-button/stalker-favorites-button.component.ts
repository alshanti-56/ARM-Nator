import { AsyncPipe } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { BehaviorSubject, map, of, switchMap } from 'rxjs';
import { PlaylistsService } from '@arm-nator/services';
import { StalkerPortalItem } from '@arm-nator/shared/interfaces';
import { StalkerStore } from '@arm-nator/providers/stalker/data-access';
import {
    matchesFavoriteById,
    normalizeStalkerSeriesFlag,
    StalkerSelectedVodItem,
} from '@arm-nator/providers/stalker/data-access';

type FavoriteButtonItem = StalkerSelectedVodItem & {
    name?: string;
    o_name?: string;
    cover?: string;
};

@Component({
    selector: 'app-favorites-button',
    templateUrl: './stalker-favorites-button.component.html',
    styleUrls: ['./stalker-favorites-button.component.scss'],
    imports: [AsyncPipe, MatIconModule, TranslateModule],
})
export class FavoritesButtonComponent {
    private playlistService = inject(PlaylistsService);
    private stalkerStore = inject(StalkerStore);
    private snackBar = inject(MatSnackBar);
    private translate = inject(TranslateService);

    readonly itemId = input.required<string>();
    readonly item = input.required<FavoriteButtonItem>();

    private readonly favoritesChanged$ = new BehaviorSubject<void>(undefined);

    readonly isFavorite$ = this.favoritesChanged$.pipe(
        switchMap(() => {
            const playlistId = this.stalkerStore.currentPlaylist()?._id;
            return playlistId
                ? this.playlistService.getPortalFavorites(playlistId)
                : of([]);
        }),
        map((favorites) =>
            favorites.some((favorite) =>
                matchesFavoriteById(favorite, this.itemId())
            )
        )
    );

    removeFromFavorites() {
        const portalId = this.stalkerStore.currentPlaylist()?._id;
        if (!portalId) return;

        this.playlistService
            .removeFromPortalFavorites(portalId, this.itemId())
            .subscribe(() => {
                this.snackBar.open(
                    this.translate.instant('PORTALS.REMOVED_FROM_FAVORITES'),
                    undefined,
                    { duration: 1000 }
                );
                this.favoritesChanged$.next();
            });
    }

    addToFavorites() {
        const item = this.item();
        const favoriteBase = {
            ...item,
            title: item.info?.name ?? item.name ?? item.o_name,
            cover: item.info?.movie_image ?? item.cover,
            added_at: new Date().toISOString(),
        };

        if (this.stalkerStore.selectedContentType() === 'vod') {
            this.persistFavorite({
                ...favoriteBase,
                id: item.id,
                category_id: item.category_id ?? 'vod',
                series: item.series,
                is_series: normalizeStalkerSeriesFlag(item.is_series),
            });
            return;
        }

        this.persistFavorite({
            ...favoriteBase,
            series_id: item.id,
            category_id: 'series',
        });
    }

    private persistFavorite(favorite: Record<string, unknown>): void {
        const portalId = this.stalkerStore.currentPlaylist()?._id;
        if (!portalId) return;

        this.playlistService
            .addPortalFavorite(portalId, favorite as StalkerPortalItem)
            .subscribe(() => {
                this.snackBar.open(
                    this.translate.instant('PORTALS.ADDED_TO_FAVORITES'),
                    undefined,
                    { duration: 1000 }
                );
                this.favoritesChanged$.next();
            });
    }

    forceRefresh() {
        // Exposed for callers that need manual refresh after external updates.
        if (this.stalkerStore.currentPlaylist()?._id) {
            this.favoritesChanged$.next();
        }
    }
}
