import type Artplayer from 'artplayer';
import type { Option } from 'artplayer';
import Hls, {
    ErrorTypes,
    type ErrorData,
    type LevelLoadedData,
    type ManifestParsedData,
} from 'hls.js';
import mpegts from 'mpegts.js';
import type { ChannelDrm } from '@arm-nator/shared/interfaces';
import {
    InlinePlaybackPlayer,
    type PlaybackDiagnostic,
    classifyHlsPlaybackIssue,
    classifyMpegTsPlaybackIssue,
    classifyUnsupportedHlsManifestCodecs,
    createPlaybackSourceMetadata,
} from '../playback-diagnostics/playback-diagnostics.util';
import type {
    WebVideoControlsAdapter,
    WebVideoPlaybackIntent,
} from '../player-controls';
import type { ShakaModuleLoader } from '../shaka-engine/shaka-module.types';
import { ShakaVideoSession } from '../shaka-engine/shaka-video-session';
import { ArtPlayerHlsProxySession } from './art-player-hls-proxy-session';
import {
    type WebVideoControlsSource,
    WebVideoSourceControlsBridge,
} from '../web-video-support/web-video-source-controls.bridge';
import {
    MpegTsLiveRecovery,
    createMpegTsConfig,
    isRecoverableMpegTsLiveFailure,
} from '../web-video-support/mpegts-live-recovery';
import { LivePlaybackRecovery } from '../web-video-support/live-playback-recovery';
import { LivePlaybackWatchdog } from '../web-video-support/live-playback-watchdog';

const LIVE_HLS_ERROR_GRACE_MS = 5_000;
const LIVE_HLS_RESTART_BUFFER_GUARD_SECONDS = 2;
const LIVE_HLS_DEFERRED_RESTART_DELAY_MS = 3_000;
const INITIAL_LIVE_SYNC_SEGMENTS = 4;
const MAX_LIVE_SYNC_SEGMENTS = 6;
const LIVE_WINDOW_SAFETY_SEGMENTS = 2;

export interface ArtPlayerSourceSessionConfig {
    controlsAdapter: WebVideoControlsAdapter;
    isLive: () => boolean;
    showCaptions: () => boolean;
    emitPlaybackIssue: (issue: PlaybackDiagnostic) => void;
    /** DRM config of the active channel, used by the DASH (`mpd`) engine. */
    getDrm?: () => ChannelDrm | undefined;
    /** Test seam for the lazily imported shaka-player module. */
    loadShaka?: ShakaModuleLoader;
    /** Provider headers retained by the main-process HLS transport. */
    hlsRequestHeaders?: Record<string, string>;
}

/**
 * Owns ArtPlayer's custom source engines and the shared-controls track bridge.
 *
 * A session belongs to one ArtPlayer instance. Its customType callbacks use the
 * callback-local `art` argument and become no-ops after destroy, so ArtPlayer's
 * delayed URL dispatch cannot mutate a newer component player.
 */
export class ArtPlayerSourceSession {
    readonly customType: NonNullable<Option['customType']> = {
        m3u8: (video, url) => this.startHls(video, url),
        mpd: (video, url) => this.startDash(video, url),
        ts: (video, url) => this.startMpegTs(video, url),
        'video/matroska': (video, url) => this.startNative(video, url),
    };

    private player: Artplayer | null = null;
    private controlsBridge: WebVideoSourceControlsBridge | null = null;
    private pendingControlsSource: WebVideoControlsSource = { kind: 'native' };
    private hls: Hls | null = null;
    private hlsUrl = '';
    private hlsVideo: HTMLVideoElement | null = null;
    private readonly hlsProxySession = new ArtPlayerHlsProxySession();
    private readonly hlsWatchdog = new LivePlaybackWatchdog();
    private readonly hlsRecovery: LivePlaybackRecovery;
    private readonly unregisterPlaybackIntentListener: () => void;
    private pendingHlsIssue: {
        hls: Hls;
        issue: PlaybackDiagnostic;
        currentTime: number;
    } | null = null;
    private pendingHlsIssueTimer: ReturnType<typeof setTimeout> | undefined;
    private deferredHlsRestartTimer:
        | ReturnType<typeof setTimeout>
        | undefined;
    private hlsManifestListener:
        | ((event: unknown, data: ManifestParsedData) => void)
        | null = null;
    private hlsErrorListener:
        | ((event: unknown, data: ErrorData) => void)
        | null = null;
    private hlsLevelLoadedListener:
        | ((event: unknown, data: LevelLoadedData) => void)
        | null = null;
    private mpegTsPlayer: mpegts.Player | null = null;
    private mpegTsUrl = '';
    private mpegTsVideo: HTMLVideoElement | null = null;
    private readonly mpegTsRecovery: MpegTsLiveRecovery;
    private mpegTsErrorListener:
        | ((type: string, details: string, info: unknown) => void)
        | null = null;
    private shakaSession: ShakaVideoSession | null = null;
    private destroyed = false;

