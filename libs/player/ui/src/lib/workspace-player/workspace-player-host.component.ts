import {
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    computed,
    inject,
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
import { VideoPlayer } from '@arm-nator/shared/interfaces';
import type { PlaybackFallbackRequest } from '../playback-diagnostics/playback-diagnostics.model';
import { WebPlayerViewComponent } from '../web-player-view/web-player-view.component';
import { WorkspacePlayerStateService } from './workspace-player-state.service';

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

    readonly state = inject(WorkspacePlayerStateService);
    readonly engines = PLAYER_ENGINES;
    readonly isMini = computed(() => this.state.presentation() === 'mini');
    readonly snapshot = this.state.runtimeSnapshot;
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
            codec: media.videoCodec ?? media.container ?? '—',
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

    async takeScreenshot(): Promise<void> {
        const timestamp = Date.now();
        try {
            const canvas = this.element.querySelector(
                'canvas[data-embedded-mpv-frame]'
            ) as HTMLCanvasElement | null;
            if (canvas?.width && canvas.height) {
                this.downloadDataUrl(
                    canvas.toDataURL('image/png'),
                    `arm-nator-frame-${timestamp}.png`
                );
                return;
            }

            const sessionId = this.snapshot()?.engine?.sessionId;
            if (
                sessionId &&
                window.electron?.takeEmbeddedMpvScreenshot &&
                window.electron?.saveFileDialog
            ) {
                const targetPath = await window.electron.saveFileDialog(
                    `arm-nator-frame-${timestamp}.png`,
                    [{ name: 'PNG image', extensions: ['png'] }]
                );
                if (targetPath) {
                    await window.electron.takeEmbeddedMpvScreenshot(
                        sessionId,
                        targetPath
                    );
                }
                return;
            }

            const video = this.element.querySelector('video');
            if (!video?.videoWidth || !video.videoHeight) {
                return;
            }
            const output = document.createElement('canvas');
            output.width = video.videoWidth;
            output.height = video.videoHeight;
            output.getContext('2d')?.drawImage(video, 0, 0);
            this.downloadDataUrl(
                output.toDataURL('image/png'),
                `arm-nator-frame-${timestamp}.png`
            );
        } catch {
            // Cross-origin web video may intentionally prevent canvas capture.
        }
    }

    onTimeUpdate(event: {
        currentTime: number;
        duration: number;
    }): void {
        this.state.onTimeUpdate(event);
    }

    private downloadDataUrl(dataUrl: string, filename: string): void {
        const link = document.createElement('a');
        link.download = filename;
        link.href = dataUrl;
        link.click();
    }
}
