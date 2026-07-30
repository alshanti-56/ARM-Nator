import { Injectable, inject, signal } from '@angular/core';
import type { PlayerOpenContext } from '@arm-nator/player/core';
import { PlaybackPositionService } from '@arm-nator/services';
import {
    ResolvedPortalPlayback,
    VideoPlayer,
} from '@arm-nator/shared/interfaces';
import type { PlaybackDiagnostic } from '../playback-diagnostics/playback-diagnostics.model';
import type { PlayerRuntimeSnapshot } from '../player-controls/player-controls.model';

export type WorkspacePlayerPresentation = 'expanded' | 'mini';

@Injectable({ providedIn: 'root' })
export class WorkspacePlayerStateService {
    private readonly playbackPositions = inject(PlaybackPositionService);
    private readonly lastSavedAt = new Map<string, number>();
    private lastTimeUpdate: { currentTime: number; duration: number } | null =
        null;

    readonly playback = signal<ResolvedPortalPlayback | null>(null);
    readonly engine = signal<VideoPlayer>(VideoPlayer.ArtPlayer);
    readonly presentation = signal<WorkspacePlayerPresentation>('mini');
    readonly reloadGeneration = signal(0);
    readonly runtimeSnapshot = signal<PlayerRuntimeSnapshot | null>(null);
    readonly diagnostic = signal<PlaybackDiagnostic | null>(null);
    readonly context = signal<PlayerOpenContext | null>(null);
    readonly stopped = signal(false);

    open(
        playback: ResolvedPortalPlayback,
        engine: VideoPlayer,
        context?: PlayerOpenContext
    ): void {
        const replacingPlayback = this.playback() !== null;
        if (replacingPlayback) {
            void this.persistPosition(this.lastTimeUpdate, true);
            this.context()?.onClosed?.();
        }
        this.playback.set(playback);
        this.engine.set(engine);
        this.context.set(context ?? null);
        this.lastTimeUpdate = null;
        this.runtimeSnapshot.set(null);
        this.diagnostic.set(null);
        this.stopped.set(false);
        if (!replacingPlayback) {
            this.presentation.set('mini');
        }
        this.reloadGeneration.update((value) => value + 1);
    }

    switchEngine(engine: VideoPlayer): void {
        if (engine === this.engine()) {
            return;
        }
        this.engine.set(engine);
        this.runtimeSnapshot.set(null);
        this.diagnostic.set(null);
        this.stopped.set(false);
        this.reloadGeneration.update((value) => value + 1);
    }

    restart(): void {
        if (!this.playback()) {
            return;
        }
        this.runtimeSnapshot.set(null);
        this.diagnostic.set(null);
        this.stopped.set(false);
        this.reloadGeneration.update((value) => value + 1);
    }

    stop(): void {
        if (this.playback()) {
            this.stopped.set(true);
        }
    }

    minimize(): void {
        if (this.playback()) {
            this.presentation.set('mini');
        }
    }

    expand(): void {
        if (this.playback()) {
            this.presentation.set('expanded');
        }
    }

    close(): void {
        const onClosed = this.context()?.onClosed;
        void this.persistPosition(this.lastTimeUpdate, true);
        this.playback.set(null);
        this.context.set(null);
        this.lastTimeUpdate = null;
        this.runtimeSnapshot.set(null);
        this.diagnostic.set(null);
        this.stopped.set(false);
        onClosed?.();
    }

    onRuntimeSnapshot(snapshot: PlayerRuntimeSnapshot): void {
        this.runtimeSnapshot.set(snapshot);
    }

    onDiagnostic(diagnostic: PlaybackDiagnostic | null): void {
        this.diagnostic.set(diagnostic);
    }

    onTimeUpdate(event: {
        currentTime: number;
        duration: number;
    }): void {
        this.lastTimeUpdate = event;
        this.context()?.onTimeUpdate?.(event);
        void this.persistPosition(event);
    }

    onEnded(): void {
        const context = this.context();
        context?.onEnded?.();
        if (context?.autoplayNext && context.canNext) {
            context.onNext?.();
        }
    }

    previous(): void {
        if (this.context()?.canPrevious) {
            this.context()?.onPrevious?.();
        }
    }

    next(): void {
        if (this.context()?.canNext) {
            this.context()?.onNext?.();
        }
    }

    private async persistPosition(
        event: { currentTime: number; duration: number } | null,
        force = false
    ): Promise<void> {
        const contentInfo = this.playback()?.contentInfo;
        if (
            !event ||
            !contentInfo ||
            (contentInfo.contentType !== 'vod' &&
                contentInfo.contentType !== 'episode')
        ) {
            return;
        }

        const identity = [
            contentInfo.playlistId,
            contentInfo.contentType,
            contentInfo.contentXtreamId,
        ].join(':');
        const now = Date.now();
        if (!force && now - (this.lastSavedAt.get(identity) ?? 0) < 15_000) {
            return;
        }
        this.lastSavedAt.set(identity, now);

        await this.playbackPositions.savePlaybackPosition(
            contentInfo.playlistId,
            {
                ...contentInfo,
                positionSeconds: Math.max(0, Math.floor(event.currentTime)),
                durationSeconds: Math.max(0, Math.floor(event.duration)),
            }
        );
    }
}
