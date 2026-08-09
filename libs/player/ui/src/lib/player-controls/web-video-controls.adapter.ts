import { Injectable, type Signal, computed, signal } from '@angular/core';
import {
    createEmptyControlsState,
    DEFAULT_ASPECT_PRESETS,
    DEFAULT_PLAYER_CAPABILITIES,
    DEFAULT_PICTURE_SETTINGS,
    DEFAULT_SUBTITLE_SETTINGS,
    DEFAULT_SPEED_PRESETS,
} from './player-controls-defaults';
import type {
    PlayerController,
    PlayerControlsCapabilities,
    PlayerControlsCommands,
    PlayerControlsState,
    PlayerMediaTelemetry,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
    PlayerTrack,
} from './player-controls.model';
import { WebVideoPictureAdjustments } from './web-video-picture-adjustments';
import { WebVideoSubtitleAdjustments } from '../web-video-support/web-video-subtitle-adjustments';
import { syncOnlineSubtitleTrack } from '../web-video-support/online-subtitle-track';
import type { OpenSubtitlesDownloadedSubtitle } from '@arm-nator/shared/interfaces';
import type { SeriesPlaybackNavigation } from '../portal-inline-player/series-playback-navigation';
import {
    applyTrackSelection,
    applyVideoCurrentTime,
    applyVideoSpeed,
    applyVideoVolume,
    hasSeekableRange,
    isVideoStalled,
    mapVideoStatus,
    normalizeVideoDuration,
    readVideoDuration,
    readVideoIsLive,
    readVideoVolume,
    toggleVideoPlay,
    type WebVideoMetadataOptions,
    WEB_VIDEO_EVENTS,
} from './web-video-controls.media-helpers';

/**
 * Engine-agnostic accessors a web engine injects so the adapter can read/select
 * audio & subtitle tracks without importing hls.js or artplayer.
 */
export interface WebVideoControlsOptions extends WebVideoMetadataOptions {
    getAudioTracks?: () => PlayerTrack[];
    setAudioTrack?: (id: number) => void | Promise<void>;
    getSubtitleTracks?: () => PlayerTrack[];
    setSubtitleTrack?: (id: number) => void | Promise<void>;
    getMediaTelemetry?: () => Partial<PlayerMediaTelemetry>;
}

interface WebVideoControlsContext {
    seriesNavigation: Signal<SeriesPlaybackNavigation | null>;
}

/**
 * Can bridge any `<video>`-backed web engine onto the generic
 * {@link PlayerController} contract using only DOM/video APIs.
 */
@Injectable()
export class WebVideoControlsAdapter implements PlayerController {
    private video: HTMLVideoElement | null = null;
    private opts: WebVideoControlsOptions = {};
    private detachFn: (() => void) | null = null;
    private bindingGeneration = 0;
    private lastMetricSample: {
        at: number;
        frames: number;
        bytes: number;
    } | null = null;
    private sampledFps: number | undefined;
    private sampledBitrate: number | undefined;
    private readonly aspectRatio = signal('no');
    private readonly picture = signal<PlayerPictureSettings>(
        DEFAULT_PICTURE_SETTINGS,
    );
    private pictureAdjustments: WebVideoPictureAdjustments | null = null;
    private subtitleAdjustments: WebVideoSubtitleAdjustments | null = null;
    private readonly subtitle = signal<PlayerSubtitleSettings>(
        DEFAULT_SUBTITLE_SETTINGS,
    );

    /** Bumped whenever DOM or engine-specific state must be re-read. */
    private readonly tick = signal(0);
    /**
     * Holds the host-supplied series-navigation signal reactively. Storing the
     * signal itself (rather than a one-time snapshot of its value) means updates
     * the host pushes AFTER {@link setContext} are reflected here.
     */
    private readonly seriesNavigationSource = signal<
        Signal<SeriesPlaybackNavigation | null>
    >(signal(null));
    private readonly seriesNavigation = computed(() =>
        this.seriesNavigationSource()(),
    );

