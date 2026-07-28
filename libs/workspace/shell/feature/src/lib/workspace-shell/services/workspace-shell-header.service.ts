import { computed, inject, Injectable } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { Router } from "@angular/router";
import { Store } from "@ngrx/store";
import { toSignal } from "@angular/core/rxjs-interop";
import { TranslateService } from "@ngx-translate/core";
import { firstValueFrom, startWith } from "rxjs";
import {
  PlaylistInfoComponent,
  PlaylistRefreshActionService,
} from "@arm-nator/providers/shared/playlist-ui";
import {
  WorkspaceHeaderAction,
  WorkspaceHeaderContextService,
} from "@arm-nator/providers/shared/util";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { PlaylistsService } from "@arm-nator/services";
import { PlaylistActions } from "@arm-nator/providers/m3u/state";
import { PlaylistMeta } from "@arm-nator/shared/interfaces";
import {
  WorkspaceAccountInfoData,
  WorkspacePortalContext,
  WORKSPACE_SHELL_ACTIONS,
} from "@arm-nator/workspace/shell/util";
import {
  CLEAR_RECENTLY_VIEWED_ARIA,
  CLEAR_RECENTLY_VIEWED_TOOLTIP,
  WorkspaceHeaderBulkAction,
} from "./helpers/workspace-shell-constants";
import { bumpRefreshQueryParam } from "./helpers/workspace-shell-route-utils";
import { WorkspaceShellRouteStateService } from "./workspace-shell-route-state.service";

@Injectable()
export class WorkspaceShellHeaderService {
  private readonly router = inject(Router);
  private readonly store = inject(Store);
  private readonly xtreamStore = inject(XtreamStore);
  private readonly playlistsService = inject(PlaylistsService);
  private readonly workspaceActions = inject(WORKSPACE_SHELL_ACTIONS);
  private readonly translate = inject(TranslateService);
  private readonly dialog = inject(MatDialog);
  private readonly routeState = inject(WorkspaceShellRouteStateService);
  private readonly headerContext = inject(WorkspaceHeaderContextService);
  private readonly playlistRefreshAction = inject(PlaylistRefreshActionService);

  private readonly languageTick = toSignal(
    this.translate.onLangChange.pipe(startWith(null)),
    { initialValue: null },
  );

  readonly playlistTitle = computed(() => {
    if (this.routeState.currentRoute().kind === "tool") {
      return "Direct Play";
    }

    const playlist = this.routeState.activePlaylist();

    return (
      playlist?.title ||
      playlist?.filename ||
      playlist?.url ||
      playlist?.portalUrl ||
      "Untitled playlist"
    );
  });
  readonly headerShortcut = computed<WorkspaceHeaderAction | null>(() => {
    const context = this.routeState.currentContext();
    const action = this.headerContext.action();

    if (!action || context?.provider !== "playlists") {
      return null;
    }

    return action;
  });
  readonly canOpenPlaylistInfo = computed(
    () =>
      this.routeState.currentRoute().kind !== "tool" &&
      Boolean(this.routeState.activePlaylist()),
  );
  readonly canOpenAccountInfo = computed(() =>
    Boolean(this.routeState.activePlaylist()?.serverUrl),
  );
  readonly canRefreshPlaylist = computed(
    () =>
      this.routeState.currentRoute().kind !== "tool" &&
      this.playlistRefreshAction.canRefresh(this.routeState.activePlaylist()),
  );
  readonly isRefreshingPlaylist = this.playlistRefreshAction.isRefreshing;
  readonly headerBulkAction = computed<WorkspaceHeaderBulkAction | null>(() => {
    this.languageTick();

    const context = this.routeState.currentContext();
    const section = this.routeState.currentSection();

    if (!context || section !== "recent") {
      return null;
    }

    if (context.provider !== "xtreams" && context.provider !== "playlists") {
      return null;
    }

    return {
      icon: "delete_sweep",
      tooltip: this.translateText(CLEAR_RECENTLY_VIEWED_TOOLTIP),
      ariaLabel: this.translateText(CLEAR_RECENTLY_VIEWED_ARIA),
      disabled: this.isRecentCleanupDisabled(context.provider),
    };
  });
  readonly playlistSubtitle = computed(() => {
    this.languageTick();

    if (this.routeState.currentRoute().kind === "tool") {
      return "Playback tool";
    }

    const active = this.routeState.activePlaylist();
    if (active?.serverUrl) {
      return this.translateText("WORKSPACE.SHELL.XTREAM_CODE");
    }
    if (active?.count) {
      return this.translateText("WORKSPACE.SHELL.CHANNELS_COUNT", {
        count: active.count,
      });
    }

    const sourcesCount = this.routeState.playlists().length;
    if (sourcesCount === 0) {
      return this.translateText("WORKSPACE.SHELL.NO_SOURCES_AVAILABLE");
    }
    if (sourcesCount === 1) {
      return this.translateText("WORKSPACE.SHELL.ONE_SOURCE_AVAILABLE");
    }
    return this.translateText("WORKSPACE.SHELL.SOURCES_AVAILABLE", {
      count: sourcesCount,
    });
  });

