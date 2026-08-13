import { inject, Injectable } from '@angular/core';
import {
    normalizeXtreamServerUrl,
    StreamFormat,
    XtreamSerieEpisode,
    XtreamVodDetails,
} from '@arm-nator/shared/interfaces';
import { SettingsStore } from '@arm-nator/services';
import { XtreamCredentials } from './xtream-api.service';

/** Extended playlist shape retained for callers that need playback headers. */
export interface XtreamPlaylistWithHeaders extends XtreamCredentials {
    id: string;
    name: string;
    type?: string;
    userAgent?: string;
    referrer?: string;
    origin?: string;
}

export interface LiveStreamItem {
    xtream_id: number;
    [key: string]: unknown;
}

type XtreamVodStreamLike = XtreamVodDetails & {
    readonly stream_id?: number;
};

interface NormalizedXtreamCredentials {
    password: string;
    serverUrl: string;
    username: string;
}

/** Constructs Xtream live, VOD, and series playback URLs. */
@Injectable({ providedIn: 'root' })
export class XtreamUrlService {
    private readonly settingsStore = inject(SettingsStore);

    constructLiveUrl(
        credentials: XtreamCredentials,
        xtreamId: number,
        format?: string
    ): string {
        const normalized = this.normalizeCredentials(credentials);
        if (!normalized) {
            return '';
        }

        const streamFormat = this.resolveLiveStreamFormat(
            credentials,
            format ??
                this.settingsStore.streamFormat() ??
                StreamFormat.AutoStreamFormat
        );
        return `${normalized.serverUrl}/live/${normalized.username}/${normalized.password}/${xtreamId}.${streamFormat}`;
    }

    constructVodUrl(
        credentials: XtreamCredentials,
        vodItem: XtreamVodDetails
    ): string {
        const vod = vodItem as XtreamVodStreamLike;
        const streamId = vod.movie_data?.stream_id ?? vod.stream_id;
        const extension = vodItem.movie_data?.container_extension;
        const normalized = this.normalizeCredentials(credentials);
        if (!streamId || !extension || !normalized) {
            return '';
        }

        return `${normalized.serverUrl}/movie/${normalized.username}/${normalized.password}/${streamId}.${extension}`;
    }

    constructEpisodeUrl(
        credentials: XtreamCredentials,
        episode: XtreamSerieEpisode
    ): string {
        const normalized = this.normalizeCredentials(credentials);
        if (!normalized) {
            return '';
        }

        return `${normalized.serverUrl}/series/${normalized.username}/${normalized.password}/${episode.id}.${episode.container_extension}`;
    }

    private normalizeCredentials(
        credentials: XtreamCredentials
    ): NormalizedXtreamCredentials | null {
        const username = credentials.username.trim();
        const password = credentials.password.trim();
        if (!username || !password) {
            return null;
        }

        let serverUrl: string;
        try {
            serverUrl = normalizeXtreamServerUrl(credentials.serverUrl);
        } catch {
            return null;
        }

        return {
            serverUrl,
            username: encodeURIComponent(username),
            password: encodeURIComponent(password),
        };
    }

    private resolveLiveStreamFormat(
        credentials: XtreamCredentials,
        requestedFormat: string
    ): string {
        const requested = requestedFormat.trim().toLowerCase();
        const allowedFormats = this.getNormalizedAllowedOutputFormats(
            credentials
        );
        if (!requested || requested === StreamFormat.AutoStreamFormat) {
            return this.resolveAutoLiveStreamFormat(allowedFormats);
        }
        if (allowedFormats?.length && !allowedFormats.includes(requested)) {
            return allowedFormats[0];
        }
        return requested;
    }

    private resolveAutoLiveStreamFormat(
        allowedFormats: string[] | undefined
    ): string {
        if (!allowedFormats?.length) {
            return StreamFormat.M3u8StreamFormat;
        }
        if (allowedFormats.includes(StreamFormat.M3u8StreamFormat)) {
            return StreamFormat.M3u8StreamFormat;
        }
        if (allowedFormats.includes(StreamFormat.TsStreamFormat)) {
            return StreamFormat.TsStreamFormat;
        }
        return allowedFormats[0];
    }

    private getNormalizedAllowedOutputFormats(
        credentials: XtreamCredentials
    ): string[] | undefined {
        const formats = credentials.allowedOutputFormats
            ?.map((format) => format.trim().toLowerCase())
            .filter(Boolean);
        return formats?.length ? formats : undefined;
    }
}
