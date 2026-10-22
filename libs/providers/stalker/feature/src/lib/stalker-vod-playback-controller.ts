import { withPlaybackIntent } from "@arm-nator/player/core";
import type { WritableSignal } from '@angular/core';
import type { MatSnackBar } from '@angular/material/snack-bar';
import type { TranslateService } from '@ngx-translate/core';
import type {
    Logger,
    PortalPlaybackPositions,
    PortalPlayer,
} from '@arm-nator/providers/shared/util';
import type { PlaybackFallbackRequest } from '@arm-nator/player/ui';
import {
    createStalkerPlaybackRecoveryContext,
    type StalkerPlaybackResolver,
} from './stalker-playback-recovery';
import {
    PlaybackPositionData,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';

interface StalkerVodPlaybackControllerConfig {
    inlinePlayback: WritableSignal<ResolvedPortalPlayback | null>;
    selectedVodPosition: WritableSignal<PlaybackPositionData | null>;
    playbackPositions: PortalPlaybackPositions;
    portalPlayer: PortalPlayer;
    snackBar: MatSnackBar;
    translateService: TranslateService;
    logger: Logger;
    playbackErrorLogMessage: string;
    playbackOwnerKey?: () => string;
}

export class StalkerVodPlaybackController {
  private lastInlineSaveTime = 0;
  private loadSelectedVodPositionRequestId = 0;
  private playbackRequestId = 0;
  private playbackRequestController: AbortController | null = null;

  constructor(private readonly config: StalkerVodPlaybackControllerConfig) {}

  async startVodPlayback(
    resolvePlayback: (signal?: AbortSignal) => Promise<ResolvedPortalPlayback>,
    recoveryResolver?: StalkerPlaybackResolver,
  ): Promise<void> {
    return withPlaybackIntent(this.config.portalPlayer, async () => {
      this.playbackRequestController?.abort();
      const controller = new AbortController();
      this.playbackRequestController = controller;
      const requestId = ++this.playbackRequestId;
      const usesEmbeddedPlayer = this.config.portalPlayer.isEmbeddedPlayer();
      const playbackOwnerKey = this.config.playbackOwnerKey?.();
      try {
        const playback = await resolvePlayback(controller.signal);
        if (
          controller.signal.aborted ||
          !this.isPlaybackRequestCurrent(requestId, playbackOwnerKey)
        ) {
          return;
        }

        const recoveryContext = recoveryResolver
          ? createStalkerPlaybackRecoveryContext(playback, recoveryResolver)
          : {};
        this.lastInlineSaveTime = 0;
        if (usesEmbeddedPlayer) {
          this.config.inlinePlayback.set(playback);
          return;
        }

        this.closeInlinePlayer();
        await this.config.portalPlayer.openResolvedPlayback(playback, true, {
          ...recoveryContext,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          !this.isPlaybackRequestCurrent(requestId, playbackOwnerKey)
        ) {
          return;
        }
        this.config.logger.error(this.config.playbackErrorLogMessage, error);
        const errorMessage =
          error instanceof Error && error.message === "nothing_to_play"
            ? this.config.translateService.instant(
                "PORTALS.CONTENT_NOT_AVAILABLE",
              )
            : this.config.translateService.instant("PORTALS.PLAYBACK_ERROR");
        this.config.snackBar.open(errorMessage, undefined, {
          duration: 3000,
        });
      }
    });
  }

  async loadSelectedVodPosition(
    playlistId: string,
    vodId: number,
  ): Promise<void> {
    const requestId = ++this.loadSelectedVodPositionRequestId;

    if (!playlistId || !Number.isFinite(vodId)) {
      this.config.selectedVodPosition.set(null);
      return;
    }

    const position = await this.config.playbackPositions.getPlaybackPosition(
      playlistId,
      vodId,
      "vod",
    );
    if (requestId !== this.loadSelectedVodPositionRequestId) {
      return;
    }

    this.config.selectedVodPosition.set(position ?? null);
  }

  handleInlineTimeUpdate(event: {
    currentTime: number;
    duration: number;
    persistenceHandled?: boolean;
  }): void {
    const playback = this.config.inlinePlayback();
    if (!playback?.contentInfo) {
      return;
    }

    if (event.persistenceHandled) {
      this.config.selectedVodPosition.set({
        ...playback.contentInfo,
        positionSeconds: event.currentTime,
        durationSeconds: event.duration > 0 ? event.duration : undefined,
      });
      return;
    }
    const now = Date.now();
    if (now - this.lastInlineSaveTime <= 15000) {
      return;
    }

    this.lastInlineSaveTime = now;
    const position: PlaybackPositionData = {
      ...playback.contentInfo,
      positionSeconds: event.currentTime,
      durationSeconds: event.duration,
    };

    void this.config.playbackPositions.savePlaybackPosition(
      playback.contentInfo.playlistId,
      position,
    );
    this.config.selectedVodPosition.set(position);
  }

  closeInlinePlayer(): void {
    this.playbackRequestId += 1;
    this.playbackRequestController?.abort();
    this.playbackRequestController = null;
    this.config.inlinePlayback.set(null);
    this.lastInlineSaveTime = 0;
  }

  private isPlaybackRequestCurrent(
    requestId: number,
    playbackOwnerKey: string | undefined,
  ): boolean {
    return (
      requestId === this.playbackRequestId &&
      (this.config.playbackOwnerKey === undefined ||
        this.config.playbackOwnerKey() === playbackOwnerKey)
    );
  }

  showCopyNotification(): void {
    this.config.snackBar.open(
      this.config.translateService.instant("PORTALS.STREAM_URL_COPIED"),
      undefined,
      {
        duration: 2000,
      },
    );
  }

  handleExternalFallbackRequest(request: PlaybackFallbackRequest): void {
    const launch = this.config.portalPlayer.openExternalPlayback(
      request.playback,
      request.player,
    );
    request.trackLaunch(launch);
    void launch;
  }
}
