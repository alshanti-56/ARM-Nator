import { Provider, Injectable, computed, inject } from "@angular/core";
import {
  PortalCatalogFacade,
  PortalCatalogItemProgress,
  PortalCatalogPlaylistMeta,
  PortalCatalogSortMode,
  PORTAL_CATALOG_FACADE,
} from "@arm-nator/providers/shared/util";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { TmdbEnrichmentService } from "@arm-nator/services";
import { normalizeTitleKeys } from "@arm-nator/shared/interfaces";

const SORT_STORAGE_KEY = "xtream-category-sort-mode";

const isValidSortMode = (mode: string | null): mode is PortalCatalogSortMode =>
  mode === "date-desc" ||
  mode === "date-asc" ||
  mode === "name-asc" ||
  mode === "name-desc" ||
  mode === "year-desc" ||
  mode === "year-asc" ||
  mode === "rating-desc" ||
  mode === "rating-asc";

const isRatingSortMode = (mode: PortalCatalogSortMode): boolean =>
  mode === "rating-desc" || mode === "rating-asc";

const isMetadataSortMode = (mode: PortalCatalogSortMode): boolean =>
  isRatingSortMode(mode) || mode === "year-desc" || mode === "year-asc";

@Injectable()
export class XtreamCatalogFacadeService implements PortalCatalogFacade<
  Record<string, unknown>,
  Record<string, unknown>,
  unknown