    constructor(private readonly config: ArtPlayerSourceSessionConfig) {
        this.mpegTsRecovery = new MpegTsLiveRecovery({
            isLive: this.config.isLive,
            restart: () => this.restartMpegTsAfterDisconnect(),
        });
        this.hlsRecovery = new LivePlaybackRecovery({
            isLive: this.config.isLive,
            restart: () => this.restartHls(),
        });
        this.unregisterPlaybackIntentListener =
            this.config.controlsAdapter.registerPlaybackIntentListener(
                (intent) => this.handlePlaybackIntent(intent),
            );
    }

    attach(player: Artplayer): void {
        if (this.destroyed || this.player) {
            return;
        }

        this.player = player;
        const bridge = new WebVideoSourceControlsBridge({
            video: player.video,
            adapter: this.config.controlsAdapter,
            isLive: this.config.isLive,
            showCaptions: this.config.showCaptions,
        });
        this.controlsBridge = bridge;
        bridge.attach();
        bridge.setSource(this.pendingControlsSource);
    }

    refreshInputs(): void {
        this.controlsBridge?.refreshInputs();
    }

    resolveDuration(fallbackDuration: number): number {
        const correctedDuration = this.controlsBridge?.readDuration() ?? NaN;
        return Number.isNaN(correctedDuration)
            ? fallbackDuration
            : correctedDuration;
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.unregisterPlaybackIntentListener();
        this.controlsBridge?.destroy();
        this.controlsBridge = null;
        this.destroyHls();
        this.destroyMpegTs();
        this.mpegTsRecovery.destroy();
        this.hlsWatchdog.destroy();
        this.hlsRecovery.destroy();
        this.shakaSession?.destroy();
        this.shakaSession = null;
        this.player = null;
    }

    private startHls(
        video: HTMLVideoElement,
        url: string,
        preserveRecovery = false,
        resumePlayback = false
    ): void {
        if (this.destroyed) {
            return;
        }

        this.prepareForSourceChange(preserveRecovery);
        if (Hls.isSupported()) {
            const hls = new Hls({
                // Keep enough media behind the live edge for providers whose
                // segment fetch time approaches the segment duration.
                liveSyncDurationCount: INITIAL_LIVE_SYNC_SEGMENTS,
                liveMaxLatencyDurationCount: 9,
                maxBufferLength: 30,
            });
            this.hls = hls;
            this.hlsUrl = url;
            this.hlsVideo = video;
            this.hlsManifestListener = (_event, data) => {
                if (this.destroyed || this.hls !== hls) {
                    return;
                }
                this.handleHlsManifestParsed(url, data);
            };
            this.hlsErrorListener = (_event, data) => {
                if (this.destroyed || this.hls !== hls) {
                    return;
                }
                this.handleHlsError(hls, url, data);
            };
            this.hlsLevelLoadedListener = (_event, data) => {
                if (this.destroyed || this.hls !== hls) {
                    return;
                }
                this.adaptLiveSync(hls, data);
            };
            hls.on(Hls.Events.MANIFEST_PARSED, this.hlsManifestListener);
            hls.on(Hls.Events.ERROR, this.hlsErrorListener);
            hls.on(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
            hls.attachMedia(video);
            this.bindControlsSource({ kind: 'hls', hls });
            void this.hlsProxySession
                .load(
                    hls,
                    url,
                    this.config.hlsRequestHeaders,
                    () => !this.destroyed && this.hls === hls
                )
                .then((loaded) => {
                    if (
                        loaded &&
                        !this.destroyed &&
                        this.hls === hls
                    ) {
                        this.hlsWatchdog.start(video, {
                            isLive: this.config.isLive,
                            onNoProgress: (reason) =>
                                this.hlsRecovery.request(reason),
                            onPlaying: () => {
                                this.clearPendingHlsIssue();
                                this.clearDeferredHlsRestart();
                                this.hlsRecovery.markPlaying();
                            },
                            onUnstable: () => this.hlsRecovery.markUnstable(),
                            onUserPause: () => this.hlsRecovery.reset(),
                        });
                        if (resumePlayback) {
                            const playResult = video.play();
                            if (playResult) {
                                void playResult.catch(() => undefined);
                            }
                        }
                    }
                });
            return;
        }

        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
            this.bindControlsSource({ kind: 'native' });
        }
    }

