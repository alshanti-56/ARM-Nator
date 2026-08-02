/* eslint-disable max-lines */
import { AsyncPipe, CommonModule } from "@angular/common";
import {
  Component,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { toObservable, toSignal } from "@angular/core/rxjs-interop";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { ActivatedRoute, Router } from "@angular/router";
import { Store } from "@ngrx/store";
import { StorageMap } from "@ngx-pwa/local-storage";
import { TranslatePipe } from "@ngx-translate/core";
import { ResizableDirective } from "@arm-nator/ui/components";
import {
  applyChannelNameStrip,
  extractDrmFromRaw,
  isDashChannel,
} from "@arm-nator/providers/m3u/utils";
import { PlaylistContextFacade } from "@arm-nator/providers/shared/playlist-util";
import {
  ChannelActions,
  PlaylistActions,
  buildExternalPlayerPayload,
  selectActive,
  selectChannels,
  selectChannelsLoading,
} from "@arm-nator/providers/m3u/state";
import { firstValueFrom, Observable, map, take } from "rxjs";
import {
  getChannelItemByNumber,
  isTypingInInput,
  isWorkspaceLayoutRoute,
  LiveSidebarState,
  persistLiveSidebarState,
  PORTAL_EXTERNAL_PLAYBACK,
  PORTAL_PLAYER,
  restoreLiveSidebarState,
} from "@arm-nator/providers/shared/util";
import { PortalEmptyStateComponent } from "@arm-nator/providers/shared/ui";
import {
  AudioPlayerComponent,
  type PlaybackFallbackRequest,
  SidebarComponent,
} from "@arm-nator/player/ui";
import { ChannelListLoadingStateComponent } from "@arm-nator/ui/components";
import {
  DataService,
  PlaylistsService,
  RuntimeCapabilitiesService,
  SettingsStore,
} from "@arm-nator/services";
import {
  Channel,
  createDevLogger,
  ExternalPlayerSession,
  OPEN_MPV_PLAYER,
  OPEN_VLC_PLAYER,
  PLAYLIST_PARSE_BY_URL,
  M3uRecentlyViewedItem,
  PlaylistMeta,
  ResolvedPortalPlayback,
  STORE_KEY,
  Settings,
  VideoPlayer,
  normalizeVideoPlayer,
} from "@arm-nator/shared/interfaces";
import { createM3uChannelPlaybackRequest } from "./m3u-channel-playback-actions";

const M3U_SIDEBAR_STORAGE_KEY = "m3u-sidebar-width";
const M3U_GROUPS_SIDEBAR_STORAGE_KEY = "m3u-groups-sidebar-width";
const M3U_SIDEBAR_MIN_WIDTH = 200;
const M3U_SIDEBAR_MAX_WIDTH = 600;
const M3U_SIDEBAR_DEFAULT_WIDTH = 460;

@Component({
  selector: "app-video-player",
  imports: [
    AsyncPipe,
    AudioPlayerComponent,
    ChannelListLoadingStateComponent,
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    PortalEmptyStateComponent,
    ResizableDirective,
    SidebarComponent,
    TranslatePipe,
  ],
  templateUrl: "./video-player.component.html",
  styleUrl: "./video-player.component.scss",
})
export class VideoPlayerComponent implements OnInit, OnDestroy {
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly dataService = inject(DataService);
  private readonly playlistsService = inject(PlaylistsService);
  private readonly playlistContext = inject(PlaylistContextFacade);
  private readonly router = inject(Router);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly storage = inject(StorageMap);
  private readonly store = inject(Store);
  private readonly externalPlayback = inject(PORTAL_EXTERNAL_PLAYBACK);
  private readonly portalPlayer = inject(PORTAL_PLAYER);
  private readonly debugLog = createDevLogger("VideoPlayerComponent");

  /** Active selected channel */
  readonly activeChannel = this.store.selectSignal(selectActive);
  readonly activePlaylistId = this.playlistContext.resolvedPlaylistId;
  readonly channels = this.store.selectSignal(selectChannels);
  readonly channelsLoading = this.store.selectSignal(selectChannelsLoading);
  /**
   * DASH (.mpd) playback always runs inline via the Shaka engine. True when
   * either the channel itself or the resolved catch-up URL is DASH —
   * mirroring the external-player guard in the m3u-state effects, so a
   * DASH-flavored session can never end up with no player at all.
   */
  readonly activeChannelIsDash = computed(() =>
    isDashChannel(this.activeChannel()),
  );
  /**
   * Player forced for DASH channels: ArtPlayer keeps ArtPlayer (it has a
   * Shaka source engine); embedded/external MPV and VLC (no KODIPROP
   * ClearKey support) fall back to the HTML5 player.
   */
  readonly dashPlayerOverride = computed<VideoPlayer>(() =>
    this.settingsStore.player() === VideoPlayer.ArtPlayer
      ? VideoPlayer.ArtPlayer
      : VideoPlayer.Html5Player,
  );
  /** Channel name for the radio player header. */
  readonly displayChannelName = computed(() => {
    const channel = this.activeChannel();
    return applyChannelNameStrip(
      channel?.name || channel?.tvg?.name,
      this.settingsStore.stripCountryPrefix?.(),
    );
  });
  /** Display title for the inline web player header. */
  readonly inlinePlayerTitle = computed(() =>
    applyChannelNameStrip(
      this.embeddedPlayback()?.title,
      this.settingsStore.stripCountryPrefix?.(),
    ),
  );
  readonly playbackChannel = computed<Channel | null>(() => {
    const activeChannel = this.activeChannel();
    if (!activeChannel) {
      return null;
    }

    return activeChannel;
  });
  readonly embeddedPlayback = computed<ResolvedPortalPlayback | null>(() => {
    const activeChannel = this.activeChannel();
    const playbackTarget = this.playbackChannel();

    if (!activeChannel || !playbackTarget) {
      return null;
    }

    const http: Partial<Channel["http"]> = playbackTarget.http ?? {};
    const headers: Record<string, string> = {};
    if (http["user-agent"]) {
      headers["User-Agent"] = http["user-agent"];
    }
    if (http.referrer) {
      headers["Referer"] = http.referrer;
    }
    if (http.origin) {
      headers["Origin"] = http.origin;
    }

    return {
      streamUrl: playbackTarget.url,
      title:
        activeChannel.name?.trim() ||
        activeChannel.tvg?.name ||
        playbackTarget.url,
      thumbnail: activeChannel.tvg?.logo ?? null,
      isLive: true,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      userAgent: http["user-agent"] || undefined,
      referer: http.referrer || undefined,
      origin: http.origin || undefined,
      // Playlists imported before the DRM feature carry no drm field
      // yet, but their raw KODIPROP block survived in the stored items
      // — extract lazily so they work without a re-import.
      drm: playbackTarget.drm ?? extractDrmFromRaw(playbackTarget.raw),
    };
  });
  readonly sidebarStorageKey = computed(() =>
    this.activeView() === "groups"
      ? M3U_GROUPS_SIDEBAR_STORAGE_KEY
      : M3U_SIDEBAR_STORAGE_KEY,
  );
  readonly sidebarWidth = signal(M3U_SIDEBAR_DEFAULT_WIDTH);
  readonly sidebarMinWidth = M3U_SIDEBAR_MIN_WIDTH;
  readonly sidebarMaxWidth = M3U_SIDEBAR_MAX_WIDTH;
  readonly liveSidebarState = signal<LiveSidebarState>(
    restoreLiveSidebarState(),
  );
  readonly isSidebarCollapsed = computed(
    () => this.liveSidebarState() === "collapsed",
  );

  /** Channels list */
  readonly channels$: Observable<Channel[]> = this.store.select(
    selectChannels,
  ) as Observable<Channel[]>;

  /** Active M3U view (all, groups, favorites, recent) */
  readonly activeView = toSignal(
    this.activatedRoute.params.pipe(map((params) => params["view"] || "all")),
    { initialValue: "all" },
  );

  /** Selected video player options */
  playerSettings: Partial<Settings> = {
    player: VideoPlayer.ArtPlayer,
  };

  readonly isDesktop = this.runtime.isElectron;
  readonly isWorkspaceLayout = isWorkspaceLayoutRoute(this.activatedRoute);

  private lastKnownVolume = 1;
  private lastRecordedRecentKey = "";
  private lastExternalSessionStateKey = this.getExternalSessionStateKey(
    this.externalPlayback.activeSession(),
  );

  /** Channel number input state */
  channelNumberInput = "";
  showChannelNumberOverlay = false;
  private channelNumberTimeout?: number;

  readonly volume = signal(1);

  constructor() {
    // Initialize volume from localStorage in constructor
    const savedVolume = localStorage.getItem("volume");
    if (savedVolume !== null) {
      this.volume.set(Number(savedVolume));
    }

    // React to settings changes
    effect(() => {
      this.playerSettings = {
        player: this.settingsStore.player(),
      };
    });

    effect(() => {
      const channel = this.activeChannel();
      const playback = this.embeddedPlayback();
      if (
        !channel ||
        channel.radio === "true" ||
        !playback ||
        !this.shouldShowInlinePlayer(channel)
      ) {
        return;
      }
      const engine = this.activeChannelIsDash()
        ? this.dashPlayerOverride()
        : (this.playerSettings.player ?? VideoPlayer.ArtPlayer);
      this.portalPlayer.openInlinePlayback(playback, engine);
    });

    effect(() => {
      this.sidebarWidth.set(this.loadSidebarWidth(this.sidebarStorageKey()));
    });

    effect(() => {
      const playlistId = this.activePlaylistId();
      const activeChannel = this.activeChannel();

      if (!playlistId || !activeChannel?.url) {
        return;
      }

      const nextKey = `${playlistId}::${activeChannel.url}`;
      if (this.lastRecordedRecentKey === nextKey) {
        return;
      }

      this.lastRecordedRecentKey = nextKey;
      void this.persistRecentlyViewedChannel(playlistId, activeChannel);
    });

    effect(() => {
      const currentView = this.activeView();
      const channels = this.channels();
      const activeChannel = this.activeChannel();
      const state =
        this.router.currentNavigation()?.extras?.state ?? window.history.state;
      const recentTargetUrl =
        typeof state?.openRecentChannelUrl === "string"
          ? state.openRecentChannelUrl.trim()
          : "";
      const globalSearchTargetUrl =
        typeof state?.openM3uChannelUrl === "string"
          ? state.openM3uChannelUrl.trim()
          : "";
      const targetUrl = globalSearchTargetUrl || recentTargetUrl;
      const canOpenGlobalSearchTarget =
        !!globalSearchTargetUrl && currentView === "all";
      const canOpenRecentTarget = !!recentTargetUrl && currentView === "recent";

      if (
        (!canOpenGlobalSearchTarget && !canOpenRecentTarget) ||
        !targetUrl ||
        channels.length === 0
      ) {
        return;
      }

      if (activeChannel?.url === targetUrl) {
        this.clearConsumedChannelOpenState();
        return;
      }

      const matchedChannel = channels.find(
        (channel) => channel.url === targetUrl,
      );
      if (!matchedChannel) {
        return;
      }

      this.store.dispatch(
        ChannelActions.setActiveChannel({ channel: matchedChannel }),
      );
      this.clearConsumedChannelOpenState();
    });

    effect(() => {
      const player = this.settingsStore.player();
      const session = this.externalPlayback.activeSession();
      const activeChannel = this.activeChannel();
      const sessionStateKey = this.getExternalSessionStateKey(session);

      if (sessionStateKey === this.lastExternalSessionStateKey) {
        return;
      }

      this.lastExternalSessionStateKey = sessionStateKey;

      if (
        !activeChannel ||
        !this.isExternalPlayer(player) ||
        !this.isTerminalExternalSession(session)
      ) {
        return;
      }

      this.store.dispatch(ChannelActions.resetActiveChannel());
    });
  }

  /**
   * Sets video player and subscribes to channel list from the store
   */
  ngOnInit(): void {
    this.applySettings();
    this.getPlaylistUrlAsParam();
  }

  ngOnDestroy(): void {
    if (this.channelNumberTimeout) {
      clearTimeout(this.channelNumberTimeout);
    }
  }

  onSidebarWidthChange(width: number): void {
    this.sidebarWidth.set(this.clampSidebarWidth(width));
  }

  onSidebarResizeEnd(width: number): void {
    this.persistSidebarWidth(this.sidebarStorageKey(), width);
  }

  onGroupedSidebarWidthRequested(width: number): void {
    this.sidebarWidth.set(this.clampSidebarWidth(width));
  }

  onGroupedSidebarWidthRequestEnded(width: number): void {
    this.persistSidebarWidth(this.sidebarStorageKey(), width);
  }

  toggleSidebar(): void {
    const next: LiveSidebarState = this.isSidebarCollapsed()
      ? "expanded"
      : "collapsed";
    this.liveSidebarState.set(next);
    persistLiveSidebarState(next);
  }

  /**
   * Opens a playlist provided as a url param
   * e.g. iptvnat.or?url=http://...
   */
  getPlaylistUrlAsParam() {
    const URL_REGEX = /^(http|https|file):\/\/[^ "]+$/;
    const playlistUrl = this.activatedRoute.snapshot.queryParams["url"];

    if (playlistUrl && playlistUrl.match(URL_REGEX)) {
      this.dataService.sendIpcEvent(PLAYLIST_PARSE_BY_URL, {
        url: playlistUrl,
        isTemporary: true,
      });
    }
  }

  /**
   * Reads the app configuration from renderer storage and applies the settings in the current component
   */
  applySettings(): void {
    this.storage.get(STORE_KEY.Settings).subscribe((settings: unknown) => {
      if (settings && Object.keys(settings as Settings).length > 0) {
        this.playerSettings = {
          player: normalizeVideoPlayer((settings as Settings).player),
        };
      }
    });
  }

  private loadSidebarWidth(storageKey: string): number {
    const fallbackKey =
      storageKey === M3U_GROUPS_SIDEBAR_STORAGE_KEY
        ? M3U_SIDEBAR_STORAGE_KEY
        : "";
    const storedWidth = Number.parseInt(
      localStorage.getItem(storageKey) ??
        (fallbackKey ? localStorage.getItem(fallbackKey) : "") ??
        "",
      10,
    );

    return this.clampSidebarWidth(
      Number.isNaN(storedWidth) ? M3U_SIDEBAR_DEFAULT_WIDTH : storedWidth,
    );
  }

  private persistSidebarWidth(storageKey: string, width: number): void {
    const clampedWidth = this.clampSidebarWidth(width);
    this.sidebarWidth.set(clampedWidth);
    localStorage.setItem(storageKey, clampedWidth.toString());
  }

  private clampSidebarWidth(width: number): number {
    return Math.max(
      M3U_SIDEBAR_MIN_WIDTH,
      Math.min(M3U_SIDEBAR_MAX_WIDTH, width),
    );
  }

  private async persistRecentlyViewedChannel(
    playlistId: string,
    channel: Channel,
  ): Promise<void> {
    const recentlyViewedItem: M3uRecentlyViewedItem = {
      source: "m3u",
      id: channel.url,
      url: channel.url,
      title: channel.name?.trim() || channel.tvg?.name || channel.url,
      channel_id: channel.id,
      poster_url: channel.tvg?.logo || undefined,
      tvg_id: channel.tvg?.id || undefined,
      tvg_name: channel.tvg?.name || undefined,
      group_title: channel.group?.title || undefined,
      category_id: "live",
      added_at: new Date().toISOString(),
    };

    const updatedPlaylist = await firstValueFrom(
      this.playlistsService.addM3uRecentlyViewed(
        playlistId,
        recentlyViewedItem,
      ),
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

  private clearConsumedChannelOpenState(): void {
    const historyState = (window.history.state ?? {}) as Record<
      string,
      unknown
    >;
    if (
      !historyState["openRecentChannelUrl"] &&
      !historyState["openM3uChannelUrl"]
    ) {
      return;
    }

    try {
      const nextState = { ...historyState };
      delete nextState["openRecentChannelUrl"];
      delete nextState["openM3uChannelUrl"];
      window.history.replaceState(nextState, document.title);
    } catch {
      // no-op
    }
  }

  @HostListener("document:keydown", ["$event"])
  handleKeyPress(event: KeyboardEvent): void {
    if (isTypingInInput(event)) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      this.toggleSidebar();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    // Only handle digit keys (0-9)
    if (event.key >= "0" && event.key <= "9") {
      event.preventDefault();
      this.handleChannelNumberInput(event.key);
    }
  }

  /**
   * Handle channel number input from keyboard
   * Debounces input to allow multi-digit channel numbers
   */
  handleChannelNumberInput(digit: string): void {
    // Clear existing timeout
    if (this.channelNumberTimeout) {
      clearTimeout(this.channelNumberTimeout);
    }

    // Add digit to current input
    this.channelNumberInput += digit;
    this.showChannelNumberOverlay = true;

    // Set timeout to switch channel after 2 seconds of no input
    this.channelNumberTimeout = window.setTimeout(() => {
      this.switchToChannelByNumber(parseInt(this.channelNumberInput, 10));
      this.clearChannelNumberInput();
    }, 2000);
  }

  /**
   * Switch to channel by number (1-based index)
   */
  switchToChannelByNumber(channelNumber: number): void {
    this.channels$
      .pipe(
        take(1),
        map((channels) => getChannelItemByNumber(channels, channelNumber)),
      )
      .subscribe((channel) => {
        if (channel) {
          this.store.dispatch(createM3uChannelPlaybackRequest(channel));
        }
      });
  }

  /**
   * Clear channel number input and hide overlay
   */
  clearChannelNumberInput(): void {
    this.channelNumberInput = "";
    this.showChannelNumberOverlay = false;
    if (this.channelNumberTimeout) {
      clearTimeout(this.channelNumberTimeout);
      this.channelNumberTimeout = undefined;
    }
  }

  private setVolume(next: number): void {
    const clamped = Math.max(0, Math.min(1, Number(next.toFixed(2))));
    this.volume.set(clamped);
    if (clamped > 0) {
      this.lastKnownVolume = clamped;
    }
    localStorage.setItem("volume", String(clamped));
  }

  onInlineVolumeChange(volume: number): void {
    this.setVolume(volume);
  }

  shouldShowInlinePlayer(channel: Channel | null | undefined): boolean {
    if (!channel) {
      return false;
    }

    // DASH playback bypasses the external-player setting (radio
    // precedent): MPV/VLC cannot receive the KODIPROP ClearKey
    // configuration. Checked on the effective (possibly catch-up) URL.
    if (this.activeChannelIsDash()) {
      return true;
    }

    return !this.isExternalPlayer(this.playerSettings.player);
  }

  handleExternalFallbackRequest(request: PlaybackFallbackRequest): void {
    const payload = buildExternalPlayerPayload(
      this.activeChannel(),
      request.playback.streamUrl,
    );
    if (!payload) {
      return;
    }

    this.dataService.sendIpcEvent(
      request.player === "mpv" ? OPEN_MPV_PLAYER : OPEN_VLC_PLAYER,
      payload,
    );
  }

  private getExternalSessionStateKey(
    session: ExternalPlayerSession | null | undefined,
  ): string | null {
    if (!session) {
      return null;
    }

    return `${session.id}:${session.status}`;
  }

  private isExternalPlayer(
    player: VideoPlayer | null | undefined,
  ): player is VideoPlayer.MPV | VideoPlayer.VLC {
    return player === VideoPlayer.MPV || player === VideoPlayer.VLC;
  }

  private isTerminalExternalSession(
    session: ExternalPlayerSession | null | undefined,
  ): boolean {
    return session?.status === "closed" || session?.status === "error";
  }
}
