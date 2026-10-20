import { UiPerformanceService } from '@arm-nator/services';
import { NgComponentOutlet } from '@angular/common';
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    DestroyRef,
    ElementRef,
    inject,
    OnInit,
    signal,
    afterRenderEffect,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import { MatButtonModule } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatTooltip } from '@angular/material/tooltip';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import {
    GridListComponent,
    PlaylistErrorViewComponent,
} from '@arm-nator/providers/shared/ui';
import {
    PortalCatalogFacade,
    PORTAL_CATALOG_DETAIL_COMPONENT,
    PORTAL_CATALOG_FACADE,
    PortalCatalogSortMode,
    CatalogueNavigationStateService,
    type CatalogueRefinements,
    readCatalogueRefinements,
} from '@arm-nator/providers/shared/util';

interface CategoryContentItem {
    id?: number | string;
    is_series?: number | string | boolean;
    xtream_id?: number | string;
    series_id?: number | string;
    stream_id?: number | string;
    category_id?: number | string;
    [key: string]: unknown;
}

@Component({
    selector: 'app-category-content-view',
    templateUrl: './category-content-view.component.html',
    styleUrls: ['./category-content-view.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        GridListComponent,
        MatButtonModule,
        MatIcon,
        MatMenuModule,
        MatPaginatorModule,
        MatTooltip,
        NgComponentOutlet,
        PlaylistErrorViewComponent,
        TranslatePipe,
    ],
})
export class CategoryContentViewComponent implements OnInit {
    private readonly activatedRoute = inject(ActivatedRoute);
    private readonly destroyRef = inject(DestroyRef);
    private readonly hostElement = inject(ElementRef<HTMLElement>);
    private readonly router = inject(Router);
    private readonly translate = inject(TranslateService);
    private readonly navigationState = inject(CatalogueNavigationStateService);
    private readonly listUrl = signal('');
    private restoredListUrl: string | null = null;
    private hasAppliedInitialQueryParams = false;
    private readonly catalog = inject(
        PORTAL_CATALOG_FACADE
    ) as PortalCatalogFacade<
        CategoryContentItem,
        CategoryContentItem,
        CategoryContentItem
    >;

