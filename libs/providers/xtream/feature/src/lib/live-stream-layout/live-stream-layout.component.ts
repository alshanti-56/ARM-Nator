import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  OnInit,
  signal,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { filter } from "rxjs";
import { MatButtonModule } from "@angular/material/button";
import { MatIcon } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatPaginatorModule, PageEvent } from "@angular/material/paginator";
import { MatTooltipModule } from "@angular/material/tooltip";
import { GridListComponent } from "@arm-nator/providers/shared/ui";
import {
  PORTAL_PLAYER,
  PortalChannelSortMode,
  getPortalChannelSortModeLabel,
  isWorkspaceLayoutRoute,
  persistPortalChannelSortMode,
  queryParamSignal,
  restorePortalChannelSortMode,
} from "@arm-nator/providers/shared/util";

import {
  FavoriteItem,
  FavoritesService,
  XtreamStore,
} from "@arm-nator/providers/xtream/data-access";
import { type PlaybackFallbackRequest } from "@arm-nator/player/ui";
import { ResolvedPortalPlayback } from "@arm-nator/shared/interfaces";

import {
  PortalChannelsListComponent,
  type XtreamChannelListItem,
} from "../portal-channels-list/portal-channels-list.component";
import { ActivatedRoute, NavigationEnd, Router } from "@angular/router";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import { LiveStreamAutoOpenStateService } from "./live-stream-auto-open-state.service";

const LIVE_CHANNEL_SORT_STORAGE_KEY = "xtream-live-channel-sort-mode";
const LIVE_VIEW_MODE_STORAGE_KEY = "xtream-live-view-mode";

type LiveViewMode = "grid" | "list";

function restoreLiveViewMode(): LiveViewMode {
  if (typeof localStorage === "undefined") {
    return "grid";
  }

  return localStorage.getItem(LIVE_VIEW_MODE_STORAGE_KEY) === "list"
    ? "list"
    : "grid";
}

interface XtreamLiveChannelItem {
  readonly added?: string;
  readonly category_id?: string | number;
  readonly last_modified?: string;
  readonly name?: string;
  readonly poster_url?: string;
  readonly stream_icon?: string;
  readonly title?: string;
  readonly xtream_id: number;
}