    private startMpegTs(video: HTMLVideoElement, url: string): void {
        if (this.destroyed) {
            return;
        }

        this.prepareForSourceChange();
        if (!mpegts.isSupported()) {
            return;
        }
        this.mpegTsUrl = url;
        this.mpegTsVideo = video;
        this.openMpegTs(video, url);
    }

    private openMpegTs(video: HTMLVideoElement, url: string): void {
        const isLive = this.isMpegTsLive();
        const engine = mpegts.createPlayer(
            {
                type: 'mpegts',
                isLive,
                url,
            },
            createMpegTsConfig(isLive)
        );
        this.mpegTsPlayer = engine;
        this.mpegTsErrorListener = (type, details, info) => {
            if (this.destroyed || this.mpegTsPlayer !== engine) {
                return;
            }
            this.config.emitPlaybackIssue(
                classifyMpegTsPlaybackIssue(
                    { type, details, info },
                    this.createSourceMetadata(url, 'video/mp2t')
                )
            );
            if (isLive && isRecoverableMpegTsLiveFailure(type, details, info)) {
                this.mpegTsRecovery.request(`${type}: ${details}`);
            }
        };
        this.mpegTsEndedListener = () => {
            if (isLive) {
                this.mpegTsRecovery.request(
                    'Live MPEG-TS connection reached EOF.'
                );
            }
        };
        this.mpegTsPlayingListener = () => this.mpegTsRecovery.markPlaying();

        engine.attachMediaElement(video);
        this.bindControlsSource({ kind: 'mpegts' });
        engine.on(mpegts.Events.ERROR, this.mpegTsErrorListener);
        video.addEventListener('ended', this.mpegTsEndedListener);
        video.addEventListener('playing', this.mpegTsPlayingListener);
        engine.load();
        const playResult = engine.play();
        if (playResult) {
            void playResult.catch(() => undefined);
        }
    }

    private startDash(video: HTMLVideoElement, url: string): void {
        if (this.destroyed) {
            return;
        }

        this.prepareForSourceChange();
        const session = this.getShakaSession();
        this.bindControlsSource({ kind: 'shaka', session });
        session.start(video, url, this.config.getDrm?.());
    }

    private startNative(video: HTMLVideoElement, url: string): void {
        if (this.destroyed) {
            return;
        }

        this.prepareForSourceChange();
        video.src = url;
        this.bindControlsSource({ kind: 'native' });
    }

    private prepareForSourceChange(preserveHlsRecovery = false): void {
        this.controlsBridge?.clearSource();
        this.destroyHls(!preserveHlsRecovery);
        this.destroyMpegTs();
        this.shakaSession?.stop();
    }

    private getShakaSession(): ShakaVideoSession {
        this.shakaSession ??= new ShakaVideoSession({
            player: InlinePlaybackPlayer.ArtPlayer,
            emitPlaybackIssue: (issue) =>
                this.config.emitPlaybackIssue(issue),
            showCaptions: this.config.showCaptions,
            loadShaka: this.config.loadShaka,
        });
        return this.shakaSession;
    }

    private bindControlsSource(source: WebVideoControlsSource): void {
        this.pendingControlsSource = source;
        this.controlsBridge?.setSource(source);
    }

    private handlePlaybackIntent(intent: WebVideoPlaybackIntent): void {
        this.hlsWatchdog.notifyPlaybackIntent(intent);
        if (intent === 'pause') {
            this.clearPendingHlsIssue();
            this.clearDeferredHlsRestart();
            // The watchdog may not be active while a new HLS source is loading.
            // Reset directly as well so a queued reconnect cannot survive that
            // gap.
            this.hlsRecovery.reset();
        }
    }

