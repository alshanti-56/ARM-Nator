import { ChannelDrm } from './channel-drm.interface';
import { PlaybackPositionData } from './playback-position.interface';

export interface PlayerContentInfo extends Omit<
    PlaybackPositionData,
    'positionSeconds' | 'durationSeconds' | 'updatedAt'
> {
    playlistId: string;
}

export interface ResolvedPortalPlayback {
    streamUrl: string;
    title: string;
    thumbnail?: string | null;
    isLive?: boolean;
    startTime?: number;
    contentInfo?: PlayerContentInfo;
    headers?: Record<string, string>;
    userAgent?: string;
    referer?: string;
    origin?: string;
    drm?: ChannelDrm;
    subtitleUrl?: string;
    subtitleLabel?: string;
    subtitleLanguage?: string;
}

export interface PlaybackNetworkHop { url: string; status: number; location?: string; }
export interface PlaybackNetworkInspection {
    requestedUrl: string; finalUrl: string; status: number; statusText: string;
    contentType?: string; contentLength?: number; headers: Record<string, string>;
    redirectChain: PlaybackNetworkHop[]; detectedLive?: boolean; elapsedMs: number; error?: string;
}
export interface PlayerEngineAvailability { engine: string; available: boolean; path?: string; reason?: string; }
