import type Hls from 'hls.js';
import type {
    PlayerMediaTelemetry,
    PlayerTrack,
} from '../player-controls/player-controls.model';
import type { ShakaVideoSession } from '../shaka-engine/shaka-video-session';
import { WebVideoHlsControls } from './web-video-hls-controls';
import { WebVideoNativeTextTracks } from './web-video-native-text-tracks';
import { WebVideoShakaControls } from './web-video-shaka-controls';
import { ONLINE_SUBTITLE_TRACK_ID } from './online-subtitle-track';

const NATIVE_SUBTITLE_ID_OFFSET = 1_000_000;

export type WebVideoControlsSource =
    | { kind: 'native' }
    | { kind: 'mpegts' }
    | { kind: 'hls'; hls: Hls }
    | { kind: 'shaka'; session: ShakaVideoSession };

export interface WebVideoSourceTracksConfig {
    video: HTMLVideoElement;
    showCaptions: () => boolean;
    /**
     * Notifies the owning controls UI that track state changed. Legacy players
     * have no shared controls to refresh and leave it unset — they use this
     * class purely to apply the caption preference.
     */
    refresh?: () => void;
    /**
     * Set by hosts that keep the engine's own caption UI (the preference-off
     * players). The caption preference then seeds each new source instead of
     * staying authoritative, so the vendor caption menu keeps working once
     * playback is running. Shared controls own the caption UI and omit it.
     */
    vendorCaptionControls?: boolean;
}

/**
 * Owns the per-source audio/subtitle track controllers of a web video engine.
 *
 * It is deliberately free of any controls-UI dependency so both the shared
 * controls bridge and the legacy (vendor-chrome) players apply the
 * `showCaptions` preference through the exact same code path.
 */
export class WebVideoSourceTracks {
    private readonly config: WebVideoSourceTracksConfig;
    private readonly hlsControls: WebVideoHlsControls;
    private readonly shakaControls: WebVideoShakaControls;
    private readonly nativeTextTracks: WebVideoNativeTextTracks;
    private source: WebVideoControlsSource | null = null;
    private playbackStarted = false;
    private playingListener: (() => void) | null = null;
    private destroyed = false;

    constructor(config: WebVideoSourceTracksConfig) {
        this.config = config;
        const refresh = () => config.refresh?.();
        const playbackStarted = config.vendorCaptionControls
            ? () => this.playbackStarted
            : undefined;
        this.hlsControls = new WebVideoHlsControls({
            showCaptions: config.showCaptions,
            refresh,
            playbackStarted,
        });
        this.shakaControls = new WebVideoShakaControls({
            showCaptions: config.showCaptions,
            refresh,
            playbackStarted,
        });
        this.nativeTextTracks = new WebVideoNativeTextTracks({
            video: config.video,
            showCaptions: config.showCaptions,
            refresh,
            playbackStarted,
            includeTrack: (track) =>
                this.source?.kind === 'hls' || this.source?.kind === 'shaka'
                    ? track.id === ONLINE_SUBTITLE_TRACK_ID
                    : true,
        });
        if (config.vendorCaptionControls) {
            const listener = () => {
                this.playbackStarted = true;
            };
            this.playingListener = listener;
            config.video.addEventListener('playing', listener);
        }
    }

    get sourceKind(): WebVideoControlsSource['kind'] | null {
        return this.source?.kind ?? null;
    }

    setSource(source: WebVideoControlsSource): void {
        if (this.destroyed) {
            return;
        }

        this.clearActiveSource();
        this.source = source;
        // A new source starts unsettled so its own defaults are seeded again.
        this.playbackStarted = false;
        this.nativeTextTracks.bind();
        if (source.kind === 'hls') {
            this.hlsControls.bind(source.hls);
        } else if (source.kind === 'shaka') {
            this.shakaControls.bind(source.session);
        }
    }

    refreshInputs(): void {
        if (this.destroyed) {
            return;
        }

        if (this.source?.kind === 'hls') {
            this.hlsControls.refreshInputs();
        } else if (this.source?.kind === 'shaka') {
            this.shakaControls.refreshInputs();
        }
        if (this.source) {
            this.nativeTextTracks.refreshInputs();
        }
    }

    clearSource(): void {
        if (this.destroyed) {
            return;
        }

        this.clearActiveSource();
        this.source = null;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.clearSource();
        if (this.playingListener) {
            this.config.video.removeEventListener(
                'playing',
                this.playingListener
            );
            this.playingListener = null;
        }
        this.destroyed = true;
    }

    getAudioTracks(): PlayerTrack[] {
        if (this.source?.kind === 'hls') {
            return this.hlsControls.getAudioTracks();
        }
        if (this.source?.kind === 'shaka') {
            return this.shakaControls.getAudioTracks();
        }
        return [];
    }

    setAudioTrack(id: number): void {
        if (this.source?.kind === 'hls') {
            this.hlsControls.setAudioTrack(id);
        } else if (this.source?.kind === 'shaka') {
            this.shakaControls.setAudioTrack(id);
        }
    }

    getMediaTelemetry(): Partial<PlayerMediaTelemetry> {
        if (this.source?.kind === 'hls') {
            return this.hlsControls.getMediaTelemetry();
        }
        return {
            sourceKind: this.source?.kind,
            container:
                this.source?.kind === 'shaka'
                    ? 'DASH'
                    : this.source?.kind === 'mpegts'
                      ? 'MPEG-TS'
                      : this.source?.kind === 'native'
                        ? 'Native'
                        : undefined,
        };
    }

    getSubtitleTracks(): PlayerTrack[] {
        const nativeTracks = this.nativeTextTracks
            .getSubtitleTracks()
            .map((track) => ({
                ...track,
                id: track.id + NATIVE_SUBTITLE_ID_OFFSET,
            }));
        if (this.source?.kind === 'hls') {
            return [...this.hlsControls.getSubtitleTracks(), ...nativeTracks];
        }
        if (this.source?.kind === 'shaka') {
            return [...this.shakaControls.getSubtitleTracks(), ...nativeTracks];
        }
        return this.source ? nativeTracks : [];
    }

    setSubtitleTrack(id: number): void {
        if (!Number.isInteger(id)) {
            return;
        }
        if (id >= NATIVE_SUBTITLE_ID_OFFSET) {
            this.disableEngineSubtitles();
            this.nativeTextTracks.setSubtitleTrack(
                id - NATIVE_SUBTITLE_ID_OFFSET
            );
            return;
        }

        this.nativeTextTracks.setSubtitleTrack(-1);
        if (this.source?.kind === 'hls') {
            this.hlsControls.setSubtitleTrack(id);
        } else if (this.source?.kind === 'shaka') {
            this.shakaControls.setSubtitleTrack(id);
        } else if (this.source) {
            this.nativeTextTracks.setSubtitleTrack(
                id === -1 ? -1 : id - NATIVE_SUBTITLE_ID_OFFSET
            );
        }
    }

    private clearActiveSource(): void {
        if (this.source?.kind === 'hls') {
            this.hlsControls.clear();
        } else if (this.source?.kind === 'shaka') {
            this.shakaControls.clear();
        }
        this.nativeTextTracks.clear();
    }

    private disableEngineSubtitles(): void {
        if (this.source?.kind === 'hls') {
            this.hlsControls.setSubtitleTrack(-1);
        } else if (this.source?.kind === 'shaka') {
            this.shakaControls.setSubtitleTrack(-1);
        }
    }
}
