import {
    CdkVirtualScrollViewport,
    ScrollingModule,
} from '@angular/cdk/scrolling';
import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    untracked,
    viewChild,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { ActivatedRoute } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { XtreamItem } from '@arm-nator/shared/interfaces';
import {
    ChannelListItemComponent,
    ChannelListSkeletonComponent,
} from '@arm-nator/ui/components';
import {
    PortalChannelSortMode,
    sortPortalChannelItems,
} from '@arm-nator/providers/shared/util';
import {
    FavoritesService,
    XtreamStore,
} from '@arm-nator/providers/xtream/data-access';

export interface XtreamChannelListItem {
    readonly category_id?: string | number;
    readonly id?: string | number;
    readonly name?: string;
    readonly poster_url?: string;
    readonly stream_icon?: string;
    readonly title?: string;
    readonly type?: 'live' | 'movie' | 'series' | 'vod';
    readonly xtream_id: number;
}

@Component({
    selector: 'app-portal-channels-list',
    templateUrl: './portal-channels-list.component.html',
    styleUrls: ['./portal-channels-list.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        ChannelListItemComponent,
        ChannelListSkeletonComponent,
        MatIcon,
        ScrollingModule,
        TranslatePipe,
    ],
})
export class PortalChannelsListComponent {
    readonly playClicked = output<XtreamChannelListItem>();
    readonly playbackRequested = output<XtreamChannelListItem>();
    readonly sortMode = input<PortalChannelSortMode>('server');
    readonly channelsOverride = input<XtreamChannelListItem[] | null>(null);
    readonly searchTermInput = input('');

    readonly xtreamStore = inject(XtreamStore);
    private readonly favoritesService = inject(FavoritesService);
    private readonly route = inject(ActivatedRoute);
    private readonly cdr = inject(ChangeDetectorRef);
    readonly viewport = viewChild(CdkVirtualScrollViewport);
    readonly isSelectedTypeContentLoading =
        this.xtreamStore.selectedTypeContentLoading;
    readonly channels = computed(() => {
        const override = this.channelsOverride();
        return Array.isArray(override)
            ? override
            : (this.xtreamStore.selectItemsFromSelectedCategory() as XtreamChannelListItem[]);
    });
    readonly sortedChannels = computed(() =>
        sortPortalChannelItems(
            this.channels(),
            this.sortMode(),
            (item) => item.title ?? item.name
        )
    );
    readonly filteredChannels = computed(() => {
        const term = this.searchTermInput().trim().toLowerCase();
        return term
            ? this.sortedChannels().filter((item) =>
                  `${item.title ?? ''} ${item.name ?? ''}`
                      .toLowerCase()
                      .includes(term)
              )
            : this.sortedChannels();
    });

    favorites = new Map<string, boolean>();

    constructor() {
        effect(() => {
            const selectedId = Number(
                (this.xtreamStore.selectedItem() as XtreamChannelListItem | null)
                    ?.xtream_id
            );
            const viewport = this.viewport();
            if (!viewport || !Number.isFinite(selectedId) || selectedId <= 0) {
                return;
            }
            const index = untracked(() => this.filteredChannels()).findIndex(
                (item) => Number(item.xtream_id) === selectedId
            );
            if (index >= 0) viewport.scrollToIndex(index, 'smooth');
        });

        const { categoryId } = this.route.snapshot.params;
        if (categoryId && !this.channelsOverride()) {
            this.xtreamStore.setSelectedCategory(Number(categoryId));
        }
        const playlist = this.xtreamStore.currentPlaylist();
        if (playlist) {
            this.favoritesService
                .getFavorites(playlist.id)
                .subscribe((favorites) => {
                    favorites.forEach((favorite) =>
                        this.favorites.set(
                            this.getFavoriteKey(
                                favorite.xtream_id,
                                favorite.type
                            ),
                            true
                        )
                    );
                    this.cdr.detectChanges();
                });
        }
    }

    trackBy(_index: number, item: XtreamChannelListItem | XtreamItem): number {
        return Number(item.xtream_id);
    }

    toggleFavorite(event: Event, item: XtreamChannelListItem): void {
        event.stopPropagation();
        const playlistId = this.xtreamStore.currentPlaylist()?.id;
        if (!playlistId) return;

        const key = this.favoriteKeyFor(item);
        void this.xtreamStore
            .toggleFavorite(
                item.xtream_id,
                playlistId,
                this.normalizeContentType(
                    item.type ?? this.xtreamStore.selectedContentType()
                )
            )
            .then((enabled) => {
                if (enabled) this.favorites.set(key, true);
                else this.favorites.delete(key);
                this.cdr.detectChanges();
            });
    }

    favoriteKeyFor(item: XtreamChannelListItem): string {
        return this.getFavoriteKey(
            item.xtream_id,
            item.type ?? this.xtreamStore.selectedContentType()
        );
    }

    private getFavoriteKey(
        id: number,
        type?: 'live' | 'movie' | 'series' | 'vod'
    ): string {
        return `${this.normalizeContentType(type)}:${id}`;
    }

    private normalizeContentType(
        type?: 'live' | 'movie' | 'series' | 'vod'
    ): 'live' | 'movie' | 'series' {
        if (type === 'movie' || type === 'vod') return 'movie';
        if (type === 'series') return 'series';
        return 'live';
    }
}
