import {
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  viewChild,
  ElementRef,
  ChangeDetectionStrategy
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatIconButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltip } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
    PortalCategorySortMode,
    persistPortalCategorySortMode,
    restorePortalCategorySortMode,
    sortPortalCategoryItems,
} from '@arm-nator/providers/shared/util';
import { XtreamStore } from '@arm-nator/providers/xtream/data-access';
import { StalkerStore, StalkerContentType, updateStalkerCategoryVisibility, buildStalkerCategoryCounts } from '@arm-nator/providers/stalker/data-access';
import { PlaylistsService } from '@arm-nator/services';
import { firstValueFrom } from 'rxjs';
import { WorkspaceContextCategoryViewComponent } from './components/workspace-context-category-view.component';
import { hasActiveLiveCategoryRoute } from './workspace-context-panel-route.utils';

type WorkspaceProvider = 'xtreams' | 'playlists' | 'stalker';

interface WorkspaceContextRoute {
    provider: WorkspaceProvider;
    playlistId: string;
}

interface XtreamCategoryLike {
    id?: number | string;
    category_id?: number | string;
}

interface WorkspaceCategoryLike {
    readonly category_id?: string | number;
    readonly category_name?: string;
    readonly id?: string | number;
    readonly name?: string;
}

@Component({
    selector: 'app-workspace-context-panel',
    imports: [
        MatIconButton,
        MatIcon,
        MatMenuModule,
        MatTooltip,
        TranslatePipe,
        WorkspaceContextCategoryViewComponent,
    ],
    templateUrl: './workspace-context-panel.component.html',
    changeDetection: ChangeDetectionStrategy.Eager,
    styleUrl: './workspace-context-panel.component.scss',
})
export class WorkspaceContextPanelComponent {
    private readonly activatedRoute = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly xtreamStore = inject(XtreamStore);
    private readonly stalkerStore = inject(StalkerStore);
    private readonly dialog = inject(MatDialog);
    private readonly playlistsService = inject(PlaylistsService);
    private readonly destroyRef = inject(DestroyRef);
    private readonly translate = inject(TranslateService);

    readonly context = input.required<WorkspaceContextRoute>();
    readonly section = input.required<string>();

    readonly isXtreamCategories = computed(
        () =>
            this.context().provider === 'xtreams' &&
            (this.section() === 'vod' ||
                this.section() === 'series' ||
                this.section() === 'live')
    );
    readonly isStalkerCategories = computed(
        () =>
            this.context().provider === 'stalker' &&
            (this.section() === 'itv' ||
                this.section() === 'vod' ||
                this.section() === 'series')
    );
    readonly xtreamCategories = this.xtreamStore.getCategoriesBySelectedType;
    readonly xtreamCategoryItemCounts = this.xtreamStore.getCategoryItemCounts;
    readonly xtreamSelectedCategoryId = this.xtreamStore.selectedCategoryId;
    readonly xtreamSelectedTypeContentState =
        this.xtreamStore.selectedTypeContentState;
    readonly xtreamSelectedTypeContentReady =
        this.xtreamStore.selectedTypeContentReady;
    readonly xtreamSelectedTypeCountsReady =
        this.xtreamStore.selectedTypeCountsReady;
    readonly isXtreamImporting = this.xtreamStore.isImporting;
    readonly xtreamImportPhase = this.xtreamStore.currentImportPhase;
    readonly isXtreamCategoryLoading = computed(
        () =>
            this.isXtreamCategories() &&
            this.xtreamStore.isLoadingCategories() &&
            this.xtreamCategories().length === 0
    );
    readonly isXtreamCategoryInteractionEnabled = computed(
        () =>
            !this.isXtreamCategoryLoading() &&
            this.xtreamSelectedTypeContentReady()
    );
    readonly stalkerCategories = computed<WorkspaceCategoryLike[]>(() => {
        if (!this.isStalkerCategories()) {
            return [];
        }

        const label =
            this.section() === 'vod'
                ? 'All movies'
                : this.section() === 'series'
                  ? 'All series'
                  : 'All channels';

        const hidden = new Set(this.stalkerStore.currentPlaylist()?.hiddenStalkerCategoryIds?.[this.section() as StalkerContentType] ?? []);
        return [
            { category_id: '*', category_name: label },
            ...this.stalkerStore
                .getCategoryResource()
                .filter((category) => String(category.category_id) !== '*' && !hidden.has(String(category.category_id))),
        ];
    });
    readonly stalkerCategoryCounts = computed(() => buildStalkerCategoryCounts({
        type: this.stalkerStore.selectedContentType(),
        selectedCategory: this.stalkerStore.selectedCategoryId() ?? '*',
        totalItems: this.stalkerStore.totalContentItems(),
        categories: this.stalkerStore.getCategoryResource(),
        items: this.stalkerStore.getPaginatedContent(),
    }));
    readonly stalkerCategoryItemCounts = computed(() => this.stalkerCategoryCounts().counts);
    readonly stalkerPartialCategoryIds = computed(() => this.stalkerCategoryCounts().partialIds);
    readonly stalkerSelectedCategoryId = computed(
        () => this.stalkerStore.selectedCategoryId() ?? '*'
    );
    readonly stalkerLoadError = this.stalkerStore.loadError;
    readonly isStalkerCategoryLoading = computed(
        () =>
            this.isStalkerCategories() &&
            this.stalkerStore.isPaginatedContentLoading() &&
            this.stalkerCategories().length <= 1
    );
    readonly isStalkerCategoryInteractionEnabled = computed(
        () =>
            !this.isStalkerCategoryLoading() &&
            Boolean(this.stalkerStore.currentPlaylist())
    );
    readonly xtreamCountDisplayMode = computed<'loading' | 'ready'>(() =>
        this.isXtreamCategoryInteractionEnabled() ? 'ready' : 'loading'
    );
    readonly canManageXtreamCategories = computed(
        () => this.isXtreamCategories() && this.xtreamSelectedTypeCountsReady()
    );
    readonly canManageCategories = computed(() =>
        this.isXtreamCategories() ? this.canManageXtreamCategories() :
        this.isStalkerCategories() && this.isStalkerCategoryInteractionEnabled() &&
        !this.stalkerStore.isPaginatedContentLoading() &&
        this.stalkerStore.getCategoryResource().some((c) => String(c.category_id) !== '*')
    );
    readonly xtreamStatusText = computed(() => {
        if (
            !this.isXtreamCategories() ||
            this.isXtreamCategoryLoading() ||
            !this.isXtreamImporting() ||
            this.xtreamSelectedTypeContentState() !== 'loading'
        ) {
            return '';
        }

        const syncLabel = this.translate.instant(
            this.getXtreamSyncLabelKey(this.section())
        );
        const phaseKey = this.getXtreamImportPhaseLabelKey(
            this.xtreamImportPhase()
        );
        const phaseLabel = phaseKey ? this.translate.instant(phaseKey) : '';

        return phaseLabel ? `${syncLabel} ${phaseLabel}` : syncLabel;
    });

