import { InjectionToken } from "@angular/core";
import {
  ExternalPlayerSession,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";

/**
 * Application-facing playback boundary. Features call this contract and do
 * not import ArtPlayer, HTML5, embedded MPV, external MPV, or VLC internals.
 */
export interface PlayerFacade {
  isEmbeddedPlayer(): boolean;
  openPlayer(
    streamUrl: string,
    title: string,
    thumbnail?: string | null,
    hideExternalInfoDialog?: boolean,
    isLiveContent?: boolean,
    userAgent?: string,
    referer?: string,
    origin?: string,
    contentInfo?: unknown,
    startTime?: number,
    headers?: Record<string, string>,
  ): Promise<ExternalPlayerSession | void>;
  openResolvedPlayback(
    playback: ResolvedPortalPlayback,
    hideExternalInfoDialog?: boolean,
  ): Promise<ExternalPlayerSession | void>;
  openExternalPlayback(
    playback: ResolvedPortalPlayback,
    player: ExternalPlayerName,
  ): Promise<ExternalPlayerSession | void>;
}

export const PLAYER_FACADE = new InjectionToken<PlayerFacade>("PLAYER_FACADE");