    readonly capabilities = computed<PlayerControlsCapabilities>(() => {
        this.tick();
        if (!this.video) {
            return DEFAULT_PLAYER_CAPABILITIES;
        }

        const hasAudioTracks =
            typeof this.opts.setAudioTrack === 'function' &&
            (this.opts.getAudioTracks?.().length ?? 0) > 1;
        const hasSubtitles =
            typeof this.opts.setSubtitleTrack === 'function' &&
            (this.opts.getSubtitleTracks?.().length ?? 0) > 0;
        const isLive = readVideoIsLive(this.video, this.opts);
        return {
            ...DEFAULT_PLAYER_CAPABILITIES,
            seek: !isLive,
            volume: true,
            playbackSpeed: true,
            fullscreen: true,
            audioTracks: hasAudioTracks,
            subtitles: hasSubtitles,
            aspectRatio: true,
            pictureAdjustments: true,
            seriesNavigation: this.seriesNavigation() !== null,
        };
    });

    readonly state = computed<PlayerControlsState>(() => {
        this.tick();
        const video = this.video;
        if (!video) {
            return createEmptyControlsState();
        }

        const isLive = readVideoIsLive(video, this.opts);
        const duration = normalizeVideoDuration(
            readVideoDuration(video, this.opts),
            isLive,
        );
        const seriesNav = this.seriesNavigation();
        const seriesNavCapable = seriesNav !== null;

        const audioTracks = this.opts.getAudioTracks?.() ?? [];
        const subtitleTracks = this.opts.getSubtitleTracks?.() ?? [];
        return {
            status: mapVideoStatus(video),
            statusMessage: '',
            stalled: isVideoStalled(video),
            positionSeconds: Math.max(0, video?.currentTime ?? 0),
            durationSeconds: duration,
            isLive,
            canSeek: !isLive && (duration ?? 0) > 0 && hasSeekableRange(video),
            volume: readVideoVolume(video),
            audioTracks,
            subtitleTracks,
            subtitlesEnabled: subtitleTracks.some((track) => track.selected),
            playbackSpeed: video?.playbackRate ?? 1,
            speedPresets: DEFAULT_SPEED_PRESETS,
            aspectRatio: this.aspectRatio(),
            aspectPresets: DEFAULT_ASPECT_PRESETS,
            picture: this.picture(),
            subtitle: this.subtitle(),
            canPreviousEpisode:
                seriesNavCapable && seriesNav?.canPrevious === true,
            canNextEpisode: seriesNavCapable && seriesNav?.canNext === true,
        };
    });

    readonly mediaTelemetry = computed<PlayerMediaTelemetry>(() => {
        this.tick();
        const video = this.video;
        if (!video) {
            return {};
        }

        const quality = video.getVideoPlaybackQuality?.();
        const totalFrames = quality?.totalVideoFrames;
        const droppedFrames = quality?.droppedVideoFrames;
        const decodedBytes = Number(
            (
                video as HTMLVideoElement & {
                    webkitVideoDecodedByteCount?: number;
                }
            ).webkitVideoDecodedByteCount ?? 0,
        );
        const now = performance.now();
        if (
            typeof totalFrames === 'number' &&
            this.lastMetricSample &&
            now > this.lastMetricSample.at
        ) {
            const elapsedSeconds = (now - this.lastMetricSample.at) / 1000;
            const frameDelta = totalFrames - this.lastMetricSample.frames;
            const byteDelta = decodedBytes - this.lastMetricSample.bytes;
            if (elapsedSeconds >= 0.25 && frameDelta >= 0) {
                this.sampledFps = frameDelta / elapsedSeconds;
                if (byteDelta >= 0) {
                    this.sampledBitrate = (byteDelta * 8) / elapsedSeconds;
                }
            }
        }
        if (typeof totalFrames === 'number') {
            this.lastMetricSample = {
                at: now,
                frames: totalFrames,
                bytes: decodedBytes,
            };
        }

        let bufferedSeconds = 0;
        let bufferAheadSeconds = 0;
        try {
            const ranges = video.buffered;
            for (let index = 0; index < ranges.length; index += 1) {
                bufferedSeconds += Math.max(
                    0,
                    ranges.end(index) - ranges.start(index),
                );
                if (
                    video.currentTime >= ranges.start(index) &&
                    video.currentTime <= ranges.end(index)
                ) {
                    bufferAheadSeconds = Math.max(
                        0,
                        ranges.end(index) - video.currentTime,
                    );
                }
            }
        } catch {
            // Media ranges can change while being read.
        }

        return {
            resolvedUrl: video.currentSrc || undefined,
            width: video.videoWidth || undefined,
            height: video.videoHeight || undefined,
            fps: this.sampledFps,
            bitrate: this.sampledBitrate,
            bufferedSeconds,
            bufferAheadSeconds,
            droppedFrames,
            totalFrames,
            eofReason: video.ended ? 'media-element-ended' : undefined,
            ...this.opts.getMediaTelemetry?.(),
        };
    });

