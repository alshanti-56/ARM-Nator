import { InjectionToken, Signal } from '@angular/core';
export type PortalCatalogProvider = 'xtream';

export type PortalCatalogSortMode =
    | 'date-desc'
    | 'date-asc'
    | 'name-asc'
    | 'name-desc'
    | 'year-desc'
    | 'year-asc'
    | 'rating-desc'
    | 'rating-asc';

export interface PortalCatalogPlaylistMeta {
    id: string;
    title?: string;
    portalUrl?: string;
    macAddress?: string;
    userAgent?: string;
    referer?: string;
    origin?: string;
}

export interface PortalCatalogItemProgress {
    progress?: number;
    isWatched?: boolean;
    hasSeriesProgress?: boolean;
}

export interface PortalCatalogFacade<
    TCategory = unknown,
    TItem = unknown,
    TSelectedItem = unknown,
> {
    readonly provider: PortalCatalogProvider;
    readonly pageSizeOptions: readonly number[];
    readonly contentType: Signal<string | null | undefined>;
    readonly limit: Signal<number>;
    readonly pageIndex: Signal<number>;
    readonly selectedCategory: Signal<TCategory | null | undefined>;
    readonly paginatedContent: Signal<readonly TItem[] | undefined>;
    readonly selectedItem: Signal<TSelectedItem | null | undefined>;
    readonly totalPages: Signal<number>;
    readonly isPaginatedContentLoading: Signal<boolean>;
    readonly selectedCategoryTitle: Signal<string>;
    readonly categoryItemCount: Signal<number>;
    readonly contentSortMode: Signal<PortalCatalogSortMode | null>;
    readonly playlist: Signal<PortalCatalogPlaylistMeta | null>;
    /** Optional IMDb-rating capability (Xtream VOD/series). */
    readonly supportsRatingSort?: boolean;
    readonly minRating?: Signal<number | null>;
    readonly genreFilter?: Signal<string | null>;
    readonly yearFilter?: Signal<number | null>;
    readonly availableGenres?: Signal<readonly string[]>;
    readonly availableYears?: Signal<readonly number[]>;

    initialize(categoryId?: string | null): void;
    setSearchQuery?(query: string): void;
    clearSelectedItem(): void;
    setPage(page: number): void;
    setLimit(limit: number): void;
    setContentSortMode(mode: PortalCatalogSortMode): void;
    setMinRating?(value: number | null): void;
    setGenreFilter?(value: string | null): void;
    setYearFilter?(value: number | null): void;
    selectItem(item: TItem): string[] | null;
    /** Optional refresh for a selection injected from navigation state. */
    refreshSnapshotSelection?(): void;
    getItemProgress(item: TItem): PortalCatalogItemProgress;
}

export const PORTAL_CATALOG_FACADE = new InjectionToken<PortalCatalogFacade>(
    'PORTAL_CATALOG_FACADE'
);
