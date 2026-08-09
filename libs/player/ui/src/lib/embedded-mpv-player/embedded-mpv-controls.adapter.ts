import { Injectable, Signal, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
    EmbeddedMpvSession,
    EmbeddedMpvSupport,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';
import { TranslateService } from '@ngx-translate/core';
import { merge } from 'rxjs';
import {
    DEFAULT_ASPECT_PRESETS,
    DEFAULT_PLAYER_CAPABILITIES,
    DEFAULT_PICTURE_SETTINGS,
    DEFAULT_SUBTITLE_SETTINGS,
    DEFAULT_SPEED_PRESETS,
    createEmptyControlsState,
} from '../player-controls/player-controls-defaults';
import {
    PlayerController,
    PlayerControlsCapabilities,
    PlayerControlsCommands,
    PlayerControlsState,
    PlayerStatus,
} from '../player-controls/player-controls.model';
import type {
    OpenSubtitlesDownloadedSubtitle,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
} from '@arm-nator/shared/interfaces';
import { SeriesPlaybackNavigation } from '../portal-inline-player/series-playback-navigation';
import {
    audioTrackLabel,
    readStoredVolume,
    subtitleTrackLabel,
} from './embedded-mpv-format.utils';
import { EmbeddedMpvSessionController } from './embedded-mpv-session-controller';

export interface EmbeddedMpvControlsContext {
    readonly playback: Signal<ResolvedPortalPlayback>;
    readonly seriesNavigation: Signal<SeriesPlaybackNavigation | null>;
}

interface MappedPlayerStatus {
    status: PlayerStatus;
    statusMessage: string;
}

@Injectable()
export class EmbeddedMpvControlsAdapter implements PlayerController {
    private readonly controller = inject(EmbeddedMpvSessionController);
    private readonly translate = inject(TranslateService);
    private readonly translationsTick = toSignal(
        merge(
            this.translate.onLangChange,
            this.translate.onTranslationChange,
            this.translate.onDefaultLangChange,
        ),
        { initialValue: null },
    );

    private readonly configuredContext =
        signal<EmbeddedMpvControlsContext | null>(null);
    private readonly picture = signal<PlayerPictureSettings>(
        DEFAULT_PICTURE_SETTINGS,
    );
    private readonly subtitle = signal<PlayerSubtitleSettings>(
        DEFAULT_SUBTITLE_SETTINGS,
    );

    readonly capabilities = computed<PlayerControlsCapabilities>(() => {
        const context = this.configuredContext();
        if (!context) {
            return DEFAULT_PLAYER_CAPABILITIES;
        }

        const isLive = this.isLivePlayback(context.playback());
        const backend = this.controller.activeBackend();
        const ksControls = this.controller.supportedControls();
        const isKsPlayerMetal = backend === 'ksplayer-metal';
        const optionalCapabilities = this.controller.support()?.capabilities;

        return {
            ...DEFAULT_PLAYER_CAPABILITIES,
            seek: !isLive && (!isKsPlayerMetal || ksControls?.seek === true),
            volume: !isKsPlayerMetal || ksControls?.volume === true,
            audioTracks: !isKsPlayerMetal
                ? true
                : ksControls?.audioTracks === true,
            subtitles: isKsPlayerMetal
                ? ksControls?.subtitles === true
                : (optionalCapabilities?.subtitles ?? false),
            playbackSpeed: !isKsPlayerMetal
                ? (optionalCapabilities?.playbackSpeed ?? false)
                : ksControls?.playbackSpeed === true,
            aspectRatio: isKsPlayerMetal
                ? ksControls?.aspectOverride === true
                : (optionalCapabilities?.aspectOverride ?? false),
            pictureAdjustments: isKsPlayerMetal
                ? ksControls?.pictureAdjustments === true
                : (optionalCapabilities?.pictureAdjustments ?? false),
            fullscreen: true,
            seriesNavigation: context.seriesNavigation() !== null,
            frameStep: !isLive && !isKsPlayerMetal,
        };
    });

    readonly state = computed<PlayerControlsState>(() => {
        const context = this.configuredContext();
        if (!context) {
            return createEmptyControlsState();
        }

        this.translationsTick();
        const support = this.controller.support();
        const session = this.controller.session();
        const playback = context.playback();
        const isLive = this.isLivePlayback(playback);
        const capabilities = this.capabilities();
        const durationSeconds = isLive
            ? null
            : (session?.durationSeconds ?? null);
        const seriesNavigation = context.seriesNavigation();
        const hasSeriesNavigation = seriesNavigation !== null;
        const mappedStatus = this.mapStatus(support, session);
        return {
            ...mappedStatus,
            stalled: this.controller.stalled(),
            positionSeconds: Math.max(0, session?.positionSeconds ?? 0),
            durationSeconds,
            isLive,
            canSeek: capabilities.seek && !isLive && (durationSeconds ?? 0) > 0,
            volume: session?.volume ?? readStoredVolume(),
            audioTracks: capabilities.audioTracks
                ? (session?.audioTracks ?? []).map((track, index) => ({
                      id: track.id,
                      label: audioTrackLabel(track, index, {
                          fallback: this.translate.instant(
                              'EMBEDDED_MPV.PLAYER.AUDIO_TRACK_FALLBACK',
                              { index: index + 1 },
                          ),
                          defaultLabel: this.translate.instant(
                              'EMBEDDED_MPV.PLAYER.TRACK_DEFAULT',
                          ),
                      }),
                      selected: track.selected,
                  }))
                : [],
            subtitleTracks: capabilities.subtitles
                ? (session?.subtitleTracks ?? []).map((track, index) => ({
                      id: track.id,
                      label: subtitleTrackLabel(track, index, {
                          fallback: this.translate.instant(
                              'EMBEDDED_MPV.PLAYER.SUBTITLE_TRACK_FALLBACK',
                              { index: index + 1 },
                          ),
                          defaultLabel: this.translate.instant(
                              'EMBEDDED_MPV.PLAYER.TRACK_DEFAULT',
                          ),
                      }),
                      selected: track.selected,
                  }))
                : [],
            subtitlesEnabled:
                capabilities.subtitles &&
                session?.selectedSubtitleTrackId !== null &&
                session?.selectedSubtitleTrackId !== undefined &&
                session.selectedSubtitleTrackId !== -1,
            playbackSpeed: capabilities.playbackSpeed
                ? (session?.playbackSpeed ?? 1)
                : 1,
            speedPresets: capabilities.playbackSpeed
                ? DEFAULT_SPEED_PRESETS
                : [],
            aspectRatio: capabilities.aspectRatio
                ? (session?.aspectOverride ?? 'no')
                : 'no',
            aspectPresets: capabilities.aspectRatio
                ? DEFAULT_ASPECT_PRESETS
                : [],
            picture: capabilities.pictureAdjustments
                ? (session?.picture ?? this.picture())
                : DEFAULT_PICTURE_SETTINGS,
            subtitle: this.subtitle(),
            canPreviousEpisode:
                hasSeriesNavigation && seriesNavigation?.canPrevious === true,
            canNextEpisode:
                hasSeriesNavigation && seriesNavigation?.canNext === true,
        };
    });

    readonly commands: PlayerControlsCommands = {
        togglePlay: () => void this.controller.togglePaused(),
        seekTo: (seconds) => void this.controller.seekTo(seconds),
        seekBy: (deltaSeconds) => void this.controller.seekBy(deltaSeconds),
        setVolume: (value) => void this.controller.applyVolume(value),
        setAudioTrack: (id) => void this.controller.setAudioTrack(id),
        setSubtitleTrack: (id) => void this.controller.setSubtitleTrack(id),
        setPlaybackSpeed: (speed) => void this.controller.setSpeed(speed),
        setAspectRatio: (value) => void this.controller.setAspect(value),
        setPictureSettings: (value) => {
            this.picture.set(value);
            void this.controller.setPicture(value);
        },
        setSubtitleSettings: (value) => {
            this.subtitle.set(value);
            void this.controller.setSubtitleSettings(value);
        },
        setOnlineSubtitle: (subtitle: OpenSubtitlesDownloadedSubtitle) => {
            void this.controller.setSubtitleFile(subtitle.filePath);
        },
    };

    configure(context: EmbeddedMpvControlsContext): void {
        this.configuredContext.set(context);
    }

    private isLivePlayback(playback: ResolvedPortalPlayback): boolean {
        if (typeof playback.isLive === 'boolean') {
            return playback.isLive;
        }
        return !playback.contentInfo;
    }

    private mapStatus(
        support: EmbeddedMpvSupport | null,
        session: EmbeddedMpvSession | null,
    ): MappedPlayerStatus {
        if (!support) {
            return {
                status: 'loading',
                statusMessage: this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.CHECKING_SUPPORT',
                ),
            };
        }

        if (!support.supported) {
            return {
                status: 'idle',
                statusMessage:
                    support.reason ??
                    this.translate.instant('EMBEDDED_MPV.PLAYER.NOT_AVAILABLE'),
            };
        }

        if (!session || session.status === 'loading') {
            return {
                status: 'loading',
                statusMessage: this.translate.instant(
                    'EMBEDDED_MPV.PLAYER.LOADING_STREAM',
                ),
            };
        }

        switch (session.status) {
            case 'playing':
            case 'paused':
            case 'idle':
                return { status: session.status, statusMessage: '' };
            case 'ended':
            case 'closed':
                return { status: 'ended', statusMessage: '' };
            case 'error':
                return {
                    status: 'error',
                    statusMessage:
                        session.error ??
                        this.translate.instant(
                            'EMBEDDED_MPV.PLAYER.PLAYBACK_FAILED',
                        ),
                };
        }
    }
}
