import { Signal, WritableSignal } from '@angular/core';
import {
    EmbeddedMpvBackend,
    EmbeddedMpvSession,
    KsPlayerMetalControls,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';

type ElectronBridge = Window['electron'];
type KsPlayerMetalControl = keyof KsPlayerMetalControls;

/** Context the runner reads/writes; the controller owns all signals. */
export interface EmbeddedMpvCommandContext {
    readonly backend?: Signal<EmbeddedMpvBackend>;
    readonly sessionId: Signal<string | null>;
    readonly session: WritableSignal<EmbeddedMpvSession | null>;
    readonly playback?: Signal<ResolvedPortalPlayback | null>;
    readonly supportedControls?: Signal<KsPlayerMetalControls | null>;
}

/**
 * Backend-aware IPC delegators. Every KSPlayer Metal command is dispatched to
 * a KS channel, and every embedded-MPV command remains on the legacy channel.
 */
export class EmbeddedMpvCommandRunner {
    constructor(private readonly ctx: EmbeddedMpvCommandContext) {}

    async togglePaused(): Promise<void> {
        const id = this.ctx.sessionId();
        const session = this.ctx.session();
        const electron = this.bridge();
        if (!id || !session || !electron || !this.supports('pause')) {
            return;
        }
        const playback = this.ctx.playback?.() ?? null;
        const resumeLiveAtEdge =
            session.status === 'paused' &&
            playback !== null &&
            this.isLivePlayback(playback);
        if (this.backend() === 'ksplayer-metal') {
            if (resumeLiveAtEdge && playback) {
                await this.run(id, async () => {
                    await electron.loadKsPlayerMetalPlayback(id, playback);
                    return electron.setKsPlayerMetalPaused(id, false);
                });
                return;
            }
            await this.run(id, () =>
                electron.setKsPlayerMetalPaused(id, session.status !== 'paused')
            );
            return;
        }
        if (!electron.setEmbeddedMpvPaused) {
            return;
        }
        if (resumeLiveAtEdge && playback) {
            await this.run(id, async () => {
                await electron.loadEmbeddedMpvPlayback(id, playback);
                return electron.setEmbeddedMpvPaused(id, false);
            });
            return;
        }
        await this.run(id, () =>
            electron.setEmbeddedMpvPaused(id, session.status !== 'paused')
        );
    }

    async seekBy(deltaSeconds: number): Promise<boolean> {
        const id = this.ctx.sessionId();
        const session = this.ctx.session();
        const electron = this.bridge();
        if (!id || !session || !electron || !this.supports('seek')) {
            return false;
        }
        const next = Math.max(0, session.positionSeconds + deltaSeconds);
        if (this.backend() === 'ksplayer-metal') {
            await this.run(id, () => electron.seekKsPlayerMetal(id, next));
        } else if (electron.seekEmbeddedMpv) {
            await this.run(id, () => electron.seekEmbeddedMpv(id, next));
        } else {
            return false;
        }
        return true;
    }

    async seekTo(seconds: number): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (!id || !electron || !this.supports('seek')) {
            return;
        }
        if (this.backend() === 'ksplayer-metal') {
            await this.run(id, () => electron.seekKsPlayerMetal(id, seconds));
        } else if (electron.seekEmbeddedMpv) {
            await this.run(id, () => electron.seekEmbeddedMpv(id, seconds));
        }
    }

    async applyVolume(value: number): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (!id || !electron || !this.supports('volume')) {
            return;
        }
        if (this.backend() === 'ksplayer-metal') {
            await this.run(id, () => electron.setKsPlayerMetalVolume(id, value));
        } else if (electron.setEmbeddedMpvVolume) {
            await this.run(id, () => electron.setEmbeddedMpvVolume(id, value));
        }
    }

    async setAudioTrack(trackId: number): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (!id || !electron) {
            return;
        }
        if (this.backend() === 'ksplayer-metal') {
            if (!this.supports('audioTracks')) {
                return;
            }
            await this.run(id, () =>
                electron.setKsPlayerMetalAudioTrack(id, trackId)
            );
            return;
        }
        if (!electron.setEmbeddedMpvAudioTrack) {
            return;
        }
        await this.run(id, () => electron.setEmbeddedMpvAudioTrack(id, trackId));
    }

    async setSubtitleTrack(trackId: number): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (this.backend() === 'ksplayer-metal') {
            const setSubtitleTrack = electron?.setKsPlayerMetalSubtitleTrack;
            if (!id || !setSubtitleTrack || !this.supports('subtitles')) {
                return;
            }
            await this.run(id, () => setSubtitleTrack(id, trackId));
            return;
        }
        const setSubtitleTrack = electron?.setEmbeddedMpvSubtitleTrack;
        if (!id || !setSubtitleTrack) {
            return;
        }
        await this.run(id, () => setSubtitleTrack(id, trackId));
    }

    async setSubtitleFile(filePath: string): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (this.backend() === 'ksplayer-metal') {
            const setSubtitleFile = electron?.setKsPlayerMetalSubtitleFile;
            if (!id || !filePath || !setSubtitleFile || !this.supports('subtitles')) {
                return;
            }
            await this.run(id, () => setSubtitleFile(id, filePath));
            return;
        }
        const setSubtitleFile = electron?.setEmbeddedMpvSubtitleFile;
        if (!id || !filePath || !setSubtitleFile) {
            return;
        }
        await this.run(id, () => setSubtitleFile(id, filePath));
    }

    async setSubtitleSettings(settings: PlayerSubtitleSettings): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (this.backend() === 'ksplayer-metal') {
            const setSubtitleSettings = electron?.setKsPlayerMetalSubtitleSettings;
            if (!id || !setSubtitleSettings || !this.supports('subtitles')) {
                return;
            }
            await this.run(id, () => setSubtitleSettings(id, settings));
            return;
        }
        const setSubtitleSettings = electron?.setEmbeddedMpvSubtitleSettings;
        if (!id || !setSubtitleSettings) {
            return;
        }
        await this.run(id, () => setSubtitleSettings(id, settings));
    }

    async setSpeed(speed: number): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (!id || !electron || !this.supports('playbackSpeed')) {
            return;
        }
        if (this.backend() === 'ksplayer-metal') {
            await this.run(id, () => electron.setKsPlayerMetalSpeed(id, speed));
        } else {
            const setEmbeddedMpvSpeed = electron.setEmbeddedMpvSpeed;
            if (setEmbeddedMpvSpeed) {
                await this.run(id, () => setEmbeddedMpvSpeed(id, speed));
            }
        }
    }

    async setAspect(aspect: string): Promise<void> {
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        if (this.backend() === 'ksplayer-metal') {
            const setAspect = electron?.setKsPlayerMetalAspect;
            if (!id || !setAspect || !this.supports('aspectOverride')) {
                return;
            }
            await this.run(id, () => setAspect(id, aspect));
            return;
        }
        const setAspect = electron?.setEmbeddedMpvAspect;
        if (!id || !setAspect) {
            return;
        }
        await this.run(id, () => setAspect(id, aspect));
    }

    async setPicture(picture: PlayerPictureSettings): Promise<void> {
        if (this.backend() === 'ksplayer-metal') {
            const id = this.ctx.sessionId();
            const electron = this.bridge();
            const setPicture = electron?.setKsPlayerMetalPicture;
            if (!id || !setPicture || !this.supports('pictureAdjustments')) {
                return;
            }
            await this.run(id, () => setPicture(id, picture));
            return;
        }
        const id = this.ctx.sessionId();
        const electron = this.bridge();
        const setPicture = electron?.setEmbeddedMpvPicture;
        if (!id || !setPicture) {
            return;
        }
        await this.run(id, () => setPicture(id, picture));
    }

    private async run(
        expectedSessionId: string,
        call: () => Promise<EmbeddedMpvSession | null>
    ): Promise<EmbeddedMpvSession | null> {
        const sessionBeforeCall = this.ctx.session();
        const updated = await this.guardIpc(call);
        if (
            !updated ||
            this.ctx.sessionId() !== expectedSessionId ||
            updated.id !== expectedSessionId
        ) {
            return null;
        }
        const normalized: EmbeddedMpvSession = {
            ...updated,
            backend: updated.backend ?? this.backend(),
        };
        const current = this.ctx.session();
        if (
            current?.id === expectedSessionId &&
            this.shouldKeepCurrentSnapshot(current, normalized, sessionBeforeCall)
        ) {
            return current;
        }
        this.ctx.session.set(normalized);
        return normalized;
    }

    private shouldKeepCurrentSnapshot(
        current: EmbeddedMpvSession,
        candidate: EmbeddedMpvSession,
        sessionBeforeCall: EmbeddedMpvSession | null
    ): boolean {
        const currentUpdatedAt = Date.parse(current.updatedAt);
        const candidateUpdatedAt = Date.parse(candidate.updatedAt);
        if (
            !Number.isFinite(currentUpdatedAt) ||
            !Number.isFinite(candidateUpdatedAt)
        ) {
            return false;
        }
        return (
            currentUpdatedAt > candidateUpdatedAt ||
            (currentUpdatedAt === candidateUpdatedAt &&
                current !== sessionBeforeCall)
        );
    }

    private supports(control: KsPlayerMetalControl): boolean {
        if (this.backend() === 'embedded-mpv') {
            return true;
        }
        return this.ctx.supportedControls?.()?.[control] === true;
    }

    private isLivePlayback(playback: ResolvedPortalPlayback): boolean {
        if (typeof playback.isLive === 'boolean') {
            return playback.isLive;
        }
        return !playback.contentInfo;
    }

    private backend(): EmbeddedMpvBackend {
        return this.ctx.backend?.() ?? 'embedded-mpv';
    }

    private async guardIpc<T>(call: () => Promise<T>): Promise<T | null> {
        try {
            return await call();
        } catch {
            return null;
        }
    }

    private bridge(): ElectronBridge | undefined {
        return window.electron;
    }
}