    readonly detailComponent = inject(PORTAL_CATALOG_DETAIL_COMPONENT);
    readonly contentType = this.catalog.contentType;
    readonly limit = this.catalog.limit;
    readonly pageIndex = this.catalog.pageIndex;
    readonly pageSizeOptions = Array.from(this.catalog.pageSizeOptions);
    readonly selectedCategory = this.catalog.selectedCategory;
    readonly paginatedContent = this.catalog.paginatedContent;
    readonly selectedCategoryTitle = this.catalog.selectedCategoryTitle;
    readonly categoryItemCount = this.catalog.categoryItemCount;
    readonly selectedItem = this.catalog.selectedItem;
    readonly totalPages = this.catalog.totalPages;
    readonly contentSortMode = this.catalog.contentSortMode;
    readonly isPaginatedContentLoading = this.catalog.isPaginatedContentLoading;
    readonly isXtreamLoadingSubtitle = computed(
        () =>
            this.catalog.provider === 'xtream' &&
            this.isPaginatedContentLoading()
    );
    readonly categoryItemSubtitle = computed(() => {
        if (this.isXtreamLoadingSubtitle()) {
            return this.translate.instant(
                'WORKSPACE.SHELL.XTREAM_IMPORT_LOADING'
            );
        }

        const itemCount = this.categoryItemCount();
        return `${itemCount} ${itemCount === 1 ? 'item' : 'items'}`;
    });
    readonly canSortContent = computed(() => this.contentSortMode() !== null);
    readonly supportsRatingSort = computed(
        () => this.catalog.supportsRatingSort === true
    );
    readonly canFilterByRating = computed(
        () =>
            this.supportsRatingSort() &&
            typeof this.catalog.setMinRating === 'function'
    );
    readonly availableGenres = computed(() => this.catalog.availableGenres?.() ?? []);
    readonly availableYears = computed(() => this.catalog.availableYears?.() ?? []);
    readonly canFilterByGenre = computed(
        () => this.availableGenres().length > 0 && typeof this.catalog.setGenreFilter === 'function'
    );
    readonly canFilterByYear = computed(
        () =>
            this.supportsRatingSort() &&
            typeof this.catalog.setYearFilter === 'function'
    );
    readonly genreFilter = computed(() =>
        this.canFilterByGenre() ? (this.catalog.genreFilter?.() ?? null) : null
    );
    readonly yearFilter = computed(() =>
        this.canFilterByYear() ? (this.catalog.yearFilter?.() ?? null) : null
    );
    readonly yearInput = signal('');
    readonly sortSectionExpanded = signal(true);
    readonly ratingSectionExpanded = signal(false);
    readonly genreSectionExpanded = signal(false);
    readonly yearSectionExpanded = signal(false);
    readonly minRating = computed(() =>
        this.canFilterByRating() ? (this.catalog.minRating?.() ?? null) : null
    );
    readonly ratingThresholds = [9, 8, 7, 6, 5] as const;
    readonly hasRefineControls = computed(
        () =>
            this.canSortContent() ||
            this.canFilterByRating() ||
            this.canFilterByGenre() ||
            this.canFilterByYear()
    );
    readonly activeRefinementCount = computed(() =>
        Number(this.minRating() !== null) +
        Number(this.genreFilter() !== null) +
        Number(this.yearFilter() !== null)
    );
    readonly activeSortLabelKey = computed(() => {
        switch (this.contentSortMode()) {
            case 'date-desc':
                return 'WORKSPACE.SORT_DATE_DESC';
            case 'date-asc':
                return 'WORKSPACE.SORT_DATE_ASC';
            case 'name-asc':
                return 'WORKSPACE.SORT_NAME_ASC';
            case 'name-desc':
                return 'WORKSPACE.SORT_NAME_DESC';
            case 'year-desc':
                return 'WORKSPACE.SORT_YEAR_DESC';
            case 'year-asc':
                return 'WORKSPACE.SORT_YEAR_ASC';
            case 'rating-desc':
                return 'WORKSPACE.SORT_TOP_RATED';
            case 'rating-asc':
                return 'WORKSPACE.SORT_LOWEST_RATED';
            default:
                return 'WORKSPACE.SORT_CUSTOM';
        }
    });
    readonly searchTerm = toSignal(
        this.activatedRoute.queryParamMap.pipe(map((p) => p.get('q') ?? '')),
        { initialValue: '' }
    );
    readonly selectedDetailComponent = computed(() =>
        this.selectedItem() ? this.detailComponent : null
    );
    readonly contentWithProgress = computed(() =>
        (this.paginatedContent() ?? []).map((item: CategoryContentItem) => ({
            ...item,
            ...this.catalog.getItemProgress(item),
        }))
    );

    setContentSortMode(mode: PortalCatalogSortMode): void {
        this.catalog.setContentSortMode(mode);
        this.updateRefinementQueryParams();
    }

    setMinRating(value: number | null): void {
        this.catalog.setMinRating?.(value);
        this.updateRefinementQueryParams();
    }

    setGenreFilter(value: string | null): void {
        this.catalog.setGenreFilter?.(value);
        this.updateRefinementQueryParams();
    }

    setYearFilter(value: number | null): void {
        this.catalog.setYearFilter?.(value);
        this.yearInput.set(value === null ? '' : String(value));
        this.updateRefinementQueryParams();
    }

    onYearInput(event: Event): void {
        const input = event.target as HTMLInputElement;
        const value = input.value.replace(/\D/g, '').slice(0, 4);
        input.value = value;
        this.yearInput.set(value);
    }

    applyYearFilter(): void {
        const value = this.yearInput().trim();
        if (!value) {
            this.setYearFilter(null);
        } else if (value.length === 4) {
            this.setYearFilter(Number(value));
        }
    }

    toggleRefineSection(section: 'sort' | 'rating' | 'genre' | 'year'): void {
        switch (section) {
            case 'sort':
                this.sortSectionExpanded.update((expanded) => !expanded);
                break;
            case 'rating':
                this.ratingSectionExpanded.update((expanded) => !expanded);
                break;
            case 'genre':
                this.genreSectionExpanded.update((expanded) => !expanded);
                break;
            case 'year':
                this.yearSectionExpanded.update((expanded) => !expanded);
                break;
        }
    }

