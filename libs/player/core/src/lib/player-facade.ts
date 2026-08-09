import { InjectionToken } from "@angular/core";
import {
  ExternalPlayerSession,
  ResolvedPortalPlayback,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";

export interface PlayerOpenContext {
  readonly canPrevious?: boolean;
  readonly canNext?: boolean;
  readonly autoplayNext?: boolean;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onEnded?: () => void;
  readonly onClosed?: () => void;
  readonly onTimeUpdate?: (event: {
    currentTime: number;
    duration: number;
  }) => void;
}

/**
 * Application-facing playback boundary. Features call this contract and do
 * not import ArtPlayer, HTML5, embedded MPV, external MPV, or VLC internals.
 */
export interface PlayerFacade {
  isEmbeddedPlayer(isLive?: boolean): boolean;
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
    context?: PlayerOpenContext,
  ): Promise<ExternalPlayerSession | void>;
  openInlinePlayback(
    playback: ResolvedPortalPlayback,
    engine?: VideoPlayer,
    context?: PlayerOpenContext,
  ): void;
  openExternalPlayback(
    playback: ResolvedPortalPlayback,
    player: ExternalPlayerName,
  ): Promise<ExternalPlayerSession | void>;
}

export const PLAYER_FACADE = new InjectionToken<PlayerFacade>("PLAYER_FACADE");
