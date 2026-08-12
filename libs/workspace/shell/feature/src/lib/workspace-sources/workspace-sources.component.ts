import { Component, computed, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Store } from '@ngrx/store';
import { RecentPlaylistsComponent } from '@arm-nator/providers/shared/playlist-ui';
import { XtreamMetadataIndexService } from '@arm-nator/providers/xtream/data-access';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { selectActiveTypeFilters, selectAllPlaylistsMeta } from '@arm-nator/providers/m3u/state';
import { map, startWith } from 'rxjs';
import { SortBy, SortOrder, SortService } from '@arm-nator/services';
import {
    getPlaylistSourceType,
    PlaylistMeta,
} from '@arm-nator/shared/interfaces';
import {
    WORKSPACE_SHELL_ACTIONS,
    WorkspacePlaylistType,
} from '@arm-nator/workspace/shell/util';

interface SortOption {
    by: SortBy;
    order: SortOrder;
    icon: string;
    translationKey: string;
}

@Component({
    selector: 'app-workspace-sources',
    imports: [
        MatButtonModule,
        MatIconModule,
        MatMenuModule,
        RecentPlaylistsComponent,
        RouterLink,
        TranslatePipe,
    ],
    templateUrl: './workspace-sources.component.html',
    styleUrl: './workspace-sources.component.scss',
})
export class WorkspaceSourcesComponent {
    private readonly route = inject(ActivatedRoute);
    private readonly store = inject(Store);
    private readonly workspaceActions = inject(WORKSPACE_SHELL_ACTIONS);
    private readonly translate = inject(TranslateService);
    private readonly sortService = inject(SortService);
    private readonly metadataIndexService = inject(
        XtreamMetadataIndexService
    );

    private readonly activeTypeFilters = this.store.selectSignal(
        selectActiveTypeFilters
    );
    private readonly playlists = this.store.selectSignal(
        selectAllPlaylistsMeta
    );
    private readonly languageTick = toSignal(
        this.translate.onLangChange.pipe(startWith(null)),
        { initialValue: null }
    );

    readonly metadataIndexStatusFor = (playlistId: string) =>
        this.metadataIndexService.getStatus(playlistId);

    readonly sortOptions: SortOption[] = [
        {
            by: SortBy.DATE_ADDED,
            order: SortOrder.DESC,
            icon: 'schedule',
            translationKey: 'HOME.SORT_OPTIONS.NEWEST',
        },
        {
            by: SortBy.DATE_ADDED,
            order: SortOrder.ASC,
            icon: 'history',
            translationKey: 'HOME.SORT_OPTIONS.OLDEST',
        },
        {
            by: SortBy.NAME,
            order: SortOrder.ASC,
            icon: 'sort_by_alpha',
            translationKey: 'HOME.SORT_OPTIONS.NAME_ASC',
        },
        {
            by: SortBy.NAME,
            order: SortOrder.DESC,
            icon: 'sort_by_alpha',
            translationKey: 'HOME.SORT_OPTIONS.NAME_DESC',
        },
        {
            by: SortBy.CUSTOM,
            order: SortOrder.ASC,
            icon: 'drag_indicator',
            translationKey: 'HOME.SORT_OPTIONS.CUSTOM_ORDER',
        },
    ];

    private readonly currentSortOptions = toSignal(
        this.sortService.getSortOptions(),
        { requireSync: true }
    );

    readonly searchQuery = toSignal(
        this.route.queryParamMap.pipe(map((params) => params.get('q') ?? '')),
        { initialValue: '' }
    );
    readonly title = computed(() => {
        this.languageTick();

        const filters = this.activeTypeFilters();

        if (filters.length === 1) {
            if (filters[0] === 'm3u') {
                return this.translateText('WORKSPACE.SOURCES.M3U_PLAYLISTS');
            }
            if (filters[0] === 'xtream') {
                return this.translateText('WORKSPACE.SOURCES.XTREAM_PLAYLISTS');
            }
            if (filters[0] === 'stalker') {
                return this.translateText('HOME.PLAYLIST_TYPES.STALKER');
            }
        }

        return this.translateText('WORKSPACE.SOURCES.ALL_PLAYLISTS');
    });

    readonly visibleSourcesCount = computed(() => {
        const query = this.searchQuery().trim().toLowerCase();
        const filters = this.activeTypeFilters();
        const allPlaylists = this.playlists();

        return allPlaylists
            .filter((item) => filters.includes(getPlaylistSourceType(item)))
            .filter((item) => (item.title || '').toLowerCase().includes(query))
            .length;
    });

    readonly subtitle = computed(() => {
        this.languageTick();

        const count = this.visibleSourcesCount();
        if (count === 1) {
            return this.translateText('WORKSPACE.SOURCES.PLAYLIST_COUNT_ONE');
        }

        return this.translateText('WORKSPACE.SOURCES.PLAYLIST_COUNT_OTHER', {
            count,
        });
    });

    readonly activeSortLabel = computed(() => {
        this.languageTick();
        const current = this.currentSortOptions();
        const match = this.sortOptions.find(
            (option) =>
                option.by === current.by && option.order === current.order
        );
        return this.translateText(
            match?.translationKey ?? 'HOME.SORT_OPTIONS.NEWEST'
        );
    });

    constructor() {
        effect(() => {
            const xtreamPlaylistIds = this.playlists()
                .filter((item) => Boolean(item.serverUrl))
                .map((item) => item._id);
            if (xtreamPlaylistIds.length > 0) {
                void this.metadataIndexService.refreshStatuses(
                    xtreamPlaylistIds
                );
            }
        });
    }

    onAddPlaylist(type?: WorkspacePlaylistType): void {
        this.workspaceActions.openAddPlaylistDialog(type);
    }

    startMetadataIndexing(playlist: PlaylistMeta): void {
        void this.metadataIndexService.start(playlist);
    }

    stopMetadataIndexing(playlist: PlaylistMeta): void {
        this.metadataIndexService.stop(playlist._id);
    }

    isSortActive(option: SortOption): boolean {
        const current = this.currentSortOptions();
        return current.by === option.by && current.order === option.order;
    }

    setSortOption(option: SortOption): void {
        this.sortService.setSortOptions({
            by: option.by,
            order: option.order,
        });
    }

    private translateText(
        key: string,
        params?: Record<string, string | number>
    ): string {
        return this.translate.instant(key, params);
    }
}