    private destroyHls(resetRecovery = true): void {
        this.hlsWatchdog.stop();
        this.clearPendingHlsIssue();
        this.clearDeferredHlsRestart();
        const hls = this.hls;
        if (hls) {
            if (this.hlsManifestListener) {
                hls.off(Hls.Events.MANIFEST_PARSED, this.hlsManifestListener);
            }
            if (this.hlsErrorListener) {
                hls.off(Hls.Events.ERROR, this.hlsErrorListener);
            }
            if (this.hlsLevelLoadedListener) {
                hls.off(Hls.Events.LEVEL_LOADED, this.hlsLevelLoadedListener);
            }
            hls.destroy();
        }
        this.hls = null;
        this.hlsManifestListener = null;
        this.hlsErrorListener = null;
        this.hlsLevelLoadedListener = null;
        this.hlsProxySession.release();
        if (resetRecovery) {
            this.hlsUrl = '';
            this.hlsVideo = null;
            this.hlsRecovery.reset();
        }
    }

    private restartHls(): void {
        const video = this.hlsVideo;
        const url = this.hlsUrl;
        if (this.destroyed || !video || !url || !this.config.isLive()) {
            return;
        }
        if (
            this.getLiveBufferAheadSeconds(video) >
            LIVE_HLS_RESTART_BUFFER_GUARD_SECONDS
        ) {
            // A stalled manifest does not mean that the already-buffered MSE
            // media is unusable. Keep the current engine and ask it to load
            // again; replacing HLS here would throw away the visible buffer.
            this.hls?.startLoad();
            this.clearDeferredHlsRestart();
            this.deferredHlsRestartTimer = setTimeout(() => {
                this.deferredHlsRestartTimer = undefined;
                if (
                    !this.destroyed &&
                    this.hlsVideo === video &&
                    this.hlsUrl === url &&
                    this.config.isLive()
                ) {
                    this.hlsRecovery.request(
                        'Live HLS recovery deferred while media remains buffered.',
                    );
                }
            }, LIVE_HLS_DEFERRED_RESTART_DELAY_MS);
            return;
        }
        this.startHls(video, url, true, true);
    }

    private getLiveBufferAheadSeconds(video: HTMLVideoElement): number {
        const currentTime = video.currentTime;
        for (let index = 0; index < video.buffered.length; index += 1) {
            const start = video.buffered.start(index);
            const end = video.buffered.end(index);
            if (currentTime >= start && currentTime <= end) {
                return Math.max(0, end - currentTime);
            }
        }
        return 0;
    }

    private clearDeferredHlsRestart(): void {
        if (this.deferredHlsRestartTimer !== undefined) {
            clearTimeout(this.deferredHlsRestartTimer);
            this.deferredHlsRestartTimer = undefined;
        }
    }

    private mpegTsEndedListener: EventListener | null = null;
    private mpegTsPlayingListener: EventListener | null = null;

    private destroyMpegTs(preserveRecovery = false): void {
        const engine = this.mpegTsPlayer;
        const video = this.mpegTsVideo;
        if (video && this.mpegTsEndedListener) {
            video.removeEventListener('ended', this.mpegTsEndedListener);
        }
        if (video && this.mpegTsPlayingListener) {
            video.removeEventListener('playing', this.mpegTsPlayingListener);
        }
        this.mpegTsEndedListener = null;
        this.mpegTsPlayingListener = null;

        if (engine && this.mpegTsErrorListener) {
            engine.off(mpegts.Events.ERROR, this.mpegTsErrorListener);
        }
        this.mpegTsErrorListener = null;
        if (engine) {
            engine.pause();
            engine.unload();
            engine.detachMediaElement();
            engine.destroy();
        }
        this.mpegTsPlayer = null;
        if (!preserveRecovery) {
            this.mpegTsRecovery.reset();
            this.mpegTsUrl = '';
            this.mpegTsVideo = null;
        }
    }

    private restartMpegTsAfterDisconnect(): void {
        const video = this.mpegTsVideo;
        const url = this.mpegTsUrl;
        if (this.destroyed || !video || !url || !this.isMpegTsLive()) {
            return;
        }
        this.destroyMpegTs(true);
        this.openMpegTs(video, url);
    }

    private isMpegTsLive(): boolean {
        return this.config.isLive();
    }

