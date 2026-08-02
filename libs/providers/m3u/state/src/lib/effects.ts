/* eslint-disable max-lines */
import { inject, Injectable } from "@angular/core";
import { MatSnackBar } from "@angular/material/snack-bar";
import { Router } from "@angular/router";
import { isDashChannel, isDashStreamUrl } from "@arm-nator/providers/m3u/utils";
import { Actions, createEffect, ofType } from "@ngrx/effects";
import { Store } from "@ngrx/store";
import { StorageMap } from "@ngx-pwa/local-storage";
import { TranslateService } from "@ngx-translate/core";
import {
  EMPTY,
  filter,
  firstValueFrom,
  from,
  map,
  mergeMap,
  switchMap,
  tap,
  withLatestFrom,
} from "rxjs";
import {
  DataService,
  PlaylistsService,
  SettingsStore,
} from "@arm-nator/services";
import {
  OPEN_MPV_PLAYER,
  OPEN_VLC_PLAYER,
  Channel,
  Playlist,
  PlaylistMeta,
  STORE_KEY,
  VideoPlayer,
  Settings,
} from "@arm-nator/shared/interfaces";
import { ChannelActions, FavoritesActions, PlaylistActions } from "./actions";
import {
  selectActive,
  selectActivePlaylistId,
  selectChannels,
  selectFavorites,
} from "./selectors";
import {
  buildExternalPlayerPayload,
  shouldAutoLaunchExternalPlayer,
} from "./external-player-payload.util";
import { persistPlaylistUpdate } from "./playlist-update.effect-handler";

@Injectable({ providedIn: "any" })
export class PlaylistEffects {
  private actions$ = inject(Actions);
  private playlistsService = inject(PlaylistsService);
  private dataService = inject(DataService);
  private router = inject(Router);
  private snackBar = inject(MatSnackBar);
  private storage = inject(StorageMap);
  private store = inject(Store);
  private translate = inject(TranslateService);
  private settingsStore = inject(SettingsStore);

