import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    effect,
    inject,
    viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
    PLAYER_ENGINES,
    PLAYER_FACADE,
    isManagedExternalPlayer,
} from '@arm-nator/player/core';
import { RuntimeCapabilitiesService } from '@arm-nator/services';
import type { BrowserViewBounds } from '@arm-nator/shared/interfaces';
import { VideoPlayer } from '@arm-nator/shared/interfaces';
import type { PlaybackFallbackRequest } from '../playback-diagnostics/playback-diagnostics.model';
import { WebPlayerViewComponent } from '../web-player-view/web-player-view.component';
import { WorkspacePlayerStateService } from './workspace-player-state.service';

const CODEC_ALIASES: Readonly<Record<string, string>> = {
    avc: 'H.264',
    avc1: 'H.264',
    av01: 'AV1',
    av1: 'AV1',
    h264: 'H.264',
    h265: 'HEVC',
    hevc: 'HEVC',
    hev1: 'HEVC',
    hvc1: 'HEVC',
    mpeg2video: 'MPEG-2',
    mpeg4: 'MPEG-4',
    theora: 'Theora',
    vp08: 'VP8',
    vp09: 'VP9',
    vp8: 'VP8',
    vp9: 'VP9',
};

function safeMediaLabel(value: string | undefined): string | null {
    const label = value?.trim();
    if (!label || /[\u0000-\u001f\u007f\ufffd]/u.test(label)) {
        return null;
    }
    return label;
}

function formatCodecLabel(
    codec: string | undefined,
    container: string | undefined
): string {
    const safeCodec = safeMediaLabel(codec);
    if (safeCodec) {
        return CODEC_ALIASES[safeCodec.toLowerCase()] ?? safeCodec;
    }
    return safeMediaLabel(container) ?? '—';
}

@Component({
    selector: 'app-workspace-player-host',
    imports: [MatButtonModule, MatIconModule, MatTooltipModule, WebPlayerViewComponent],
    templateUrl: './workspace-player-host.component.html',
    styleUrl: './workspace-player-host.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspacePlayerHostComponent {
    private readonly element = inject(ElementRef<HTMLElement>).nativeElement;
    private readonly player = inject(PLAYER_FACADE);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly playerSurface = viewChild<ElementRef<HTMLElement>>(
        'playerSurface'
    );
    private lastYoutubeBounds = '';

    readonly state = inject(WorkspacePlayerStateService);
    readonly engines = PLAYER_ENGINES;
    readonly isMini = computed(() => this.state.presentation() === 'mini');
    readonly isYouTube = computed(() => this.state.youtube() !== null);
    readonly mediaTitle = computed(() => {
        const youtube = this.state.youtube();
        if (youtube) {
            return youtube.title || 'YouTube';
        }
        const playback = this.state.playback();
        return playback?.title || playback?.streamUrl || '';
    });
    readonly snapshot = this.state.runtimeSnapshot;
    private readonly youtubeSurfaceEffect = effect((onCleanup) => {
        this.state.youtube();
        const surface = this.playerSurface()?.nativeElement;
        if (!surface || !window.electron) {
            this.lastYoutubeBounds = '';
            return;
        }

        const sync = (): void => this.syncYoutubeSurface();
        const observer = new ResizeObserver(sync);
        observer.observe(surface);
        window.addEventListener('resize', sync);
        sync();

        onCleanup(() => {
            observer.disconnect();
            window.removeEventListener('resize', sync);
            this.lastYoutubeBounds = '';
        });
    });
    readonly mediaSummary = computed(() => {
        const media = this.snapshot()?.media;
        if (!media) {
            return {
                resolution: '—',
                buffer: '—',
                codec: '—',
            };
        }
        return {
            resolution:
                media.width && media.height
                    ? `${media.width}×${media.height}`
                    : '—',
            buffer:
                typeof media.bufferAheadSeconds === 'number'
                    ? `${media.bufferAheadSeconds.toFixed(1)}s`
                    : typeof media.bufferedSeconds === 'number'
                      ? `${media.bufferedSeconds.toFixed(1)}s`
                      : '—',
            codec: formatCodecLabel(media.videoCodec, media.container),
        };
    });

    engineAvailable(engine: VideoPlayer): boolean {
        if (engine === VideoPlayer.EmbeddedMpv) {
            return this.runtime.supportsEmbeddedMpv;
        }
        if (isManagedExternalPlayer(engine)) {
            return this.runtime.supportsManagedExternalPlayers;
        }
        return true;
    }

    async switchEngine(engine: VideoPlayer): Promise<void> {
        const playback = this.state.playback();
        if (!playback || engine === this.state.engine()) {
            return;
        }
        if (isManagedExternalPlayer(engine)) {
            await this.player.openExternalPlayback(
                playback,
                engine === VideoPlayer.MPV ? 'mpv' : 'vlc'
            );
            this.state.close();
            return;
        }
        this.state.switchEngine(engine);
    }

    async openFallback(request: PlaybackFallbackRequest): Promise<void> {
        await this.player.openExternalPlayback(
            request.playback,
            request.player
        );
    }

    onTimeUpdate(event: {
        currentTime: number;
        duration: number;
    }): void {
        this.state.onTimeUpdate(event);
    }

    private syncYoutubeSurface(): void {
        if (!this.state.youtube() || !window.electron) {
            return;
        }

        const surface = this.playerSurface()?.nativeElement;
        if (!surface) {
            return;
        }

        const rect = surface.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        const bounds: BrowserViewBounds = {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
        const key = Object.values(bounds).join(',');
        if (key === this.lastYoutubeBounds) {
            return;
        }
        this.lastYoutubeBounds = key;
        void window.electron.setBrowserViewBounds(bounds, 'youtube-mini');
    }

}
