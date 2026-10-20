import type { SeekPreviewSource } from "./seek-previews";
import type { PlaybackRequestPolicy } from './playback-recovery.interface';
import { ChannelDrm } from './channel-drm.interface';
import type { AutoPlaybackPreparation } from './portal-playback.interface';

/**
 * Represents channel object
 * TODO: define channel interface in iptv-parser library
 */
export interface Channel {
    seekPreviews?: SeekPreviewSource;
    seekPreviewCacheKey?: string;
    id: string;
    url: string;
    name: string;
    group: {
        title: string;
    };
    tvg: {
        id: string;
        name: string;
        url: string;
        logo: string;
        rec: string;
    };
    http: {
        referrer: string;
        'user-agent': string;
        origin: string;
        /** Additional provider headers kept for authenticated playback. */
        headers?: Record<string, string>;
        preparedProxy?: AutoPlaybackPreparation;
        requestPolicy?: PlaybackRequestPolicy;
        direct?: boolean;
        providerRecovery?: boolean;
        startPaused?: boolean;
    };
    radio: string;
    drm?: ChannelDrm;
    raw?: string;
}