@Component({
  selector: "app-live-stream-layout",
  templateUrl: "./live-stream-layout.component.html",
  styleUrls: ["./live-stream-layout.component.scss"],
  providers: [LiveStreamAutoOpenStateService],
  imports: [
    MatButtonModule,
    MatIcon,
    MatMenuModule,
    MatPaginatorModule,
    MatTooltipModule,
    GridListComponent,
    PortalChannelsListComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveStreamLayoutComponent implements OnInit {
  private readonly destroyRef = inject(DestroyRef);
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly favoritesService = inject(FavoritesService);
  private readonly xtreamStore = inject(XtreamStore);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly portalPlayer = inject(PORTAL_PLAYER);
  private readonly liveAutoOpenState = inject(LiveStreamAutoOpenStateService);

  readonly categories = this.xtreamStore.getCategoriesBySelectedType;
  readonly categoryItemCounts = this.xtreamStore.getCategoryItemCounts;
  readonly isSelectedTypeContentLoading =
    this.xtreamStore.selectedTypeContentLoading;
  readonly selectedCategoryId = this.xtreamStore.selectedCategoryId;
  readonly liveChannelSortMode = signal<PortalChannelSortMode>("server");
  readonly liveViewMode = signal<LiveViewMode>(restoreLiveViewMode());
  readonly isElectron = this.runtime.isElectron;
  readonly isWorkspaceLayout = isWorkspaceLayoutRoute(this.route);
  private readonly routeSearchTerm = queryParamSignal(
    this.route,
    "q",
    (value) => (value ?? "").trim(),
  );
  private readonly routePageIndex = queryParamSignal(
    this.route,
    "page",
    (value) => this.toPageIndex(value),
  );
  readonly workspaceSearchTerm = computed(() =>
    this.isWorkspaceLayout ? this.routeSearchTerm() : "",
  );
  private readonly pendingAutoOpenLiveItemId =
    this.liveAutoOpenState.pendingItemId;
  readonly selectedLiveItem = computed<XtreamLiveChannelItem | null>(() => {
    if (this.xtreamStore.selectedContentType() !== "live") {
      return null;
    }

    const selectedItem = this.xtreamStore.selectedItem();
    if (!selectedItem || typeof selectedItem !== "object") {
      return null;
    }

    const item = selectedItem as XtreamLiveChannelItem;
    return item.xtream_id ? item : null;
  });
  readonly liveChannelSortLabel = computed(() =>
    getPortalChannelSortModeLabel(this.liveChannelSortMode()),
  );
  readonly liveRootPageSizeOptions = [10, 25, 50, 100];
  readonly liveRootItems = computed(
    () =>
      this.xtreamStore.getPaginatedContent() as unknown as XtreamChannelListItem[],
  );
  readonly liveRootItemCount = computed(
    () => this.xtreamStore.selectItemsFromSelectedCategory().length,
  );
  readonly liveRootSubtitle = computed(() => {
    const count = this.liveRootItemCount();
    return `${count} ${count === 1 ? "channel" : "channels"}`;
  });
  readonly liveRootPageIndex = this.xtreamStore.page;
  readonly liveRootLimit = this.xtreamStore.limit;
  readonly liveRootTotalPages = this.xtreamStore.getTotalPages;
  readonly showLiveRootPaginator = computed(() => this.liveRootItemCount() > 0);

  readonly selectedCategoryInfo = computed(() => {
    const categoryId = this.selectedCategoryId();
    if (!categoryId) return null;

    const categories = this.categories();
    const category = categories?.find(
      (c) => (c.category_id ?? c.id) === categoryId,
    );
    const count = this.categoryItemCounts()?.get(categoryId) ?? 0;

    return {
      name: category?.category_name ?? category?.name ?? "Channels",
      count,
    };
  });

  readonly usesEmbeddedPlayer = computed(() =>
    this.portalPlayer.isEmbeddedPlayer(true),
  );
  favorites = new Map<number, boolean>();

  constructor() {
    effect(() => {
      if (this.xtreamStore.selectedContentType() !== "live") {
        return;
      }

      const pageIndex = this.routePageIndex();
      if (this.liveRootPageIndex() !== pageIndex) {
        this.xtreamStore.setPage(pageIndex);
      }
    });

    // Read pending auto-open state on every NavigationEnd — covers both the
    // initial navigation (Angular fires NavigationEnd after component creation)
    // and re-navigation to the same /live route when the component is reused.
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.liveAutoOpenState.captureFromHistoryState());

    effect(() => {
      const pendingId = this.pendingAutoOpenLiveItemId();
      if (!pendingId) {
        return;
      }

      // Guard: only process once the live content view is active; otherwise
      // the effect may fire while selectedContentType is still 'vod' and
      // incorrectly conclude the channel isn't found.
      if (this.xtreamStore.selectedContentType() !== "live") {
        return;
      }

      // Search across all live streams, not just the category-filtered view,
      // so a channel from a different category can still be auto-opened.
      const allChannels = this.getAllLiveStreams();
      if (!Array.isArray(allChannels) || allChannels.length === 0) {
        return;
      }

      const item = allChannels.find(
        (channel) => Number(channel?.xtream_id) === pendingId,
      );
      if (!item) {
        this.pendingAutoOpenLiveItemId.set(null);
        return;
      }

      this.playLive(item);
      // Keep the selected item in sync with auto-open playback.
      this.xtreamStore.setSelectedItem(
        item as unknown as Record<string, unknown>,
      );
      this.liveAutoOpenState.clearPendingItem();
      this.liveAutoOpenState.clearHistoryState();
    });
  }

  ngOnInit() {
    this.liveChannelSortMode.set(
      restorePortalChannelSortMode(LIVE_CHANNEL_SORT_STORAGE_KEY),
    );

    const playlist = this.xtreamStore.currentPlaylist();
    if (playlist) {
      this.favoritesService.getFavorites(playlist.id).subscribe((favorites) => {
        // Map using content.id instead of xtream_id
        favorites.forEach((fav: FavoriteItem) => {
          this.favorites.set(fav.xtream_id, true);
        });
      });
    }
  }

  playLive(
    item: XtreamLiveChannelItem,
    startPlayback = !this.settingsStore.openStreamOnDoubleClick(),
  ) {
    const streamUrl = this.xtreamStore.constructStreamUrl(item);
    // Keep both root/recently-added playback and same-category replays in
    // sync with the category rail. For already-selected channels this is a
    // store no-op.
    this.selectLiveItemCategory(item);
    const playback: ResolvedPortalPlayback = {
      streamUrl,
      title: item.title ?? item.name ?? "",
      thumbnail: item.poster_url ?? item.stream_icon ?? null,
      isLive: true,
    };
    if (this.usesEmbeddedPlayer()) {
      const channels = this.getAllLiveStreams();
      const index = channels.findIndex(
        (channel) => Number(channel.xtream_id) === Number(item.xtream_id),
      );
      void this.portalPlayer.openResolvedPlayback(playback, true, {
        canPrevious: index > 0,
        canNext: index >= 0 && index < channels.length - 1,
        onPrevious: () => {
          const previous = channels[index - 1];
          if (previous) this.playLive(previous, true);
        },
        onNext: () => {
          const next = channels[index + 1];
          if (next) this.playLive(next, true);
        },
      });
      return;
    }
    if (!startPlayback) {
      return;
    }
    this.xtreamStore.openPlayer(
      streamUrl,
      item.title ?? item.name ?? "",
      item.poster_url ?? item.stream_icon ?? null,
    );
  }

  setLiveChannelSortMode(mode: PortalChannelSortMode): void {
    this.liveChannelSortMode.set(mode);
    persistPortalChannelSortMode(LIVE_CHANNEL_SORT_STORAGE_KEY, mode);
  }

  setLiveViewMode(mode: LiveViewMode): void {
    this.liveViewMode.set(mode);
    localStorage.setItem(LIVE_VIEW_MODE_STORAGE_KEY, mode);
  }

  onLiveRootPageChange(event: PageEvent): void {
    this.xtreamStore.setPage(event.pageIndex);
    this.xtreamStore.setLimit(event.pageSize);
    this.scrollLiveContentToTop();

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        page: event.pageIndex > 0 ? event.pageIndex + 1 : null,
      },
      queryParamsHandling: "merge",
      replaceUrl: true,
    });
  }

  onLiveRootItemClick(item: unknown): void {
    this.playLive(item as XtreamLiveChannelItem);
  }

  returnToLivePlayback(): void {
    const selectedItem = this.selectedLiveItem();
    if (!selectedItem?.xtream_id) {
      return;
    }

    this.playLive(selectedItem, true);
  }

  handleExternalFallbackRequest(request: PlaybackFallbackRequest): void {
    void this.portalPlayer.openExternalPlayback(
      request.playback,
      request.player,
    );
  }

  private getAllLiveStreams(): XtreamLiveChannelItem[] {
    return this.xtreamStore.liveStreams() as unknown as XtreamLiveChannelItem[];
  }

  private toPageIndex(value: string | null): number {
    const page = Number(value);
    return Number.isInteger(page) && page > 0 ? page - 1 : 0;
  }

  private scrollLiveContentToTop(): void {
    const scrollTarget = this.hostElement.nativeElement.querySelector(
      this.liveViewMode() === "list"
        ? "app-portal-channels-list .scroll-viewport-portals"
        : "app-grid-list",
    ) as HTMLElement | null;
    scrollTarget?.scrollTo?.({ top: 0 });
  }

  private getVisibleChannels(): XtreamLiveChannelItem[] {
    return this.xtreamStore.selectItemsFromSelectedCategory() as XtreamLiveChannelItem[];
  }

  private selectLiveItemCategory(item: XtreamLiveChannelItem): void {
    const categoryId = Number(item.category_id);
    if (Number.isFinite(categoryId) && categoryId > 0) {
      this.xtreamStore.setSelectedCategory(categoryId);
    }
  }
}
