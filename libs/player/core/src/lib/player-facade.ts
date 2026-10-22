import { InjectionToken } from "@angular/core";
import {
  ExternalPlayerSession,
  ResolvedPortalPlayback,
  PlaybackRecoveryIdentity,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";

export interface PlayerOpenContext {
  /** Resolves only; must not open playback, navigate, or select another item. */
  readonly resolvePlayback?: (request: {
    signal: AbortSignal;
    reason: "manual-retry" | "media-auth-failure";
  }) => Promise<ResolvedPortalPlayback>;
  /** Internal handoff: preserves selection-scoped recovery across source replacement. */
  readonly recoveryIdentity?: PlaybackRecoveryIdentity;
  readonly canPrevious?: boolean;
  readonly canNext?: boolean;
  readonly autoplayNext?: boolean;
  readonly onPrevious?: () => void;
  readonly onNext?: () => void;
  readonly onEnded?: () => void;
  readonly onClosed?: () => void;
  /** Re-resolve a short-lived provider URL before retrying playback. */
  readonly onRetry?: (signal: AbortSignal) => void | Promise<void>;
  readonly onTimeUpdate?: (event: {
    currentTime: number;
    duration: number;
    /** The workspace already persisted this confirmed sample; feature callbacks update local state only. */
    persistenceHandled?: boolean;
    action?: "progress" | "finished" | "reset";
  }) => void;
}

/**
 * Application-facing playback boundary. Features call this contract and do
 * not import ArtPlayer, HTML5, embedded MPV, external MPV, or VLC internals.
 */
export interface PlayerFacade {
  /** Hold foreground ownership from user intent through URL resolution and handoff. */
  withPlaybackIntent?<T>(action: () => Promise<T>): Promise<T>;
  isEmbeddedPlayer(isLive?: boolean): boolean;
  openAutomaticPlayback?(
    playback: ResolvedPortalPlayback,
    context?: PlayerOpenContext,
  ): Promise<void>;
  handleAutomaticDiagnostic?(issue: {
    attemptToken?: number;
    code: string;
    sourceUrl?: string;
  }): Promise<boolean>;
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
    transition?: number,
  ): Promise<void>;
  openExternalPlayback(
    playback: ResolvedPortalPlayback,
    player: ExternalPlayerName,
    transition?: number,
  ): Promise<ExternalPlayerSession | void>;
}

export const PLAYER_FACADE = new InjectionToken<PlayerFacade>("PLAYER_FACADE");

/** Browser-only/test facades may omit native resource arbitration. */
export function withPlaybackIntent<T>(
  player: Pick<PlayerFacade, "withPlaybackIntent">,
  action: () => Promise<T>,
): Promise<T> {
  return player.withPlaybackIntent
    ? player.withPlaybackIntent(action)
    : action();
}