> {
  private readonly xtreamStore = inject(XtreamStore);
  private readonly tmdbEnrichment = inject(TmdbEnrichmentService);
  private loadedPositionsPlaylistId: string | null = null;
  private personSearchVersion = 0;

  readonly provider = "xtream" as const;
  readonly pageSizeOptions = [10, 25, 50, 100] as const;
  readonly contentType = this.xtreamStore.selectedContentType;
  readonly limit = this.xtreamStore.limit;
  readonly pageIndex = this.xtreamStore.page;
  readonly selectedCategory = this.xtreamStore.getSelectedCategory;
  readonly paginatedContent = this.xtreamStore.getPaginatedContent;
  readonly selectedItem = this.xtreamStore.selectedItem;
  readonly totalPages = this.xtreamStore.getTotalPages;
  readonly isPaginatedContentLoading =
    this.xtreamStore.isPaginatedContentLoading;
  readonly selectedCategoryTitle = computed(() => {
    const category = this.selectedCategory();
    return String(category?.["name"] ?? category?.["title"] ?? "");
  });
  readonly categoryItemCount = computed(
    () => this.xtreamStore.selectItemsFromSelectedCategory().length,
  );
  readonly contentSortMode = computed<PortalCatalogSortMode>(() => {
    const mode = this.xtreamStore.contentSortMode();

    return !this.supportsRatingSort && isMetadataSortMode(mode)
      ? "date-desc"
      : mode;
  });
  get supportsRatingSort(): boolean {
    const type = this.contentType();
    return type === "vod" || type === "series";
  }
  readonly minRating = computed(() =>
    this.supportsRatingSort ? this.xtreamStore.minRating() : null,
  );
  readonly genreFilter = computed(() =>
    this.supportsRatingSort ? this.xtreamStore.genreFilter() : null,
  );
  readonly yearFilter = computed(() =>
    this.supportsRatingSort ? this.xtreamStore.yearFilter() : null,
  );
  readonly availableGenres = computed(() =>
    this.supportsRatingSort ? this.xtreamStore.availableGenres() : [],
  );
  readonly availableYears = computed(() =>
    this.supportsRatingSort ? this.xtreamStore.availableYears() : [],
  );
  readonly playlist = computed<PortalCatalogPlaylistMeta | null>(() => {
    const playlist = this.xtreamStore.currentPlaylist();
    if (!playlist) {
      return null;
    }

    return {
      id: String(playlist.id),
      title: playlist.name ?? playlist.title ?? "Xtream",
    };
  });

  initialize(categoryId?: string | null): void {
    const savedSortMode = localStorage.getItem(SORT_STORAGE_KEY);
    if (isValidSortMode(savedSortMode)) {
      this.setContentSortMode(savedSortMode);
    }

    const playlistId = this.xtreamStore.currentPlaylist()?.id;
    if (playlistId && this.loadedPositionsPlaylistId !== playlistId) {
      this.loadedPositionsPlaylistId = playlistId;
      this.xtreamStore.loadAllPositions(playlistId);
    }

    this.clearSelectedItem();

    if (categoryId) {
      this.xtreamStore.setSelectedCategory(Number(categoryId));
    } else {
      this.xtreamStore.setSelectedCategory(null);
    }
  }

  clearSelectedItem(): void {
    this.xtreamStore.setSelectedItem(null);
  }

  setSearchQuery(query: string): void {
    this.xtreamStore.setCategorySearchTerm(query);
    const normalized = query.trim();
    const version = ++this.personSearchVersion;
    this.xtreamStore.setPersonSearchTitleKeys([]);
    if (
      normalized.length < 3 ||
      !this.supportsRatingSort ||
      !this.tmdbEnrichment.isEnabled()
    ) {
      return;
    }

    void this.tmdbEnrichment.searchPersonDetails(normalized).then((person) => {
      if (version !== this.personSearchVersion || !person) {
        return;
      }

      const keys: string[] = [];
      for (const credit of person.combined_credits?.cast ?? []) {
        const title = credit.title ?? credit.name;
        const normalizedTitle = normalizeTitleKeys(title);
        if (normalizedTitle.exact) keys.push(normalizedTitle.exact);
        if (normalizedTitle.base) keys.push(normalizedTitle.base);
      }
      this.xtreamStore.setPersonSearchTitleKeys(keys);
    });
  }

  setPage(page: number): void {
    this.xtreamStore.setPage(page);
  }

  setLimit(limit: number): void {
    this.xtreamStore.setLimit(limit);
  }

  setContentSortMode(mode: PortalCatalogSortMode): void {
    if (!this.supportsRatingSort && isMetadataSortMode(mode)) {
      return;
    }

    this.xtreamStore.setContentSortMode(mode);
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  }

  setMinRating(value: number | null): void {
    if (!this.supportsRatingSort) {
      return;
    }

    this.xtreamStore.setMinRating(value);
  }

  setGenreFilter(value: string | null): void {
    if (!this.supportsRatingSort) {
      return;
    }
    this.xtreamStore.setGenreFilter(value);
  }

  setYearFilter(value: number | null): void {
    if (!this.supportsRatingSort) {
      return;
    }
    this.xtreamStore.setYearFilter(value);
  }

  selectItem(item: Record<string, unknown>): string[] | null {
    const xtreamId = item["xtream_id"];
    if (xtreamId === undefined || xtreamId === null) {
      return null;
    }

    const selectedCategoryId = this.xtreamStore.selectedCategoryId();
    if (selectedCategoryId !== null && selectedCategoryId !== undefined) {
      return [String(xtreamId)];
    }

    const categoryId = item["category_id"];
    if (categoryId === undefined || categoryId === null) {
      return null;
    }

    return [String(categoryId), String(xtreamId)];
  }

  getItemProgress(item: Record<string, unknown>): PortalCatalogItemProgress {
    const isSeries = this.contentType() === "series";
    const itemId = Number(
      item["xtream_id"] ?? item["series_id"] ?? item["stream_id"],
    );
    if (Number.isNaN(itemId)) {
      return {};
    }

    if (isSeries) {
      return {
        hasSeriesProgress: this.xtreamStore.hasSeriesProgress(itemId),
      };
    }

    return {
      progress: this.xtreamStore.getProgressPercent(itemId, "vod"),
      isWatched: this.xtreamStore.isWatched(itemId, "vod"),
    };
  }
}

export function provideXtreamCatalogFacade(): Provider[] {
  return [
    XtreamCatalogFacadeService,
    {
      provide: PORTAL_CATALOG_FACADE,
      useExisting: XtreamCatalogFacadeService,
    },
  ];
}