    readonly skeletonRows = Array.from({ length: 14 }, (_, index) => index);
    readonly skeletonLabelWidths = [
        78, 66, 74, 59, 83, 69, 76, 62, 81, 64, 72, 67, 79, 61,
    ];

    readonly searchInput =
        viewChild<ElementRef<HTMLInputElement>>('searchInput');
    readonly isSearchOpen = signal(false);
    readonly categorySearchTerm = signal('');
    readonly categorySortMode = signal<PortalCategorySortMode>(
        restorePortalCategorySortMode()
    );
    readonly categorySortLabelKey = computed(() =>
        this.getCategorySortLabelKey(this.categorySortMode())
    );
    readonly categorySortOptions: ReadonlyArray<{
        mode: PortalCategorySortMode;
        translationKey: string;
        icon: string;
    }> = [
        {
            mode: 'server',
            translationKey: 'WORKSPACE.SORT_SERVER',
            icon: 'dns',
        },
        {
            mode: 'name-asc',
            translationKey: 'WORKSPACE.SORT_NAME_ASC',
            icon: 'sort_by_alpha',
        },
        {
            mode: 'name-desc',
            translationKey: 'WORKSPACE.SORT_NAME_DESC',
            icon: 'arrow_downward',
        },
    ];
    readonly categorySortIcon = computed(
        () =>
            this.categorySortOptions.find(
                (option) => option.mode === this.categorySortMode()
            )?.icon ?? 'dns'
    );

    readonly canSearchCategories = computed(
        () =>
            (this.isXtreamCategories() && this.xtreamCategories().length > 0) ||
            (this.isStalkerCategories() && this.stalkerCategories().length > 1)
    );

    readonly filteredXtreamCategories = computed(() => {
        const cats = this.xtreamCategories();
        const term = this.categorySearchTerm().trim().toLowerCase();
        const filtered = term
            ? cats.filter((category) =>
                  this.getCategoryLabel(category).toLowerCase().includes(term)
              )
            : cats;

        return sortPortalCategoryItems(
            filtered,
            this.categorySortMode(),
            (category) => this.getCategoryLabel(category),
            (category) => this.isAllCategory(category)
        );
    });

    readonly filteredStalkerCategories = computed(() => {
        const term = this.categorySearchTerm().trim().toLowerCase();
        const filtered = term
            ? this.stalkerCategories().filter((category) =>
                  this.getCategoryLabel(category).toLowerCase().includes(term)
              )
            : this.stalkerCategories();

        return sortPortalCategoryItems(
            filtered,
            this.categorySortMode(),
            (category) => this.getCategoryLabel(category),
            (category) => this.isAllCategory(category)
        );
    });