    readonly commands: PlayerControlsCommands = {
        togglePlay: () => toggleVideoPlay(this.video),
        seekTo: (seconds) =>
            applyVideoCurrentTime(this.video, seconds, () =>
                readVideoDuration(this.video, this.opts),
            ),
        seekBy: (delta) =>
            applyVideoCurrentTime(
                this.video,
                (this.video?.currentTime ?? 0) + delta,
                () => readVideoDuration(this.video, this.opts),
            ),
        setVolume: (value) => applyVideoVolume(this.video, value),
        setAudioTrack: (id) =>
            applyTrackSelection(this.opts.setAudioTrack, id, () =>
                this.refresh(),
            ),
        setSubtitleTrack: (id) =>
            applyTrackSelection(this.opts.setSubtitleTrack, id, () =>
                this.refresh(),
            ),
        setPlaybackSpeed: (speed) => applyVideoSpeed(this.video, speed),
        setAspectRatio: (value) => {
            this.aspectRatio.set(value);
            if (this.video) {
                this.video.style.aspectRatio =
                    value === 'no' ? '' : value.replace(':', ' / ');
                this.video.style.objectFit = 'contain';
            }
            this.refresh();
        },
        setPictureSettings: (value) => {
            this.picture.set(value);
            this.pictureAdjustments?.apply(value);
            this.refresh();
        },
        setSubtitleSettings: (value) => {
            this.subtitle.set(value);
            this.subtitleAdjustments?.apply(value);
            this.refresh();
        },
        setOnlineSubtitle: (subtitle: OpenSubtitlesDownloadedSubtitle) => {
            if (!this.video) {
                return;
            }
            syncOnlineSubtitleTrack(this.video, {
                url: subtitle.webVttDataUrl,
                label: subtitle.label,
                language: subtitle.language,
            });
            this.subtitleAdjustments?.apply(this.subtitle());
            this.refresh();
        },
    };

    /** Binds to a `<video>` element and starts maintaining the state signal. */
    attach(video: HTMLVideoElement, opts: WebVideoControlsOptions = {}): void {
        this.detach();
        const generation = this.bindingGeneration;
        this.video = video;
        this.opts = opts;
        this.pictureAdjustments = new WebVideoPictureAdjustments(video);
        this.pictureAdjustments.apply(this.picture());
        this.subtitleAdjustments = new WebVideoSubtitleAdjustments(video);
        this.subtitleAdjustments.apply(this.subtitle());

        const onEvent = () => {
            if (this.video === video && this.bindingGeneration === generation) {
                this.refresh();
            }
        };
        for (const eventName of WEB_VIDEO_EVENTS) {
            video.addEventListener(eventName, onEvent);
        }
        this.detachFn = () => {
            for (const eventName of WEB_VIDEO_EVENTS) {
                video.removeEventListener(eventName, onEvent);
            }
        };
        // Prime the initial snapshot.
        onEvent();
    }

    /**
     * Invalidates cached state/capabilities after an engine-specific getter
     * changes without emitting a native media event (for example tracks,
     * corrected duration, or live/VOD classification).
     */
    refresh(): void {
        this.tick.update((value) => value + 1);
    }

    /** Removes listeners and clears the bound element. Idempotent. */
    detach(): void {
        this.bindingGeneration += 1;
        this.detachFn?.();
        this.detachFn = null;
        this.pictureAdjustments?.destroy();
        this.pictureAdjustments = null;
        this.subtitleAdjustments?.destroy();
        this.subtitleAdjustments = null;
        this.video = null;
        this.opts = {};
        this.lastMetricSample = null;
        this.sampledFps = undefined;
        this.sampledBitrate = undefined;
        this.aspectRatio.set('no');
        this.picture.set(DEFAULT_PICTURE_SETTINGS);
        this.subtitle.set(DEFAULT_SUBTITLE_SETTINGS);
        this.refresh();
    }

    /** Pushes reactive context (series navigation) used for capability gating. */
    setContext(context: WebVideoControlsContext): void {
        this.seriesNavigationSource.set(context.seriesNavigation);
    }
}
