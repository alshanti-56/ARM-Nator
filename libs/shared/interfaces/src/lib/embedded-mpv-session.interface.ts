import type { PlayerPictureSettings } from './video-picture-settings.interface';

export type EmbeddedMpvSessionStatus =
    | 'idle'
    | 'loading'
    | 'playing'
    | 'paused'
    | 'ended'
    | 'error'
    | 'closed';

export interface EmbeddedMpvBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Native backend currently owning an embedded player session. */
export type EmbeddedMpvBackend = 'embedded-mpv' | 'ksplayer-metal';

/** Alias used by diagnostics and backend-aware player code. */
export type PlayerBackend = EmbeddedMpvBackend;

export interface KsPlayerMetalSupport {
    supported: boolean;
    reason?: string;
    architecture?: string;
    runtimePath?: string;
}

export interface KsPlayerMetalControls {
    pause: boolean;
    seek: boolean;
    volume: boolean;
    audioTracks?: boolean;
    /** Optional for compatibility with older KSPlayer native addons. */
    playbackSpeed?: boolean;
}

export type KsPlayerMetalSupportedControls = KsPlayerMetalControls;

export interface EmbeddedMpvCapabilities {
    subtitles: boolean;
    playbackSpeed: boolean;
    aspectOverride: boolean;
    pictureAdjustments: boolean;
}

export interface EmbeddedMpvSupport {
    supported: boolean;
    platform: string;
    reason?: string;
    capabilities?: EmbeddedMpvCapabilities;
    /** Backend that produced this support result, when known. */
    backend?: EmbeddedMpvBackend;
    /** KSPlayer Metal runtime metadata, when the selected backend is KS. */
    architecture?: string;
    runtimePath?: string;
    controls?: KsPlayerMetalControls;
}

export interface EmbeddedMpvAudioTrack {
    id: number;
    title?: string;
    language?: string;
    selected: boolean;
    defaultTrack?: boolean;
    forced?: boolean;
}

export type EmbeddedMpvSubtitleTrack = EmbeddedMpvAudioTrack;

export interface EmbeddedMpvSession {
    id: string;
    /** Actual backend owning this snapshot. Optional for old embedded snapshots. */
    backend?: EmbeddedMpvBackend;
    title: string;
    streamUrl: string;
    status: EmbeddedMpvSessionStatus;
    positionSeconds: number;
    durationSeconds: number | null;
    volume: number;
    audioTracks: EmbeddedMpvAudioTrack[];
    selectedAudioTrackId: number | null;
    subtitleTracks: EmbeddedMpvSubtitleTrack[];
    selectedSubtitleTrackId: number | null;
    playbackSpeed: number;
    aspectOverride: string;
    picture: PlayerPictureSettings;
    /** Source video size reported by MPV. */
    videoWidth?: number;
    videoHeight?: number;
    /** Container format reported by MPV (for example, matroska or MPEG-TS). */
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    /** Active MPV hardware-decoder backend, for example videotoolbox or no. */
    hwdecCurrent?: string;
    fps?: number;
    bitrate?: number;
    droppedFrames?: number;
    bufferedSeconds?: number;
    startedAt: string;
    updatedAt: string;
    error?: string;
}

export type KsPlayerMetalSession = EmbeddedMpvSession & {
    backend: 'ksplayer-metal';
};