    readonly title = computed(() => {
        if (this.isXtreamCategories()) {
            if (this.section() === 'vod') {
                return 'WORKSPACE.CONTEXT.MOVIE_CATEGORIES';
            }
            if (this.section() === 'series') {
                return 'WORKSPACE.CONTEXT.SERIES_CATEGORIES';
            }
            return 'WORKSPACE.CONTEXT.LIVE_CATEGORIES';
        }

        if (this.isStalkerCategories()) {
            if (this.section() === 'vod') {
                return 'WORKSPACE.CONTEXT.MOVIE_CATEGORIES';
            }
            if (this.section() === 'series') {
                return 'WORKSPACE.CONTEXT.SERIES_CATEGORIES';
            }
            return 'WORKSPACE.CONTEXT.LIVE_CATEGORIES';
        }

        return 'WORKSPACE.CONTEXT.CATEGORIES';
    });

    readonly subtitle = computed(() => {
        if (this.isXtreamCategories()) {
            return 'WORKSPACE.CONTEXT.XTREAM_SOURCE';
        }
        if (this.isStalkerCategories()) {
            return 'Stalker portal';
        }
        return '';
    });

    constructor() {
        effect(() => {
            if (this.isSearchOpen()) {
                queueMicrotask(() => {
                    this.searchInput()?.nativeElement.focus();
                });
            }
        });
    }

    toggleCategorySearch(): void {
        const opening = !this.isSearchOpen();
        this.isSearchOpen.set(opening);
        if (!opening) {
            this.categorySearchTerm.set('');
        }
    }

    onSearchInput(event: Event): void {
        const value = (event.target as HTMLInputElement).value;
        this.categorySearchTerm.set(value);
    }

    clearCategorySearch(): void {
        this.categorySearchTerm.set('');
        this.searchInput()?.nativeElement.focus();
    }

    setCategorySortMode(mode: PortalCategorySortMode): void {
        this.categorySortMode.set(mode);
        persistPortalCategorySortMode(mode);
    }

    openManageCategories(): void {
        if (this.isStalkerCategories()) {
            void this.openManageStalkerCategories();
            return;
        }
        if (!this.canManageXtreamCategories()) {
            return;
        }

        const context = this.context();
        const section = this.section();
        const contentType =
            section === 'series'
                ? 'series'
                : section === 'live'
                  ? 'live'
                  : 'vod';

        void import('@arm-nator/providers/xtream/feature').then(
            ({ CategoryManagementDialogComponent }) => {
                const dialogRef = this.dialog.open(
                    CategoryManagementDialogComponent,
                    {
                        data: {
                            playlistId: context.playlistId,
                            contentType,
                            itemCounts:
                                this.xtreamStore.getCategoryItemCounts(),
                        },
                        width: '500px',
                        maxWidth: 'calc(100vw - 32px)',
                        maxHeight: '90vh',
                    }
                );

                dialogRef
                    .afterClosed()
                    .pipe(takeUntilDestroyed(this.destroyRef))
                    .subscribe((result) => {
                        if (result) {
                            this.xtreamStore.reloadCategories();
                        }
                    });
            }
        );
    }

    private async openManageStalkerCategories(): Promise<void> {
        if (!this.canManageCategories()) return;
        const playlistId = this.context().playlistId;
        const section = this.section() as StalkerContentType;
        const hidden = new Set(this.stalkerStore.currentPlaylist()?.hiddenStalkerCategoryIds?.[section] ?? []);
        const categories = this.stalkerStore.getCategoryResource()
            .filter((c) => String(c.category_id) !== '*')
            .map((c) => ({
                id: String(c.category_id),
                name: c.category_name,
                count: this.stalkerCategoryItemCounts().get(String(c.category_id)),
                countIsPartial: this.stalkerPartialCategoryIds().has(String(c.category_id)),
                hidden: hidden.has(String(c.category_id)),
            }));
        const { CategoryVisibilityDialogComponent } = await import('@arm-nator/ui/components');
        this.dialog.open(CategoryVisibilityDialogComponent, {
            width: '500px', maxWidth: 'calc(100vw - 32px)', maxHeight: '90vh',
            data: {
                categories,
                save: async (hiddenIds: string[]) => {
                    const saved = await firstValueFrom(this.playlistsService.transformPlaylistMeta(playlistId, (current) => ({
                        ...current,
                        hiddenStalkerCategoryIds: updateStalkerCategoryVisibility(current.hiddenStalkerCategoryIds, section, categories.map((c) => c.id), hiddenIds),
                    })));
                    if (!saved) throw new Error('The source is no longer available.');
                    // Apply only this preference to the current source; keep its current session state.
                    this.stalkerStore.currentPlaylist.update((current) => current?._id === playlistId
                        ? { ...current, hiddenStalkerCategoryIds: saved.hiddenStalkerCategoryIds } : current);
                    if (this.context().playlistId === playlistId && this.section() === section && hiddenIds.includes(this.stalkerSelectedCategoryId())) {
                        this.onStalkerCategoryClicked({ category_id: '*' });
                    }
                },
            },
        });
    }

