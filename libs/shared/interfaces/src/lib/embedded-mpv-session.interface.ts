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
    videoCodec?: string;
    audioCodec?: string;
    fps?: number;
    bitrate?: number;
    droppedFrames?: number;
    bufferedSeconds?: number;
    startedAt: string;
    updatedAt: string;
    error?: string;
}
