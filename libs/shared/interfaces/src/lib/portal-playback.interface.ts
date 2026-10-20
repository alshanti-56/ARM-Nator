import type { SeekPreviewSource } from "./seek-previews";
import type {
  PlaybackRecoveryMetadata,
  PlaybackRequestPolicy,
} from "./playback-recovery.interface";
import { ChannelDrm } from "./channel-drm.interface";
import type {
  CatalogueItemIdentity,
  WorkDescriptor,
  ViewingItem,
} from "./viewing-continuity";
import { PlaybackPositionData } from "./playback-position.interface";

export interface PlayerContentInfo extends Omit<
  PlaybackPositionData,
  "positionSeconds" | "durationSeconds" | "updatedAt"
> {
  playlistId: string;
}

export interface ResolvedPortalPlayback {
  streamUrl: string;
  /** Internal ownership token; stale player callbacks cannot recover a newer attempt. */
  playbackAttemptToken?: number;
  /** Internal explicit seek on a generated companion stream. */
  preferredProcessingMode?: 'remux' | 'convert';
  seekPreviews?: SeekPreviewSource;
  recovery?: PlaybackRecoveryMetadata;
  requestPolicy?: PlaybackRequestPolicy;
  transport?: "direct" | "proxy";
  /** Preserve user pause across a recovery replacement. */
  startPaused?: boolean;
  /** Ephemeral user intent transferred between in-app engines; never provider data. */
  recoveryState?: {
    volume: number;
    playbackSpeed: number;
    audio?: { label: string; language?: string; role?: string };
    subtitle?: { label: string; language?: string; role?: string } | 'off';
  };
  /** Original provider URL retained when playback uses a local prepared proxy. */
  originalStreamUrl?: string;
  /** Internal retained response; its owner releases it at the transition barrier. */
  preparedProxy?: AutoPlaybackPreparation;
  title: string;
  thumbnail?: string | null;
  isLive?: boolean;
  startTime?: number;
  resumePolicy?: "auto" | "start-over";
  contentInfo?: PlayerContentInfo;
  historyContext?: ViewingItem["activity"];
  itemIdentity?: CatalogueItemIdentity;
  seriesIdentity?: CatalogueItemIdentity;
  work?: WorkDescriptor;
  headers?: Record<string, string>;
  userAgent?: string;
  referer?: string;
  origin?: string;
  drm?: ChannelDrm;
  subtitleUrl?: string;
  subtitleLabel?: string;
  subtitleLanguage?: string;
}

export type AutoPlaybackFormat =
  "hls" | "mpegts" | "progressive" | "dash" | "unknown";

/** A retained first response owned by one Electron media-proxy session. */
export interface AutoPlaybackPreparation {
  id: string;
  url: string;
  format: AutoPlaybackFormat;
  container?: "mp4" | "webm" | "matroska" | "mpegts" | "hls" | "dash";
  mimeType?: string;
  /** Optional metadata from the retained manifest/response; never requires another provider probe. */
  videoCodecs?: readonly string[];
  audioCodecs?: readonly string[];
  audioOnly?: boolean;
  encrypted?: boolean;
  processingMode?: "direct" | "proxy" | "remux" | "convert";
  /** Original VOD time represented by output timestamp zero. */
  timelineOffsetSeconds?: number;
  durationSeconds?: number;
}

/** IPC preserves failure data explicitly rather than serializing custom Errors. */
export type AutoPlaybackPreparationResult =
  | { ok: true; session: AutoPlaybackPreparation }
  | {
      ok: false;
      error: { code: string; status: number | null; message: string };
    };

export interface PlaybackNetworkHop {
  url: string;
  status: number;
  location?: string;
}
export interface PlaybackNetworkInspection {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType?: string;
  contentLength?: number;
  headers: Record<string, string>;
  redirectChain: PlaybackNetworkHop[];
  detectedLive?: boolean;
  elapsedMs: number;
  error?: string;
}
export interface PlayerEngineAvailability {
  engine: string;
  available: boolean;
  path?: string;
  reason?: string;
}