    onXtreamCategoryClicked(category: XtreamCategoryLike): void {
        if (!this.isXtreamCategoryInteractionEnabled()) {
            return;
        }

        const context = this.context();
        const section = this.section();
        const rawCategoryId = category.category_id ?? category.id;
        if (rawCategoryId === undefined || rawCategoryId === null) {
            return;
        }
        const numericCategoryId = Number(rawCategoryId);
        if (Number.isNaN(numericCategoryId)) {
            return;
        }
        const categoryId = numericCategoryId;

        if (section === 'live') {
            this.xtreamStore.setSelectedCategory(categoryId);
            const liveRouteHasCategory = hasActiveLiveCategoryRoute(
                this.router.routerState.snapshot.root
            );
            if (liveRouteHasCategory) {
                void this.router.navigate(
                    [
                        '/workspace',
                        'xtreams',
                        context.playlistId,
                        'live',
                        categoryId,
                    ],
                    {
                        queryParams: {
                            page: null,
                        },
                        queryParamsHandling: 'merge',
                        replaceUrl: true,
                    }
                );
            } else {
                void this.router.navigate([], {
                    relativeTo: this.activatedRoute,
                    queryParams: {
                        page: null,
                    },
                    queryParamsHandling: 'merge',
                    replaceUrl: true,
                });
            }
            return;
        }

        this.xtreamStore.setSelectedItem(null);
        this.xtreamStore.setSelectedCategory(categoryId);
        this.router.navigate([
            '/workspace',
            'xtreams',
            context.playlistId,
            section,
            categoryId,
        ]);
    }

    onStalkerCategoryClicked(category: WorkspaceCategoryLike): void {
        if (!this.isStalkerCategoryInteractionEnabled()) {
            return;
        }

        const context = this.context();
        const section = this.section();
        const rawCategoryId = category.category_id ?? category.id;
        if (rawCategoryId === undefined || rawCategoryId === null) {
            return;
        }

        const categoryId = String(rawCategoryId);
        if (categoryId === '*') {
            this.stalkerStore.setSelectedCategory(null);
            void this.router.navigate([
                '/workspace',
                'stalker',
                context.playlistId,
                section,
            ]);
            return;
        }

        this.stalkerStore.setSelectedCategory(categoryId);
        void this.router.navigate([
            '/workspace',
            'stalker',
            context.playlistId,
            section,
            categoryId,
        ]);
    }

    private getXtreamSyncLabelKey(section: string): string {
        switch (section) {
            case 'live':
                return 'WORKSPACE.CONTEXT.XTREAM_SYNCING_LIVE';
            case 'series':
                return 'WORKSPACE.CONTEXT.XTREAM_SYNCING_SERIES';
            case 'vod':
            default:
                return 'WORKSPACE.CONTEXT.XTREAM_SYNCING_MOVIES';
        }
    }

    private getXtreamImportPhaseLabelKey(phase: string | null): string {
        switch (phase) {
            case 'preparing-content':
                return 'WORKSPACE.SHELL.XTREAM_IMPORT_PREPARING';
            case 'loading-categories':
            case 'loading-live':
            case 'loading-movies':
            case 'loading-series':
                return 'WORKSPACE.SHELL.XTREAM_IMPORT_LOADING';
            case 'saving-categories':
            case 'saving-content':
                return 'WORKSPACE.SHELL.XTREAM_IMPORT_SAVING';
            case 'restoring-favorites':
                return 'WORKSPACE.SHELL.XTREAM_IMPORT_RESTORING_FAVORITES';
            case 'restoring-recently-viewed':
                return 'WORKSPACE.SHELL.XTREAM_IMPORT_RESTORING_RECENT';
            default:
                return '';
        }
    }

    private getCategorySortLabelKey(mode: PortalCategorySortMode): string {
        switch (mode) {
            case 'name-asc':
                return 'WORKSPACE.SORT_NAME_ASC';
            case 'name-desc':
                return 'WORKSPACE.SORT_NAME_DESC';
            case 'server':
            default:
                return 'WORKSPACE.SORT_SERVER';
        }
    }

    private getCategoryLabel(category: WorkspaceCategoryLike): string {
        return category.category_name ?? category.name ?? '';
    }

    private isAllCategory(category: WorkspaceCategoryLike): boolean {
        return String(category.category_id ?? category.id) === '*';
    }
}