  openAddPlaylistDialog(kind?: "url" | "xtream"): void {
    if (kind) {
      this.workspaceActions.openAddPlaylistDialog(kind);
      return;
    }

    this.workspaceActions.openAddPlaylistDialog();
  }

  openGlobalSearch(initialQuery = ""): void {
    this.workspaceActions.openGlobalSearch(initialQuery);
  }

  openGlobalRecent(): void {
    this.workspaceActions.openGlobalRecent();
  }

  async runHeaderBulkAction(): Promise<void> {
    const context = this.routeState.currentContext();
    const section = this.routeState.currentSection();

    if (!context || section !== "recent") {
      return;
    }

    if (context.provider === "xtreams") {
      this.xtreamStore.clearRecentItems({ id: context.playlistId });
      return;
    }

    if (context.provider === "playlists") {
      const updatedPlaylist = await firstValueFrom(
        this.playlistsService.clearM3uRecentlyViewed(context.playlistId),
      );
      this.store.dispatch(
        PlaylistActions.updatePlaylistMeta({
          playlist: {
            _id: context.playlistId,
            recentlyViewed: updatedPlaylist?.recentlyViewed ?? [],
          } as PlaylistMeta,
        }),
      );
      bumpRefreshQueryParam(this.router, this.routeState.currentUrl());
    }
  }

  navigateToGlobalFavorites(): void {
    void this.router.navigate(["/workspace/global-favorites"]);
  }

  runHeaderShortcut(): void {
    this.headerShortcut()?.run();
  }

  openPlaylistInfo(): void {
    const playlist = this.routeState.activePlaylist();
    if (!playlist) {
      return;
    }

    this.dialog.open(PlaylistInfoComponent, {
      data: playlist,
    });
  }

  openAccountInfo(): void {
    if (!this.canOpenAccountInfo()) {
      return;
    }

    const data: WorkspaceAccountInfoData = {
      vodStreamsCount: this.xtreamStore.vodStreams().length,
      liveStreamsCount: this.xtreamStore.liveStreams().length,
      seriesCount: this.xtreamStore.serialStreams().length,
    };
    this.workspaceActions.openAccountInfo(data);
  }

  refreshCurrentPlaylist(): void {
    const playlist = this.routeState.activePlaylist();

    if (!playlist || !this.canRefreshPlaylist()) {
      return;
    }

    this.playlistRefreshAction.refresh(playlist);
  }

  private isRecentCleanupDisabled(
    provider: WorkspacePortalContext["provider"],
  ): boolean {
    if (provider === "xtreams") {
      return this.xtreamStore.recentItems().length === 0;
    }

    if (provider === "playlists") {
      return (
        (this.routeState.activePlaylist()?.recentlyViewed?.length ?? 0) === 0
      );
    }

    return false;
  }

  private translateText(
    key: string,
    params?: Record<string, string | number>,
  ): string {
    return this.translate.instant(key, params);
  }
}