  updateFavorites$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(FavoritesActions.updateFavorites),
        withLatestFrom(
          this.store.select(selectFavorites),
          this.store.select(selectActivePlaylistId),
        ),
        filter(([, , playlistId]) => !!playlistId),
        switchMap(([, favorites, playlistId]) =>
          this.playlistsService.updateFavorites(playlistId, favorites),
        ),
        tap(() => {
          this.snackBar.open(
            this.translate.instant("CHANNELS.FAVORITES_UPDATED"),
            undefined,
            { duration: 2000 },
          );
        }),
      );
    },
    { dispatch: false },
  );

  setFavorites$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(FavoritesActions.setFavorites),
        withLatestFrom(this.store.select(selectActivePlaylistId)),
        filter(([, playlistId]) => !!playlistId),
        switchMap(([action, playlistId]) =>
          this.playlistsService.setFavorites(playlistId, action.channelIds),
        ),
      );
    },
    {
      dispatch: false,
    },
  );

  setActiveChannel$ = createEffect(() => {
    return this.actions$.pipe(
      ofType(ChannelActions.setActiveChannel),
      // Skip the effect entirely when channel is falsy
      filter((action) => !!action.channel),
      map((action) => {
        const { channel } = action;

        void window.electron
          ?.setUserAgent(
            channel.http?.["user-agent"],
            channel.http?.referrer,
            channel.url,
          )
          ?.catch((error: unknown) => {
            console.warn(
              "[PlaylistEffects] Failed to configure Electron request headers:",
              error,
            );
          });

        firstValueFrom(
          this.storage.get<Partial<Settings> | undefined>(STORE_KEY.Settings, {
            type: "object",
            properties: {},
          }),
        ).then((settings) => {
          if (!settings || Object.keys(settings).length === 0) {
            return;
          }

          if (
            shouldAutoLaunchExternalPlayer(
              settings as any,
              action.startPlayback,
              channel,
              VideoPlayer.MPV,
            )
          ) {
            this.dataService.sendIpcEvent(OPEN_MPV_PLAYER, {
              url: channel.url,
              title: channel.name ?? "",
              "user-agent": channel.http["user-agent"],
              referer: channel.http.referrer,
              origin: channel.http.origin,
            });
          } else if (
            shouldAutoLaunchExternalPlayer(
              settings as any,
              action.startPlayback,
              channel,
              VideoPlayer.VLC,
            )
          ) {
            this.dataService.sendIpcEvent(OPEN_VLC_PLAYER, {
              url: channel.url,
              title: channel.name ?? "",
              "user-agent": channel.http["user-agent"],
              referer: channel.http.referrer,
              origin: channel.http.origin,
            });
          }
        });

        return ChannelActions.setActiveChannelSuccess({
          channel: action.channel,
        });
      }),
    );
  });

  loadPlaylists$ = createEffect(() => {
    return this.actions$.pipe(
      ofType(PlaylistActions.loadPlaylists),
      switchMap(() =>
        this.playlistsService.getAllPlaylists().pipe(
          map((playlists) =>
            PlaylistActions.loadPlaylistsSuccess({
              playlists,
            }),
          ),
        ),
      ),
    );
  });

  private async openWithConfiguredExternalPlayer(
    playbackUrl: string,
    activeChannel: Channel | undefined | null,
  ): Promise<void> {
    if (isDashStreamUrl(playbackUrl) || isDashChannel(activeChannel)) {
      return;
    }

    const payload = buildExternalPlayerPayload(activeChannel, playbackUrl);
    if (!payload) {
      return;
    }

    const settings = (await firstValueFrom(
      this.storage.get(STORE_KEY.Settings),
    )) as Partial<Settings> | undefined;
    if (!settings || Object.keys(settings).length === 0) {
      return;
    }
    const player = settings.player as VideoPlayer | undefined;
    if (player === VideoPlayer.MPV) {
      this.dataService.sendIpcEvent(OPEN_MPV_PLAYER, payload);
      return;
    }

    if (player === VideoPlayer.VLC) {
      this.dataService.sendIpcEvent(OPEN_VLC_PLAYER, payload);
    }
  }

  removePlaylist$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.removePlaylist),
        switchMap(async (action) => {
          await firstValueFrom(
            this.playlistsService.deletePlaylist(action.playlistId),
          );
        }),
      );
    },
    { dispatch: false },
  );

  updatePlaylist$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.updatePlaylist),
        switchMap((action) =>
          persistPlaylistUpdate(this.playlistsService, action),
        ),
      );
    },
    { dispatch: false },
  );

  parsePlaylist$ = createEffect(() => {
    return this.actions$.pipe(
      ofType(PlaylistActions.parsePlaylist),
      mergeMap((action) =>
        from(
          this.playlistsService.handlePlaylistParsing(
            action.uploadType,
            action.playlist,
            action.title,
            action.path,
          ),
        ),
      ),
      map((playlist) =>
        PlaylistActions.addPlaylist({
          playlist,
        }),
      ),
    );
  });

  addPlaylist$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(
          PlaylistActions.addPlaylist,
          PlaylistActions.handleAddingPlaylistByUrl,
        ),
        switchMap((action) => {
          if ("isTemporary" in action && action.isTemporary) {
            return EMPTY;
          }
          return this.playlistsService
            .addPlaylist(action.playlist)
            .pipe(tap(() => this.navigateToPlaylist(action.playlist)));
        }),
      );
    },
    { dispatch: false },
  );

  updatePlaylistMeta$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.updatePlaylistMeta),
        switchMap((action) => {
          const playlistMeta = {
            ...(action.playlist as Partial<PlaylistMeta>),
            count: (action.playlist as Partial<PlaylistMeta>).count ?? 0,
          } as PlaylistMeta;
          return this.playlistsService.updatePlaylistMeta(playlistMeta);
        }),
      );
    },
    { dispatch: false },
  );

  updatePlaylistPositions$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.updatePlaylistPositions),
        switchMap((action) =>
          this.playlistsService.updatePlaylistPositions(action.positionUpdates),
        ),
      );
    },
    { dispatch: false },
  );

  addManyPlaylists$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.addManyPlaylists),
        switchMap((action) =>
          this.playlistsService.addManyPlaylists(action.playlists),
        ),
      );
    },
    { dispatch: false },
  );

  updateManyPlaylists$ = createEffect(
    () => {
      return this.actions$.pipe(
        ofType(PlaylistActions.updateManyPlaylists),
        switchMap((action) =>
          this.playlistsService.updateManyPlaylists(action.playlists),
        ),
      );
    },
    { dispatch: false },
  );

  setAdjacentChannelAsActive$ = createEffect(() => {
    return this.actions$.pipe(
      ofType(ChannelActions.setAdjacentChannelAsActive),
      withLatestFrom(
        this.store.select(selectChannels),
        this.store.select(selectActive),
      ),
      filter(([, , activeChannel]) => activeChannel != null),
      map(([action, channels, activeChannel]) => {
        const activeChannelSafe = activeChannel as Channel;
        let adjacentChannel: Channel = activeChannelSafe;
        const index = channels.findIndex(
          (channel) => channel.id === activeChannelSafe.id,
        );
        if (action.direction === "next") {
          if (index !== channels.length - 1)
            adjacentChannel = channels[index + 1];
        } else if (action.direction === "previous") {
          if (index > 0) adjacentChannel = channels[index - 1];
        }
        return ChannelActions.setActiveChannelSuccess({
          channel: adjacentChannel,
        });
      }),
    );
  });

  private navigateToPlaylist(playlist: Playlist): void {
    if (playlist.serverUrl) {
      void this.router.navigate(["/workspace", "xtreams", playlist._id]);
      return;
    }

    void this.router.navigate(["/workspace", "playlists", playlist._id]);
  }
}