    private readonly performanceCapture = inject(UiPerformanceService);
    constructor() {
        this.router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
            if (event instanceof NavigationStart) this.saveListState();
        });
        afterRenderEffect(() => {
            const url = this.listUrl();
            this.paginatedContent();
            if (!url || this.isPaginatedContentLoading() || this.restoredListUrl === url) return;
            const grid = this.gridElement();
            if (!grid) return;
            const saved = this.navigationState.read(url);
            grid.scrollTop = saved?.scrollTop ?? 0;
            this.restoredListUrl = url;
        });
        effect(() => {
            this.paginatedContent();
            if (!this.isPaginatedContentLoading()) {
                this.performanceCapture.painted('category');
            }
        });
    }

    ngOnInit(): void {
        this.activatedRoute.paramMap
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((params) => {
                this.catalog.initialize(params.get('categoryId'));
            });

        this.activatedRoute.queryParamMap
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((params) => {
                const searchQuery = params.get('q') ?? '';
                const pageIndex = this.toPageIndex(params.get('page'));

                const saved = this.navigationState.read(this.router.url);
                const fallback = saved ?? this.currentRefinements();
                // An unrelated category starts with its own filters. URL state
                // and an exact list snapshot take precedence when returning.
                if (!saved && !this.hasAppliedInitialQueryParams) {
                    fallback.minRating = null;
                    fallback.genreFilter = null;
                    fallback.yearFilter = null;
                }
                const refinements = readCatalogueRefinements(params, fallback);
                this.catalog.setLimit(refinements.limit);
                if (refinements.sortMode) this.catalog.setContentSortMode(refinements.sortMode);
                this.catalog.setMinRating?.(refinements.minRating);
                this.catalog.setGenreFilter?.(refinements.genreFilter);
                this.catalog.setYearFilter?.(refinements.yearFilter);
                this.yearInput.set(refinements.yearFilter === null ? '' : String(refinements.yearFilter));
                this.restoredListUrl = null;
                this.listUrl.set(this.router.url);

                this.catalog.setSearchQuery?.(searchQuery);

                this.hasAppliedInitialQueryParams = true;
                this.catalog.setPage(pageIndex);
            });
    }

    onPageChange(event: PageEvent): void {
        this.catalog.setLimit(event.pageSize);
        this.catalog.setPage(event.pageIndex);
        this.scrollGridToTop();

        void this.router.navigate([], {
            relativeTo: this.activatedRoute,
            queryParams: {
                page: event.pageIndex > 0 ? event.pageIndex + 1 : null,
                limit: event.pageSize,
            },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        });
    }

    onItemClick(item: CategoryContentItem): void {
        const navigation = this.catalog.selectItem(item);
        if (navigation?.length) {
            this.saveListState();
            this.router.navigate(navigation, {
                relativeTo: this.activatedRoute,
                queryParamsHandling: 'preserve',
                state: { catalogueOrigin: this.router.url },
            });
        }
    }

    private toPageIndex(value: string | null): number {
        const page = Number(value);
        return Number.isInteger(page) && page > 0 ? page - 1 : 0;
    }

    private scrollGridToTop(): void {
        this.gridElement()?.scrollTo?.({ top: 0 });
    }

    private gridElement(): HTMLElement | null {
        return this.hostElement.nativeElement.querySelector('app-grid-list');
    }

    private currentRefinements(): CatalogueRefinements {
        return { limit: this.limit(), sortMode: this.contentSortMode(), minRating: this.minRating(), genreFilter: this.genreFilter(), yearFilter: this.yearFilter() };
    }

    private saveListState(): void {
        const grid = this.gridElement();
        if (grid && this.listUrl()) this.navigationState.save(this.listUrl(), { ...this.currentRefinements(), scrollTop: grid.scrollTop });
    }

    private updateRefinementQueryParams(): void {
        this.scrollGridToTop();
        void this.router.navigate([], {
            relativeTo: this.activatedRoute,
            queryParams: {
                page: null,
                sort: this.contentSortMode(),
                rating: this.minRating(),
                genre: this.genreFilter(),
                year: this.yearFilter(),
                limit: this.limit(),
            },
            queryParamsHandling: 'merge',
            replaceUrl: true,
        });
    }

}
