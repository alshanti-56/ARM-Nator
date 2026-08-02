import { CommonModule } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Input,
  input,
  OnDestroy,
  OnInit,
  output,
  signal,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { ActivatedRoute, NavigationEnd, Router } from "@angular/router";
import { Store } from "@ngrx/store";
import { TranslatePipe } from "@ngx-translate/core";
import { PlaylistContextFacade } from "@arm-nator/providers/shared/playlist-util";
import {
  isWorkspaceLayoutRoute,
  queryParamSignal,
} from "@arm-nator/providers/shared/util";
import {
  ChannelActions,
  FavoritesActions,
  PlaylistActions,
  selectActive,
  selectFavorites,
} from "@arm-nator/providers/m3u/state";

import {
  BehaviorSubject,
  combineLatest,
  filter,
  firstValueFrom,
  map,
} from "rxjs";
import {
  PlaylistsService,
  SettingsStore,
} from "@arm-nator/services";
import {
  Channel,
  isM3uRecentlyViewedItem,
  normalizeDate,
  PlaylistMeta,
  PlaylistRecentlyViewedItem,
} from "@arm-nator/shared/interfaces";

import { AllChannelsViewComponent } from "./all-channels-view/all-channels-view.component";
import { FavoritesViewComponent } from "./favorites-view/favorites-view.component";
import { GroupsViewComponent } from "./groups-view/groups-view.component";
import {
  RecentViewComponent,
  RecentViewItem,
} from "./recent-view/recent-view.component";
import { ChannelListLoadingStateComponent } from "../channel-list-loading-state/channel-list-loading-state.component";

function groupChannelsByTitle(channels: Channel[]): Record<string, Channel[]> {
  return channels.reduce<Record<string, Channel[]>>((groups, channel) => {
    const key = channel.group?.title ?? "";
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(channel);
    return groups;
  }, {});
}

function mapChannelsByFirstUrl(channels: Channel[]): Map<string, Channel> {
  const channelsByUrl = new Map<string, Channel>();

  for (const channel of channels) {
    const channelUrl = channel.url;
    if (!channelsByUrl.has(channelUrl)) {
      channelsByUrl.set(channelUrl, channel);
    }
  }

  return channelsByUrl;
}

@Component({
  selector: "app-channel-list-container",
  templateUrl: "./channel-list-container.component.html",
  styleUrls: ["./channel-list-container.component.scss"],
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AllChannelsViewComponent,
    ChannelListLoadingStateComponent,
    CommonModule,
    FavoritesViewComponent,
    GroupsViewComponent,
    MatButtonModule,
    MatIconModule,
    RecentViewComponent,
    TranslatePipe,
  ],
})
export class ChannelListContainerComponent implements OnInit, OnDestroy {
  private readonly playlistsService = inject(PlaylistsService);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly playlistContext = inject(PlaylistContextFacade);
  private readonly settingsStore = inject(SettingsStore);
  /** Route-aware playlist ID for recent-item mutations */
  private readonly resolvedPlaylistId = this.playlistContext.resolvedPlaylistId;
  private readonly activePlaylist = this.playlistContext.activePlaylist;
  readonly channelIconMap = signal(new Map<string, string>());

  /** Global progress tick signal - triggers re-computation of progress percentages */
  readonly progressTick = signal(0);

  /** Interval for global progress updates */
  private progressInterval?: number;
  readonly openStreamOnDoubleClick = computed(() =>
    this.settingsStore.openStreamOnDoubleClick(),
  );

  readonly itemSize = 48;

  /** Active view (all, groups, favorites, recent) */
  readonly activeView = input<string>("all");
  readonly channelsLoading = input(false);
  readonly recentItems = input<PlaylistRecentlyViewedItem[]>([]);
  readonly sidebarWidth = input<number | null>(null);
  readonly sidebarWidthRequested = output<number>();
  readonly sidebarWidthRequestEnded = output<number>();
  readonly sidebarToggleRequested = output<void>();
  readonly isWorkspaceLayout = isWorkspaceLayoutRoute(this.route);
  private readonly routeSearchTerm = queryParamSignal(
    this.route,
    "q",
    (value) => (value ?? "").trim().toLowerCase(),
  );
  readonly workspaceSearchTerm = computed(() =>
    this.isWorkspaceLayout ? this.routeSearchTerm() : "",
  );

  readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => (event as NavigationEnd).urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  readonly viewTitle = computed(() => {
    const view = this.activeView();
    const url = this.currentUrl();
    if (view === "all") return "CHANNELS.ALL_CHANNELS";
    if (view === "groups") return "CHANNELS.GROUPS";
    if (view === "recent") return "PORTALS.SIDEBAR.RECENT";
    if (view === "favorites") {
      return url.includes("/workspace/global-favorites")
        ? "HOME.PLAYLISTS.GLOBAL_FAVORITES"
        : "CHANNELS.FAVORITES";
    }
    return "";
  });

  /** Channels array */
  _channelList: Channel[] = [];
  private readonly channelListSignal = signal<Channel[]>([]);
  private channelList$ = new BehaviorSubject<Channel[]>([]);

  get channelList(): Channel[] {
    return this._channelList;
  }

  @Input()
  set channelList(value: Channel[]) {
    const safeValue = value ?? [];
    this._channelList = safeValue;
    this.channelListSignal.set(safeValue);
    this.channelList$.next(safeValue);
  }

  readonly hiddenGroupTitles = computed(() => {
    const playlist = this.activePlaylist();

    if (!playlist || playlist.serverUrl || playlist.macAddress) {
      return [];
    }

    return playlist.hiddenGroupTitles ?? [];
  });