    private handleHlsManifestParsed(
        url: string,
        data: ManifestParsedData
    ): void {
        const metadata = this.createSourceMetadata(
            url,
            'application/x-mpegURL',
            data.levels
                .map((level) => level.audioCodec)
                .filter((codec): codec is string => Boolean(codec)),
            data.levels
                .map((level) => level.videoCodec)
                .filter((codec): codec is string => Boolean(codec))
        );
        const issue = classifyUnsupportedHlsManifestCodecs(metadata);
        if (issue) {
            this.config.emitPlaybackIssue(issue);
        }
    }

    private adaptLiveSync(hls: Hls, data: LevelLoadedData): void {
        const details = data.details;
        if (!details.live || details.fragments.length === 0) {
            return;
        }

        const safeSegmentCount = Math.max(
            2,
            Math.min(
                MAX_LIVE_SYNC_SEGMENTS,
                details.fragments.length - LIVE_WINDOW_SAFETY_SEGMENTS,
            ),
        );
        const targetLatency = safeSegmentCount * details.targetduration;
        if (hls.targetLatency !== targetLatency) {
            hls.targetLatency = targetLatency;
        }
    }

    private handleHlsError(hls: Hls, url: string, data: ErrorData): void {
        if (!data.fatal) {
            return;
        }

        const issue = classifyHlsPlaybackIssue(
            {
                type: data.type,
                details: data.details,
                fatal: data.fatal,
                message: data.error?.message,
                error: data.error,
            },
            this.createSourceMetadata(url, 'application/x-mpegURL')
        );
        if (this.config.isLive()) {
            if (
                data.type === ErrorTypes.NETWORK_ERROR ||
                data.type === ErrorTypes.MEDIA_ERROR
            ) {
                this.deferLiveHlsIssue(hls, issue);
            } else {
                this.config.emitPlaybackIssue(issue);
            }
            if (data.type === ErrorTypes.NETWORK_ERROR) {
                // Keep the current HLS instance alive while buffered media is
                // still playing. Destroying it here discards the MSE buffer
                // and creates a visible stop even when media remains queued.
                // Recovery remains scheduled, but restartHls() will only
                // replace the engine after the buffer is nearly exhausted.
                hls.stopLoad();
                hls.startLoad();
                this.hlsRecovery.request(`${data.type}: ${data.details}`, {
                    cancelOnPlaying: false,
                });
            } else if (data.type === ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError();
            } else {
                this.hlsRecovery.request(`${data.type}: ${data.details}`, {
                    cancelOnPlaying: false,
                });
            }
            return;
        }
        this.config.emitPlaybackIssue(issue);
    }

    private deferLiveHlsIssue(hls: Hls, issue: PlaybackDiagnostic): void {
        this.clearPendingHlsIssue();
        const video = this.hlsVideo;
        if (!video) {
            this.config.emitPlaybackIssue(issue);
            return;
        }
        this.pendingHlsIssue = {
            hls,
            issue,
            currentTime: video.currentTime,
        };
        this.pendingHlsIssueTimer = setTimeout(() => {
            this.pendingHlsIssueTimer = undefined;
            const pending = this.pendingHlsIssue;
            this.pendingHlsIssue = null;
            if (
                !pending ||
                this.destroyed ||
                this.hls !== pending.hls ||
                !this.hlsVideo
            ) {
                return;
            }
            if (
                this.hlsVideo.paused ||
                this.hlsVideo.currentTime - pending.currentTime >= 0.05
            ) {
                return;
            }
            this.config.emitPlaybackIssue(pending.issue);
        }, LIVE_HLS_ERROR_GRACE_MS);
    }

    private clearPendingHlsIssue(): void {
        if (this.pendingHlsIssueTimer !== undefined) {
            clearTimeout(this.pendingHlsIssueTimer);
            this.pendingHlsIssueTimer = undefined;
        }
        this.pendingHlsIssue = null;
    }

    private createSourceMetadata(
        url: string,
        mimeType?: string,
        audioCodecs: readonly string[] = [],
        videoCodecs: readonly string[] = []
    ) {
        return createPlaybackSourceMetadata({
            url,
            mimeType,
            player: InlinePlaybackPlayer.ArtPlayer,
            audioCodecs,
            videoCodecs,
        });
    }
}
