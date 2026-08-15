import { powerSaveBlocker } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import App from '../app';
import {
    EmbeddedMpvAudioTrack,
    EmbeddedMpvBounds,
    EmbeddedMpvCapabilities,
    EmbeddedMpvSession,
    EmbeddedMpvSessionStatus,
    EmbeddedMpvSubtitleTrack,
    EmbeddedMpvSupport,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
    EMBEDDED_MPV_SESSION_UPDATE,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';
import { toNativeViewBounds } from './embedded-mpv-bounds.util';
import { getEmbeddedMpvAddonCandidatePaths } from './embedded-mpv-platform.util';
import { isEmbeddedMpvFeatureEnabled } from './embedded-mpv-runtime-policy.util';

export interface NativeEmbeddedMpvSessionSnapshot {
    status: EmbeddedMpvSessionStatus;
    positionSeconds: number;
    durationSeconds: number | null;
    volume: number;
    streamUrl: string;
    audioTracks?: EmbeddedMpvAudioTrack[];
    selectedAudioTrackId?: number | null;
    subtitleTracks?: EmbeddedMpvSubtitleTrack[];
    selectedSubtitleTrackId?: number | null;
    playbackSpeed?: number;
    aspectOverride?: string;
    picture?: PlayerPictureSettings;
    videoWidth?: number;
    videoHeight?: number;
    container?: string;
    videoCodec?: string;
    audioCodec?: string;
    hwdecCurrent?: string;
    fps?: number;
    bitrate?: number;
    droppedFrames?: number;
    bufferedSeconds?: number;
    error?: string;
}

export interface NativeEmbeddedMpvAddon {
    isSupported(): boolean;
    createSession(
        windowHandle: Buffer,
        bounds: EmbeddedMpvBounds,
        title?: string,
        initialVolume?: number
    ): string;
    loadPlayback(sessionId: string, playback: ResolvedPortalPlayback): void;
    setBounds(sessionId: string, bounds: EmbeddedMpvBounds): void;
    setPaused(sessionId: string, paused: boolean): void;
    seek(sessionId: string, seconds: number): void;
    setVolume(sessionId: string, volume: number): void;
    setAudioTrack(sessionId: string, trackId: number): void;
    setSubtitleTrack?(sessionId: string, trackId: number): void;
    setSubtitleFile?(sessionId: string, filePath: string): void;
    setSubtitleSettings?(sessionId: string, settings: PlayerSubtitleSettings): void;
    setSpeed?(sessionId: string, speed: number): void;
    setAspect?(sessionId: string, aspect: string): void;
    setPicture?(sessionId: string, picture: PlayerPictureSettings): void;
    getSessionSnapshot(
        sessionId: string
    ): NativeEmbeddedMpvSessionSnapshot | null;
    disposeSession(sessionId: string): void;
}

interface EmbeddedMpvRuntimeSession {
    id: string;
    title: string;
    streamUrl: string;
    startedAt: string;
    updatedAt: string;
    lastPayloadKey: string;
    lastStatus: EmbeddedMpvSessionStatus | null;
}

export class EmbeddedMpvNativeService {
    private addon: NativeEmbeddedMpvAddon | null = null;
    private addonLoadError: Error | null = null;
    private readonly sessions = new Map<string, EmbeddedMpvRuntimeSession>();
    private pollingTimer: NodeJS.Timeout | null = null;
    private readonly pollFailuresLogged = new Set<string>();
    private powerBlockerId: number | null = null;
    private readonly loadAddonModule = createRequire(__filename);
    private getMainWindowZoomFactor(): number {
        try {
            if (!App.mainWindow || App.mainWindow.isDestroyed()) {
                return 1;
            }
            return App.mainWindow.webContents.getZoomFactor();
        } catch {
            return 1;
        }
    }

    /**
     * Renderer bounds arrive in CSS pixels; the native-view engines position
     * the macOS NSView in points, so at
     * page zoom or display scale ≠ 100% the raw values land the video toward
     * the window's top-left corner at a fraction of its size (#1145).
     */
    private scaleBoundsForNativeView(
        bounds: EmbeddedMpvBounds
    ): EmbeddedMpvBounds {
        return toNativeViewBounds(bounds, {
            zoomFactor: this.getMainWindowZoomFactor(),
        });
    }

    private detectCapabilities(): EmbeddedMpvCapabilities {
        const addon = this.addon;
        return {
            subtitles: typeof addon?.setSubtitleTrack === 'function',
            playbackSpeed: typeof addon?.setSpeed === 'function',
            aspectOverride: typeof addon?.setAspect === 'function',
            pictureAdjustments: typeof addon?.setPicture === 'function',
        };
    }

    getSupport(): EmbeddedMpvSupport {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') {
            return {
                supported: false,
                platform: process.platform,
                reason: 'Embedded MPV requires macOS on Apple Silicon.',
            };
        }

        if (!isEmbeddedMpvFeatureEnabled()) {
            return {
                supported: false,
                platform: process.platform,
                reason: 'Embedded MPV is disabled by the current runtime policy.',
            };
        }

        if (this.addon) {
            try {
                if (!this.addon.isSupported()) {
                    return {
                        supported: false,
                        platform: process.platform,
                        reason: 'The native embedded MPV addon reported itself as unsupported.',
                    };
                }

                return {
                    supported: true,
                    platform: process.platform,
                    capabilities: this.detectCapabilities(),
                };
            } catch (error) {
                return {
                    supported: false,
                    platform: process.platform,
                    reason:
                        error instanceof Error ? error.message : String(error),
                };
            }
        }

        if (this.addonLoadError) {
            return {
                supported: false,
                platform: process.platform,
                reason: this.addonLoadError.message,
            };
        }

        const candidatePaths = this.getAddonCandidatePaths();
        const existingCandidatePath = candidatePaths.find((candidatePath) =>
            existsSync(candidatePath)
        );

        if (!existingCandidatePath) {
            return {
                supported: false,
                platform: process.platform,
                reason:
                    this.readUnavailableReason(candidatePaths) ??
                    [
                        'Unable to locate the embedded MPV native addon.',
                        ...candidatePaths.map(
                            (candidatePath) => `- ${candidatePath}`
                        ),
                    ].join('\n'),
            };
        }

        const missingRuntimeReason = this.getMissingRuntimeReason(
            existingCandidatePath
        );
        if (missingRuntimeReason) {
            return {
                supported: false,
                platform: process.platform,
                reason: missingRuntimeReason,
            };
        }

        try {
            const addon = this.getAddon();
            if (!addon.isSupported()) {
                return {
                    supported: false,
                    platform: process.platform,
                    reason: 'The native embedded MPV addon reported itself as unsupported.',
                };
            }

            return {
                supported: true,
                platform: process.platform,
                capabilities: this.detectCapabilities(),
            };
        } catch (error) {
            return {
                supported: false,
                platform: process.platform,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    prepareAddon(): EmbeddedMpvSupport {
        const support = this.getSupport();
        if (!support.supported) {
            return support;
        }

        try {
            const addon = this.getAddon();
            if (!addon.isSupported()) {
                return {
                    supported: false,
                    platform: process.platform,
                    reason: 'The native embedded MPV addon reported itself as unsupported.',
                };
            }

            return {
                supported: true,
                platform: process.platform,
                capabilities: this.detectCapabilities(),
            };
        } catch (error) {
            return {
                supported: false,
                platform: process.platform,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
    }

    createSession(
        bounds: EmbeddedMpvBounds,
        title = '',
        initialVolume = 1
    ): EmbeddedMpvSession {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        const startedAt = new Date().toISOString();
        const sessionId = addon.createSession(
            this.getMainWindowHandle(),
            this.scaleBoundsForNativeView(bounds),
            title,
            initialVolume
        );

        this.sessions.set(sessionId, {
            id: sessionId,
            title,
            streamUrl: '',
            startedAt,
            updatedAt: startedAt,
            lastPayloadKey: '',
            lastStatus: null,
        });

        this.ensurePolling();
        this.ensureRendererLifecycleWatch();
        return (
            this.refreshSession(sessionId) ?? {
                id: sessionId,
                title,
                streamUrl: '',
                status: 'idle',
                positionSeconds: 0,
                durationSeconds: null,
                volume: 1,
                audioTracks: [],
                selectedAudioTrackId: null,
                subtitleTracks: [],
                selectedSubtitleTrackId: null,
                playbackSpeed: 1,
                aspectOverride: 'no',
                picture: {
                    brightness: 0,
                    contrast: 0,
                    blackLevel: 0,
                    saturation: 0,
                    gamma: 0,
                },
                startedAt,
                updatedAt: startedAt,
            }
        );
    }

    loadPlayback(sessionId: string, playback: ResolvedPortalPlayback): void {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        const session = this.getRuntimeSession(sessionId);
        session.title = playback.title ?? session.title;
        session.streamUrl = playback.streamUrl ?? session.streamUrl;
        session.updatedAt = new Date().toISOString();
        addon.loadPlayback(sessionId, playback);
        this.refreshSession(sessionId);
    }

    setBounds(sessionId: string, bounds: EmbeddedMpvBounds): void {
        this.assertEmbeddedMpvEnabled();
        this.getAddon().setBounds(
            sessionId,
            this.scaleBoundsForNativeView(bounds)
        );
    }

    setPaused(sessionId: string, paused: boolean): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        this.getAddon().setPaused(sessionId, paused);
        return this.refreshSession(sessionId);
    }

    seek(sessionId: string, seconds: number): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        this.getAddon().seek(sessionId, seconds);
        return this.refreshSession(sessionId);
    }

    setVolume(sessionId: string, volume: number): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        this.getAddon().setVolume(sessionId, volume);
        return this.refreshSession(sessionId);
    }

    setAudioTrack(
        sessionId: string,
        trackId: number
    ): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        this.getAddon().setAudioTrack(sessionId, trackId);
        return this.refreshSession(sessionId);
    }

    setSubtitleTrack(
        sessionId: string,
        trackId: number
    ): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setSubtitleTrack !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support subtitle tracks. Rebuild the native addon to enable this feature.'
            );
        }
        addon.setSubtitleTrack(sessionId, trackId);
        return this.refreshSession(sessionId);
    }

    setSubtitleFile(
        sessionId: string,
        filePath: string
    ): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setSubtitleFile !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support external subtitle files.'
            );
        }
        addon.setSubtitleFile(sessionId, filePath);
        return this.refreshSession(sessionId);
    }

    setSubtitleSettings(
        sessionId: string,
        settings: PlayerSubtitleSettings
    ): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setSubtitleSettings !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support subtitle settings.'
            );
        }
        addon.setSubtitleSettings(sessionId, settings);
        return this.refreshSession(sessionId);
    }

    setSpeed(sessionId: string, speed: number): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setSpeed !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support playback speed. Rebuild the native addon to enable this feature.'
            );
        }
        addon.setSpeed(sessionId, speed);
        return this.refreshSession(sessionId);
    }

    setAspect(sessionId: string, aspect: string): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setAspect !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support aspect override. Rebuild the native addon to enable this feature.'
            );
        }
        addon.setAspect(sessionId, aspect);
        return this.refreshSession(sessionId);
    }

    setPicture(
        sessionId: string,
        picture: PlayerPictureSettings
    ): EmbeddedMpvSession | null {
        this.assertEmbeddedMpvEnabled();
        const addon = this.getAddon();
        if (typeof addon.setPicture !== 'function') {
            throw new Error(
                'Embedded MPV addon does not support picture adjustments.'
            );
        }
        addon.setPicture(sessionId, picture);
        return this.refreshSession(sessionId);
    }

    disposeSession(sessionId: string): EmbeddedMpvSession | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }

        try {
            const addon = this.getAddon();
            addon.disposeSession(sessionId);
        } finally {
            this.sessions.delete(sessionId);
            this.pollFailuresLogged.delete(sessionId);
            const payload: EmbeddedMpvSession = {
                id: session.id,
                title: session.title,
                streamUrl: session.streamUrl,
                status: 'closed',
                positionSeconds: 0,
                durationSeconds: null,
                volume: 1,
                audioTracks: [],
                selectedAudioTrackId: null,
                subtitleTracks: [],
                selectedSubtitleTrackId: null,
                playbackSpeed: 1,
                aspectOverride: 'no',
                picture: {
                    brightness: 0,
                    contrast: 0,
                    blackLevel: 0,
                    saturation: 0,
                    gamma: 0,
                },
                startedAt: session.startedAt,
                updatedAt: new Date().toISOString(),
            };
            this.sendSessionUpdate(payload);
            this.stopPollingIfIdle();
            this.updatePowerBlocker();
            return payload;
        }
    }

    shutdown(): void {
        const sessionIds = [...this.sessions.keys()];
        sessionIds.forEach((sessionId) => this.disposeSession(sessionId));
        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
        this.updatePowerBlocker();
    }

    private ensurePolling(): void {
        if (this.pollingTimer) {
            return;
        }

        this.pollingTimer = setInterval(() => {
            [...this.sessions.keys()].forEach((sessionId) => {
                const session = this.sessions.get(sessionId);
                if (
                    session?.lastStatus === 'paused' ||
                    session?.lastStatus === 'ended' ||
                    session?.lastStatus === 'error' ||
                    session?.lastStatus === 'idle'
                ) {
                    return;
                }
                // An addon-side throw must not escape the interval callback:
                // it would surface as an uncaughtException in the main
                // process every 500 ms while the timer keeps running. Log
                // each session's first failure only — tracked per session so
                // a healthy session in the same tick cannot reset the
                // suppression for a failing one.
                try {
                    this.refreshSession(sessionId);
                    this.pollFailuresLogged.delete(sessionId);
                } catch (error) {
                    if (!this.pollFailuresLogged.has(sessionId)) {
                        this.pollFailuresLogged.add(sessionId);
                        console.error(
                            `[Embedded MPV] Polling session "${sessionId}" failed:`,
                            error
                        );
                    }
                }
            });
        }, 500);
    }

    /**
     * Sessions are torn down by the renderer's Angular lifecycle, which
     * never runs when the renderer crashes or hard-reloads (dev-server HMR,
     * Cmd+R). Without this watch, native mpv handles leak until app shutdown.
     */
    private rendererWatchInstalled = false;

    private ensureRendererLifecycleWatch(): void {
        if (
            this.rendererWatchInstalled ||
            !App.mainWindow ||
            App.mainWindow.isDestroyed()
        ) {
            return;
        }
        this.rendererWatchInstalled = true;

        const disposeAll = (reason: string) => {
            if (this.sessions.size === 0) {
                return;
            }
            console.warn(
                `[Embedded MPV] Disposing ${this.sessions.size} session(s): renderer ${reason}`
            );
            [...this.sessions.keys()].forEach((sessionId) => {
                try {
                    this.disposeSession(sessionId);
                } catch {
                    // best-effort reaping; polling cleanup handles the rest
                }
            });
        };

        App.mainWindow.webContents.on(
            'render-process-gone',
            (_event, details) => disposeAll(`process gone (${details.reason})`)
        );
        // Full navigations/reloads only — in-app Angular routing emits
        // did-navigate-in-page and must not kill the active session.
        App.mainWindow.webContents.on('did-navigate', () =>
            disposeAll('reloaded')
        );
    }

    private stopPollingIfIdle(): void {
        if (this.sessions.size > 0 || !this.pollingTimer) {
            return;
        }

        clearInterval(this.pollingTimer);
        this.pollingTimer = null;
    }

    private refreshSession(sessionId: string): EmbeddedMpvSession | null {
        const addon = this.getAddon();
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }

        const snapshot = addon.getSessionSnapshot(sessionId);
        if (!snapshot) {
            return null;
        }

        const payload: EmbeddedMpvSession = {
            id: session.id,
            title: session.title,
            streamUrl: snapshot.streamUrl || session.streamUrl,
            status: snapshot.status,
            positionSeconds: Math.max(0, Math.floor(snapshot.positionSeconds)),
            durationSeconds:
                typeof snapshot.durationSeconds === 'number'
                    ? Math.max(0, Math.floor(snapshot.durationSeconds))
                    : null,
            volume: typeof snapshot.volume === 'number' ? snapshot.volume : 1,
            ...(typeof snapshot.videoWidth === 'number' &&
            typeof snapshot.videoHeight === 'number'
                ? {
                      videoWidth: snapshot.videoWidth,
                      videoHeight: snapshot.videoHeight,
                  }
                : {}),
            ...(typeof snapshot.container === 'string'
                ? { container: snapshot.container }
                : {}),
            audioTracks: Array.isArray(snapshot.audioTracks)
                ? snapshot.audioTracks
                : [],
            selectedAudioTrackId:
                typeof snapshot.selectedAudioTrackId === 'number'
                    ? snapshot.selectedAudioTrackId
                    : null,
            subtitleTracks: Array.isArray(snapshot.subtitleTracks)
                ? snapshot.subtitleTracks
                : [],
            selectedSubtitleTrackId:
                typeof snapshot.selectedSubtitleTrackId === 'number'
                    ? snapshot.selectedSubtitleTrackId
                    : null,
            playbackSpeed:
                typeof snapshot.playbackSpeed === 'number'
                    ? snapshot.playbackSpeed
                    : 1,
            aspectOverride:
                typeof snapshot.aspectOverride === 'string'
                    ? snapshot.aspectOverride
                    : 'no',
            picture: snapshot.picture ?? {
                brightness: 0,
                contrast: 0,
                blackLevel: 0,
                saturation: 0,
                gamma: 0,
            },
            ...(typeof snapshot.videoWidth === 'number' &&
            typeof snapshot.videoHeight === 'number'
                ? {
                      videoWidth: snapshot.videoWidth,
                      videoHeight: snapshot.videoHeight,
                  }
                : {}),
            ...(typeof snapshot.videoCodec === 'string'
                ? { videoCodec: snapshot.videoCodec }
                : {}),
            ...(typeof snapshot.audioCodec === 'string'
                ? { audioCodec: snapshot.audioCodec }
                : {}),
            ...(typeof snapshot.hwdecCurrent === 'string'
                ? { hwdecCurrent: snapshot.hwdecCurrent }
                : {}),
            ...(typeof snapshot.fps === 'number' ? { fps: snapshot.fps } : {}),
            ...(typeof snapshot.bitrate === 'number'
                ? { bitrate: snapshot.bitrate }
                : {}),
            ...(typeof snapshot.droppedFrames === 'number'
                ? { droppedFrames: snapshot.droppedFrames }
                : {}),
            ...(typeof snapshot.bufferedSeconds === 'number'
                ? { bufferedSeconds: snapshot.bufferedSeconds }
                : {}),
            startedAt: session.startedAt,
            updatedAt: new Date().toISOString(),
            ...(snapshot.error ? { error: snapshot.error } : {}),
        };

        session.streamUrl = payload.streamUrl;
        session.updatedAt = payload.updatedAt;
        session.lastStatus = payload.status;
        // The refresh timestamp must not participate in the diff key,
        // otherwise every poll tick looks like a change and the renderer
        // receives an IPC update every 500 ms even while paused.
        const nextPayloadKey = JSON.stringify({ ...payload, updatedAt: '' });
        if (session.lastPayloadKey !== nextPayloadKey) {
            session.lastPayloadKey = nextPayloadKey;
            this.sendSessionUpdate(payload);
        }

        this.updatePowerBlocker();
        return payload;
    }

    private hasPlayingSession(): boolean {
        for (const session of this.sessions.values()) {
            if (session.lastStatus === 'playing') {
                return true;
            }
        }
        return false;
    }

    private updatePowerBlocker(): void {
        const shouldBlock = this.hasPlayingSession();

        if (shouldBlock && this.powerBlockerId === null) {
            try {
                this.powerBlockerId = powerSaveBlocker.start(
                    'prevent-display-sleep'
                );
            } catch {
                this.powerBlockerId = null;
            }
            return;
        }

        if (!shouldBlock && this.powerBlockerId !== null) {
            const blockerId = this.powerBlockerId;
            this.powerBlockerId = null;
            try {
                if (powerSaveBlocker.isStarted(blockerId)) {
                    powerSaveBlocker.stop(blockerId);
                }
            } catch {
                // ignore — assertion will be cleaned up when the process exits
            }
        }
    }

    private sendSessionUpdate(session: EmbeddedMpvSession): void {
        if (!App.mainWindow || App.mainWindow.isDestroyed()) {
            return;
        }

        App.mainWindow.webContents.send(EMBEDDED_MPV_SESSION_UPDATE, session);
    }

    private getRuntimeSession(sessionId: string): EmbeddedMpvRuntimeSession {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(
                `Embedded MPV session "${sessionId}" was not found.`
            );
        }

        return session;
    }

    private getMainWindowHandle(): Buffer {
        if (!App.mainWindow || App.mainWindow.isDestroyed()) {
            throw new Error('The Electron main window is not available.');
        }

        return App.mainWindow.getNativeWindowHandle();
    }

    private assertEmbeddedMpvEnabled(): void {
        if (!isEmbeddedMpvFeatureEnabled()) {
            throw new Error(
                'Embedded MPV is disabled by the current runtime policy.'
            );
        }
    }

    private getAddon(): NativeEmbeddedMpvAddon {
        if (this.addon) {
            return this.addon;
        }

        if (this.addonLoadError) {
            throw this.addonLoadError;
        }

        const candidatePaths = this.getAddonCandidatePaths();

        const existingCandidatePaths = candidatePaths.filter((candidatePath) =>
            existsSync(candidatePath)
        );

        if (existingCandidatePaths.length === 0) {
            this.addonLoadError = new Error(
                [
                    'Unable to locate the embedded MPV native addon.',
                    ...candidatePaths.map(
                        (candidatePath) => `- ${candidatePath}`
                    ),
                ].join('\n')
            );
            throw this.addonLoadError;
        }

        const loadErrors: string[] = [];
        for (const candidatePath of existingCandidatePaths) {
            try {
                this.addon = this.loadAddonModule(
                    candidatePath
                ) as NativeEmbeddedMpvAddon;
                return this.addon;
            } catch (error) {
                loadErrors.push(
                    `${candidatePath}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
            }
        }

        this.addonLoadError = new Error(
            [
                'Unable to load the embedded MPV native addon.',
                ...loadErrors.map((error) => `- ${error}`),
            ].join('\n')
        );
        throw this.addonLoadError;
    }

    private getAddonCandidatePaths(): string[] {
        return getEmbeddedMpvAddonCandidatePaths();
    }

    private readUnavailableReason(candidatePaths: string[]): string | null {
        for (const candidatePath of candidatePaths) {
            const unavailablePath = path.join(
                path.dirname(candidatePath),
                'embedded-mpv-unavailable.txt'
            );

            if (existsSync(unavailablePath)) {
                return readFileSync(unavailablePath, 'utf8').trim();
            }
        }

        return null;
    }

    private getMissingRuntimeReason(addonPath: string): string | null {
        const nativeDir = path.dirname(addonPath);
        const runtimeCandidates = this.getRuntimeLibraryCandidates(nativeDir);

        if (runtimeCandidates.length === 0) {
            return null;
        }

        if (!runtimeCandidates.some((candidate) => existsSync(candidate))) {
            return [
                'Embedded MPV runtime is incomplete. Missing one of:',
                ...runtimeCandidates.map((candidate) => `- ${candidate}`),
            ].join('\n');
        }

        return null;
    }

    private getRuntimeLibraryCandidates(nativeDir: string): string[] {
        return [
            path.join(nativeDir, 'lib', 'libmpv.2.dylib'),
            path.join(nativeDir, 'lib', 'libmpv.dylib'),
        ];
    }
}

export const embeddedMpvNativeService = new EmbeddedMpvNativeService();
