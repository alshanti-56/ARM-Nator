import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { ActivatedRoute } from "@angular/router";
import { Router } from "@angular/router";
import { combineLatest } from "rxjs";
import { MatIcon } from "@angular/material/icon";
import { GridListComponent } from "@arm-nator/providers/shared/ui";
import {
  PORTAL_PLAYER,
  queryParamSignal,
} from "@arm-nator/providers/shared/util";
import {
  StalkerCatalogRow,
  StalkerStore,
} from "@arm-nator/providers/stalker/data-access";
import { ResolvedPortalPlayback } from "@arm-nator/shared/interfaces";

type StalkerContentType = "itv" | "vod" | "series";
const INITIAL_RENDER_LIMIT = 50;
const RENDER_CHUNK = 50;

@Component({
  selector: "app-stalker-live-stream-layout",
  standalone: true,
  imports: [GridListComponent, MatIcon],
  templateUrl: "./stalker-live-stream-layout.component.html",
  styleUrls: ["./stalker-live-stream-layout.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StalkerLiveStreamLayoutComponent {
  readonly store = inject(StalkerStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly portalPlayer = inject(PORTAL_PLAYER);

  readonly contentType = signal<StalkerContentType>("itv");
  readonly isRecentlyAdded = signal(false);
  readonly isSearchRoute = signal(false);
  readonly search = queryParamSignal(this.route, "q", (value) =>
    (value ?? "").trim(),
  );
  readonly playbackError = signal<string | null>(null);
  readonly activePlayback = signal<ResolvedPortalPlayback | null>(null);
  readonly visibleLimit = signal(INITIAL_RENDER_LIMIT);
  private playRequestVersion = 0;

  readonly categories = this.store.getCategoryResource;
  readonly channels = this.store.getPaginatedContent;
  readonly loading = this.store.isPaginatedContentLoading;
  readonly hasMore = this.store.hasMoreContent;
  readonly totalContentItems = this.store.totalContentItems;
  readonly loadError = this.store.loadError;
  readonly selectedCategory = this.store.selectedCategoryId;

  readonly filteredChannels = computed(() => {
    const query = this.search().toLowerCase();
    const category = this.selectedCategory();

    return this.channels().filter((item) => {
      const name = String(item.name ?? item.o_name ?? "").toLowerCase();
      const matchesSearch = !query || name.includes(query);
      const itemCategory = String(
        item.tv_genre_id ?? item.category_id ?? item["genre_id"] ?? "",
      );
      const matchesCategory =
        !category || category === "*" || itemCategory === category;
      return matchesSearch && matchesCategory;
    });
  });

  readonly visibleChannels = computed(() =>
    this.filteredChannels().slice(0, this.visibleLimit()),
  );
  readonly hasMoreVisibleChannels = computed(
    () =>
      this.visibleLimit() < this.filteredChannels().length || this.hasMore(),
  );
  readonly selectedCategoryName = computed(() => {
    if (this.isRecentlyAdded()) {
      return "Recently added";
    }

    if (this.isSearchRoute()) {
      return "Search";
    }

    const selected = this.selectedCategory();
    if (!selected || selected === "*") {
      return this.allItemsLabel();
    }

    return (
      this.categories().find(
        (category) => String(category.category_id) === String(selected),
      )?.category_name ?? "Category"
    );
  });
  readonly contentLabel = computed(() => {
    if (this.isRecentlyAdded()) {
      return "Recently added";
    }

    if (this.isSearchRoute()) {
      return "Search";
    }

    switch (this.contentType()) {
      case "vod":
        return "Movies";
      case "series":
        return "Series";
      default:
        return "Live TV";
    }
  });
  readonly contentCountLabel = computed(() => {
    const count = this.search().trim()
      ? this.filteredChannels().length
      : this.totalContentItems() || this.filteredChannels().length;
    return `${count} ${count === 1 ? "item" : "items"}`;
  });
  readonly gridItems = computed(() =>
    this.visibleChannels().map((item) => {
      const { is_series, ...rest } = item;
      const streamIcon =
        typeof item["stream_icon"] === "string"
          ? item["stream_icon"]
          : undefined;

      return {
        ...rest,
        ...(is_series == null ? {} : { is_series }),
        title: item.title ?? item.o_name ?? item.name,
        stream_icon: item.logo ?? streamIcon ?? item.cover,
      };
    }),
  );
  readonly usesEmbeddedPlayer = computed(() =>
    this.portalPlayer.isEmbeddedPlayer(this.contentType() === "itv"),
  );

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.playRequestVersion += 1;
    });

    combineLatest([this.route.data, this.route.paramMap])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([data, params]) => {
        const routeType = data["contentType"];
        const nextType: StalkerContentType =
          routeType === "vod" || routeType === "series" ? routeType : "itv";
        const categoryId = params.get("categoryId");

        this.contentType.set(nextType);
        this.isRecentlyAdded.set(data["recentlyAdded"] === true);
        this.isSearchRoute.set(data["searchRoute"] === true);
        this.store.setSelectedContentType(nextType);
        this.store.setSelectedCategory(categoryId);
        if (nextType === "itv") {
          this.store.preloadItvChannels();
        }
        this.activePlayback.set(null);
        this.playbackError.set(null);
        this.visibleLimit.set(INITIAL_RENDER_LIMIT);
      });

    effect(() => {
      const search = this.search();
      this.selectedCategory();
      this.contentType();
      this.visibleLimit.set(INITIAL_RENDER_LIMIT);

      if (this.isSearchRoute()) {
        untracked(() => this.store.setSearchPhrase(search));
      }
    });

    // The workspace route resolves the persisted portal asynchronously.
    // The first route-param emission can therefore happen before the
    // store has credentials; retry once the playlist is actually ready.
    effect(() => {
      const playlist = this.store.currentPlaylist();
      this.contentType();
      this.selectedCategory();
      if (playlist) {
        untracked(() => this.store.preloadSelectedContent());
      }
    });
  }

  async play(
    item: StalkerCatalogRow,
    refreshBeforePlayback = false,
    retrySignal?: AbortSignal,
  ): Promise<void> {
    const requestVersion = ++this.playRequestVersion;
    const playableItem = refreshBeforePlayback
      ? ((await this.store.refreshItvChannel(item)) ?? item)
      : item;
    if (retrySignal?.aborted || requestVersion !== this.playRequestVersion) {
      return;
    }
    this.store.setSelectedItem(playableItem);
    this.playbackError.set(null);

    if (this.contentType() !== "itv") {
      const portalId = this.route.parent?.snapshot.paramMap.get("id");
      const itemId = String(
        playableItem.movie_id ??
          playableItem.series_id ??
          playableItem.id ??
          playableItem.stream_id ??
          "",
      ).trim();
      if (!portalId || !itemId) {
        this.playbackError.set("This item has no usable portal ID");
        return;
      }

      await this.router.navigate([
        "/workspace/stalker",
        portalId,
        this.contentType(),
        this.selectedCategory() ?? "*",
        itemId,
      ]);
      return;
    }

    try {
      // The retry path already refreshed the row above. Keep playback
      // resolution itself non-blocking so a second full catalog request
      // cannot be queued when that refresh fails.
      const playback = await this.store.resolveItvPlayback(playableItem);
      if (retrySignal?.aborted || requestVersion !== this.playRequestVersion) {
        return;
      }
      this.activePlayback.set(playback);

      const items = this.filteredChannels();
      const index = items.findIndex(
        (candidate) => String(candidate.id) === String(playableItem.id),
      );
      void this.portalPlayer.openResolvedPlayback(playback, true, {
        canPrevious: index > 0,
        canNext: index >= 0 && index < items.length - 1,
        onPrevious: () => {
          const previous = items[index - 1];
          if (previous) void this.play(previous);
        },
        onNext: () => {
          const next = items[index + 1];
          if (next) void this.play(next);
        },
        onRetry: (signal) => this.play(playableItem, true, signal),
      });
    } catch (cause) {
      if (retrySignal?.aborted || requestVersion !== this.playRequestVersion) {
        return;
      }
      this.playbackError.set(
        cause instanceof Error ? cause.message : "Unable to play this item",
      );
    }
  }

  playGridItem(item: unknown): void {
    const id = String((item as { id?: string | number }).id ?? "");
    const source = this.filteredChannels().find(
      (candidate) => String(candidate.id) === id,
    );
    if (source) {
      void this.play(source);
    }
  }

  loadMore(): void {
    if (this.visibleLimit() < this.filteredChannels().length) {
      this.visibleLimit.update((limit) => limit + RENDER_CHUNK);
      return;
    }

    this.store.loadMore();
  }

  private allItemsLabel(): string {
    switch (this.contentType()) {
      case "vod":
        return "All movies";
      case "series":
        return "All series";
      default:
        return "All channels";
    }
  }
}
