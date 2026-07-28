import { Injectable, inject } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { ExternalPlayerInfoDialogComponent } from "@arm-nator/player/ui/external-player-info-dialog";
import { DataService } from "@arm-nator/services";
import {
  ExternalPlayerSession,
  OPEN_MPV_PLAYER,
  OPEN_VLC_PLAYER,
  PlayerContentInfo,
  ResolvedPortalPlayback,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";
import { isInlinePlayer, PlayerFacade } from "@arm-nator/player/core";
import { SettingsStore } from "./settings-store.service";

@Injectable({
  providedIn: "root",
})
export class PlayerService implements PlayerFacade {
  private dialog = inject(MatDialog);
  private dataService = inject(DataService);
  private settingsStore = inject(SettingsStore);

  isEmbeddedPlayer(
    player = this.settingsStore.player() ?? VideoPlayer.ArtPlayer,
  ): boolean {
    return isInlinePlayer(player);
  }

  openPlayer(
    streamUrl: string,
    title: string,
    thumbnail?: string | null,
    hideExternalInfoDialog = true,
    isLiveContent = false,
    userAgent?: string,
    referer?: string,
    origin?: string,
    contentInfo?: unknown,
    startTime?: number,
    headers?: Record<string, string>,
  ): Promise<ExternalPlayerSession | void> {
    return this.openResolvedPlayback(
      {
        streamUrl,
        title,
        thumbnail,
        isLive: isLiveContent,
        startTime,
        contentInfo: contentInfo as PlayerContentInfo | undefined,
        headers,
        userAgent,
        referer,
        origin,
      },
      hideExternalInfoDialog,
    );
  }

  async openResolvedPlayback(
    playback: ResolvedPortalPlayback,
    hideExternalInfoDialog = true,
  ): Promise<ExternalPlayerSession | void> {
    const player = this.settingsStore.player() ?? VideoPlayer.ArtPlayer;

    if (player === VideoPlayer.MPV) {
      if (!hideExternalInfoDialog) {
        this.dialog.open(ExternalPlayerInfoDialogComponent);
      }
      return await this.openExternalPlayback(playback, "mpv");
    } else if (player === VideoPlayer.VLC) {
      if (!hideExternalInfoDialog) {
        this.dialog.open(ExternalPlayerInfoDialogComponent);
      }
      return await this.openExternalPlayback(playback, "vlc");
    }

    return;
  }

  async openExternalPlayback(
    playback: ResolvedPortalPlayback,
    player: ExternalPlayerName,
  ): Promise<ExternalPlayerSession | void> {
    const ipcEvent = player === "mpv" ? OPEN_MPV_PLAYER : OPEN_VLC_PLAYER;

    return await this.dataService.sendIpcEvent<ExternalPlayerSession>(
      ipcEvent,
      {
        url: playback.streamUrl,
        title: playback.title,
        thumbnail: playback.thumbnail,
        "user-agent": playback.userAgent,
        referer: playback.referer,
        origin: playback.origin,
        headers: playback.headers,
        contentInfo: playback.contentInfo,
        startTime: playback.startTime,
      },
    );
  }
}