  /** Displayed channels - filters out unfavorited channels in global favorites view */
  readonly displayedChannels = computed(() => {
    return this.channelListSignal();
  });

  /** Object with channels sorted by groups */
  readonly groupedChannels = computed(() =>
    groupChannelsByTitle(this.displayedChannels()),
  );

  readonly recentChannelItems = computed<RecentViewItem[]>(() => {
    const channels = this.channelListSignal();
    const recentItems = this.recentItems();
    const channelsByUrl = new Map(
      channels.map((channel) => [channel.url, channel] as const),
    );
    const channelsById = new Map(
      channels.map((channel) => [channel.id, channel] as const),
    );
    const seenUrls = new Set<string>();

    return [...recentItems]
      .filter(isM3uRecentlyViewedItem)
      .sort(
        (a, b) =>
          new Date(normalizeDate(b.added_at)).getTime() -
          new Date(normalizeDate(a.added_at)).getTime(),
      )
      .reduce<RecentViewItem[]>((acc, item) => {
        const channelUrl = item.url?.trim();
        if (!channelUrl || seenUrls.has(channelUrl)) {
          return acc;
        }

        const channel =
          channelsByUrl.get(channelUrl) ||
          (item.channel_id ? channelsById.get(item.channel_id) : undefined);

        if (!channel) {
          return acc;
        }

        seenUrls.add(channel.url);
        acc.push({
          channel,
          viewedAt: normalizeDate(item.added_at),
        });
        return acc;
      }, []);
  });

  /** Selected channel */
  readonly activeChannel = this.store.selectSignal(selectActive);

  /** Active channel URL for highlighting */
  readonly activeChannelUrl = computed(() => this.activeChannel()?.url);

  /** Set of favorite channel URLs for quick lookup */
  private readonly _favorites = this.store.selectSignal(selectFavorites);
  readonly favoriteIds = computed(() => new Set(this._favorites()));

  /** List with favorites */
  favorites$ = combineLatest([
    this.store.select(selectFavorites),
    this.channelList$,
  ]).pipe(
    map(([favoriteChannelIds, channelList]) => {
      const channelsByUrl = mapChannelsByFirstUrl(channelList);

      return favoriteChannelIds
        .map((favoriteChannelId) => channelsByUrl.get(favoriteChannelId))
        .filter((channel): channel is Channel => channel !== undefined);
    }),
  );

  ngOnInit(): void {
    // Set up global progress update interval (every 30 seconds)
    this.progressInterval = window.setInterval(() => {
      this.progressTick.update((v) => v + 1);
    }, 30000);
  }

  ngOnDestroy(): void {
    this.store.dispatch(ChannelActions.resetActiveChannel());

    if (this.progressInterval) {
      clearInterval(this.progressInterval);
    }

    this.channelList$.complete();
  }

  /**
   * Handles channel selection from any tab
   */
  onChannelSelected(channel: Channel): void {
    this.store.dispatch(ChannelActions.setActiveChannel({ channel }));
  }

  onChannelPlaybackRequested(channel: Channel): void {
    this.store.dispatch(
      ChannelActions.setActiveChannel({
        channel,
        startPlayback: true,
      }),
    );
  }

  /**
   * Handles favorite toggle from favorites tab
   */
  onFavoriteToggled(event: { channel: Channel; event: MouseEvent }): void {
    event.event.stopPropagation();
    this.store.dispatch(
      FavoritesActions.updateFavorites({ channel: event.channel }),
    );
  }

  onHiddenGroupTitlesChanged(hiddenGroupTitles: string[]): void {
    const playlist = this.activePlaylist();

    if (!playlist || playlist.serverUrl || playlist.macAddress) {
      return;
    }

    this.store.dispatch(
      PlaylistActions.updatePlaylistMeta({
        playlist: {
          _id: playlist._id,
          hiddenGroupTitles,
        } as PlaylistMeta,
      }),
    );
  }

  /**
   * Handles favorites reorder from drag-drop
   */
  onFavoritesReordered(channelIds: string[]): void {
    this.store.dispatch(FavoritesActions.setFavorites({ channelIds }));
  }

  async removeRecentChannel(channelUrl: string): Promise<void> {
    const playlistId = this.resolvedPlaylistId();
    if (!playlistId) {
      return;
    }

    const updatedPlaylist = await firstValueFrom(
      this.playlistsService.removeFromM3uRecentlyViewed(playlistId, channelUrl),
    );

    this.store.dispatch(
      PlaylistActions.updatePlaylistMeta({
        playlist: {
          _id: playlistId,
          recentlyViewed: updatedPlaylist?.recentlyViewed ?? [],
        } as PlaylistMeta,
      }),
    );
  }

  async clearRecentChannels(): Promise<void> {
    const playlistId = this.resolvedPlaylistId();
    if (!playlistId) {
      return;
    }

    const updatedPlaylist = await firstValueFrom(
      this.playlistsService.clearM3uRecentlyViewed(playlistId),
    );

    this.store.dispatch(
      PlaylistActions.updatePlaylistMeta({
        playlist: {
          _id: playlistId,
          recentlyViewed: updatedPlaylist?.recentlyViewed ?? [],
        } as PlaylistMeta,
      }),
    );
  }

  onSidebarWidthRequested(width: number): void {
    this.sidebarWidthRequested.emit(width);
  }

  onSidebarWidthRequestEnded(width: number): void {
    this.sidebarWidthRequestEnded.emit(width);
  }
}
