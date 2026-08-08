/* eslint-disable max-lines */
import {
    DestroyRef,
    Injectable,
    computed,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import {
    EmbeddedMpvBackend,
    EmbeddedMpvBounds,
    EmbeddedMpvSession,
    EmbeddedMpvSupport,
    KsPlayerMetalControls,
    KsPlayerMetalSupport,
    PlayerPictureSettings,
    PlayerSubtitleSettings,
    ResolvedPortalPlayback,
} from '@arm-nator/shared/interfaces';
import { EmbeddedMpvCommandRunner } from './embedded-mpv-command-runner';
import { measureBounds } from './embedded-mpv-format.utils';
import {
    createErrorSession,
    createLoadingSession,
    waitForStartupPaint,
} from './embedded-mpv-session-factory';
import { EmbeddedMpvStalledTracker } from './embedded-mpv-stalled-tracker';

export type EmbeddedMpvBoundsProvider = (
    host: HTMLElement
) => EmbeddedMpvBounds;

type KsPlayerMetalControl = keyof KsPlayerMetalControls;
type ElectronBridge = Window['electron'];

/**
 * Session activity is lifecycle state written by start/teardown. Reading it
 * from the startup effect must not subscribe that effect to its own writes.
 */
export function readSessionActiveUntracked(
    readSessionActive: () => boolean
): boolean {
    return untracked(readSessionActive);
}

const EMPTY_KS_CONTROLS: KsPlayerMetalControls = {
    pause: false,
    seek: false,
    volume: false,
    audioTracks: false,
    playbackSpeed: false,
};

@Injectable()
export class EmbeddedMpvSessionController {
    readonly support = signal<EmbeddedMpvSupport | null>(null);
    readonly session = signal<EmbeddedMpvSession | null>(null);
    readonly sessionId = signal<string | null>(null);
    readonly retryToken = signal(0);
    readonly activeBackend = signal<EmbeddedMpvBackend>('embedded-mpv');
    readonly supportedControls = signal<KsPlayerMetalControls | null>(null);
    readonly sessionActive = signal(false);

    private readonly stalledTracker = new EmbeddedMpvStalledTracker();
    readonly stalled = this.stalledTracker.stalled;

    private readonly commands = new EmbeddedMpvCommandRunner({
        backend: this.activeBackend,
        sessionId: this.sessionId,
        session: this.session,
        supportedControls: this.supportedControls,
    });

    private readonly sessionStatus = computed(
        () => this.session()?.status ?? null
    );

    private readonly destroyRef = inject(DestroyRef);
    private readonly unsubscribeSessionUpdate?: () => void;
    private configuredBackend: EmbeddedMpvBackend = 'embedded-mpv';
    private backendConfigured = false;
    private supportRequestId = 0;
    private pendingSupportRequest: Promise<void> | null = null;
    private pendingOperation: Promise<void> | null = null;
    private pendingCleanup: Promise<void> | null = null;

    private boundsProvider: EmbeddedMpvBoundsProvider = (host) =>
        measureBounds(host);
    private activeBoundsSync: (() => void) | null = null;
    private boundsAnimationFrame: number | null = null;

    constructor() {
        const unsubscribeEmbedded =
            window.electron?.onEmbeddedMpvSessionUpdate?.((session) =>
                this.handleSessionUpdate(session)
            );
        const unsubscribeKs = window.electron?.onKsPlayerMetalSessionUpdate?.(
            (session) => this.handleSessionUpdate(session)
        );
        this.unsubscribeSessionUpdate = () => {
            unsubscribeEmbedded?.();
            unsubscribeKs?.();
        };

        effect(() => {
            const status = this.sessionStatus();
            untracked(() => this.stalledTracker.track(status));
        });

        this.destroyRef.onDestroy(() => {
            this.unsubscribeSessionUpdate?.();
            this.stalledTracker.cancel();
            if (this.boundsAnimationFrame !== null) {
                cancelAnimationFrame(this.boundsAnimationFrame);
                this.boundsAnimationFrame = null;
            }
        });
    }

    setBackend(backend: EmbeddedMpvBackend): void {
        if (this.backendConfigured && this.configuredBackend === backend) {
            return;
        }

        this.configuredBackend = backend;
        this.backendConfigured = true;
        this.activeBackend.set(backend);
        this.support.set(null);
        this.supportedControls.set(null);
        this.requestSupport(backend);
    }

    setBoundsProvider(provider: EmbeddedMpvBoundsProvider): void {
        this.boundsProvider = provider;
    }

    triggerBoundsSync(): void {
        this.activeBoundsSync?.();
    }

    retry(): void {
        this.stalledTracker.reset();
        this.sessionActive.set(false);
        this.session.set(null);
        this.sessionId.set(null);
        this.activeBackend.set(this.configuredBackend);
        this.support.set(null);
        this.supportedControls.set(null);
        this.requestSupport(this.configuredBackend);
        this.retryToken.update((value) => value + 1);
    }

    /** Start one explicitly selected backend. */
    startSession(
        host: HTMLElement,
        playback: ResolvedPortalPlayback,
        initialVolume: number,
        requestedBackend: EmbeddedMpvBackend = this.configuredBackend
    ): () => void {
        this.setBackend(requestedBackend);

        let disposed = false;
        let activeSessionId: string | null = null;
        let activeSessionBackend: EmbeddedMpvBackend = requestedBackend;
        const previousOperation = this.pendingOperation;
        const previousCleanup = this.pendingCleanup;
        this.sessionActive.set(true);
        this.activeBackend.set(requestedBackend);

        let ksCleanupPromise: Promise<void> | null = null;
        const cleanupKsSession = (
            electron: ElectronBridge,
            id: string | null
        ): Promise<void> => {
            if (!ksCleanupPromise) {
                ksCleanupPromise = this.disposeKsSession(electron, id);
            }
            return ksCleanupPromise;
        };

        const syncBounds = () => {
            if (!activeSessionId) {
                return;
            }
            const electron = this.getElectronBridge();
            const id = activeSessionId;
            const bounds = this.boundsProvider(host);
            if (activeSessionBackend === 'ksplayer-metal') {
                if (typeof electron?.setKsPlayerMetalBounds === 'function') {
                    void electron
                        .setKsPlayerMetalBounds(id, bounds)
                        .catch(() => undefined);
                }
            } else if (typeof electron?.setEmbeddedMpvBounds === 'function') {
                void electron
                    .setEmbeddedMpvBounds(id, bounds)
                    .catch(() => undefined);
            }
        };

        const scheduleBoundsSync = () => {
            if (this.boundsAnimationFrame !== null) {
                cancelAnimationFrame(this.boundsAnimationFrame);
            }
            this.boundsAnimationFrame = requestAnimationFrame(() => {
                this.boundsAnimationFrame = null;
                syncBounds();
            });
        };

        this.activeBoundsSync = scheduleBoundsSync;

        const resizeObserver = new ResizeObserver(() => scheduleBoundsSync());
        resizeObserver.observe(host);
        window.addEventListener('resize', scheduleBoundsSync);
        window.addEventListener('scroll', scheduleBoundsSync, true);

        let detachDprWatch: (() => void) | null = null;
        const watchDevicePixelRatio = () => {
            detachDprWatch?.();
            detachDprWatch = null;
            const query = window.matchMedia?.(
                `(resolution: ${window.devicePixelRatio}dppx)`
            );
            if (!query) {
                return;
            }
            const onChange = () => {
                watchDevicePixelRatio();
                scheduleBoundsSync();
            };
            query.addEventListener('change', onChange);
            detachDprWatch = () =>
                query.removeEventListener('change', onChange);
        };
        watchDevicePixelRatio();

        const create = async () => {
            await previousOperation?.catch(() => undefined);
            await previousCleanup?.catch(() => undefined);
            if (disposed) {
                return;
            }
            this.session.set(
                this.decorateSession(
                    createLoadingSession(playback, initialVolume),
                    requestedBackend
                )
            );
            await waitForStartupPaint();
            if (disposed) {
                return;
            }

            const electron = this.getElectronBridge();
            if (!electron) {
                throw new Error(
                    'Embedded native playback requires the Electron desktop build.'
                );
            }

            const attempt = async (backend: EmbeddedMpvBackend) => {
                if (disposed) {
                    return;
                }
                activeSessionBackend = backend;
                this.activeBackend.set(backend);

                if (backend === 'ksplayer-metal') {
                    const prepared = await this.prepareKsPlayerMetal(electron);
                    this.setSupportFromKs(prepared);
                    if (!prepared.supported) {
                        throw new Error(
                            prepared.reason ??
                                'KS Player is not available in this environment.'
                        );
                    }
                    await this.loadKsControls(electron, this.supportRequestId);
                    const created = await electron.createKsPlayerMetalSession(
                        measureBounds(host),
                        playback.title,
                        initialVolume
                    );
                    if (disposed) {
                        await cleanupKsSession(electron, created.id);
                        return;
                    }
                    activeSessionId = created.id;
                    this.sessionId.set(created.id);
                    this.session.set(this.decorateSession(created, backend));
                    await electron.loadKsPlayerMetalPlayback(
                        created.id,
                        playback
                    );
                } else {
                    const prepared = await electron.prepareEmbeddedMpv?.();
                    if (prepared) {
                        this.setSupport({
                            ...prepared,
                            backend: 'embedded-mpv',
                        });
                    }
                    if (prepared && !prepared.supported) {
                        throw new Error(
                            prepared.reason ??
                                'Embedded MPV is not available in this environment.'
                        );
                    }
                    const created = await electron.createEmbeddedMpvSession(
                        measureBounds(host),
                        playback.title,
                        initialVolume
                    );
                    if (disposed) {
                        await electron.disposeEmbeddedMpvSession(created.id);
                        return;
                    }
                    activeSessionId = created.id;
                    this.sessionId.set(created.id);
                    this.session.set(this.decorateSession(created, backend));
                    await electron.loadEmbeddedMpvPlayback(
                        created.id,
                        playback
                    );
                }

                if (disposed) {
                    return;
                }
                scheduleBoundsSync();
            };

            try {
                if (requestedBackend === 'ksplayer-metal') {
                    await this.pendingSupportRequest?.catch(() => undefined);
                    if (disposed) {
                        return;
                    }
                    const support = this.support();
                    if (
                        support?.backend === 'ksplayer-metal' &&
                        !support.supported
                    ) {
                        throw new Error(
                            support.reason ??
                                'KS Player is not available in this environment.'
                        );
                    }
                }
                await attempt(requestedBackend);
            } catch (error) {
                if (requestedBackend !== 'ksplayer-metal') {
                    throw error;
                }
                await cleanupKsSession(electron, activeSessionId);
                activeSessionId = null;
                activeSessionBackend = requestedBackend;
                this.sessionId.set(null);
                this.session.set(null);
                this.activeBackend.set(requestedBackend);
                this.reconcileKsFailure(error);
                throw error;
            }
        };

        const operation = create();
        const trackedOperation = operation.finally(() => {
            if (this.pendingOperation === trackedOperation) {
                this.pendingOperation = null;
            }
        });
        this.pendingOperation = trackedOperation;
        void trackedOperation.catch((error) => {
            if (disposed) {
                return;
            }
            this.sessionId.set(null);
            this.session.set(
                this.decorateSession(
                    createErrorSession(playback, initialVolume, error),
                    requestedBackend
                )
            );
        });

        return () => {
            disposed = true;
            this.sessionActive.set(false);
            resizeObserver.disconnect();
            window.removeEventListener('resize', scheduleBoundsSync);
            window.removeEventListener('scroll', scheduleBoundsSync, true);
            detachDprWatch?.();
            detachDprWatch = null;

            if (this.activeBoundsSync === scheduleBoundsSync) {
                this.activeBoundsSync = null;
            }
            if (this.boundsAnimationFrame !== null) {
                cancelAnimationFrame(this.boundsAnimationFrame);
                this.boundsAnimationFrame = null;
            }

            const id = activeSessionId;
            const backend = activeSessionBackend;
            activeSessionId = null;
            this.sessionId.set(null);
            this.session.set(null);

            if (id) {
                const electron = this.getElectronBridge();
                const cleanup =
                    backend === 'ksplayer-metal'
                        ? electron
                            ? cleanupKsSession(electron, id)
                            : undefined
                        : electron?.disposeEmbeddedMpvSession(id);
                const trackedCleanup = Promise.resolve(cleanup)
                    .then(() => undefined)
                    .catch(() => undefined)
                    .finally(() => {
                        if (this.pendingCleanup === trackedCleanup) {
                            this.pendingCleanup = null;
                        }
                    });
                this.pendingCleanup = trackedCleanup;
            }
        };
    }

    readonly togglePaused = (): Promise<void> => this.commands.togglePaused();
    readonly seekBy = (deltaSeconds: number): Promise<boolean> =>
        this.commands.seekBy(deltaSeconds);
    readonly seekTo = (seconds: number): Promise<void> =>
        this.commands.seekTo(seconds);
    readonly applyVolume = (value: number): Promise<void> =>
        this.commands.applyVolume(value);
    readonly setAudioTrack = (trackId: number): Promise<void> =>
        this.commands.setAudioTrack(trackId);
    readonly setSubtitleTrack = (trackId: number): Promise<void> =>
        this.commands.setSubtitleTrack(trackId);
    readonly setSubtitleFile = (filePath: string): Promise<void> =>
        this.commands.setSubtitleFile(filePath);
    readonly setSubtitleSettings = (
        settings: PlayerSubtitleSettings
    ): Promise<void> => this.commands.setSubtitleSettings(settings);
    readonly setSpeed = (speed: number): Promise<void> =>
        this.commands.setSpeed(speed);
    readonly setAspect = (aspect: string): Promise<void> =>
        this.commands.setAspect(aspect);
    readonly setPicture = (picture: PlayerPictureSettings): Promise<void> =>
        this.commands.setPicture(picture);

    isControlSupported(control: KsPlayerMetalControl): boolean {
        if (this.activeBackend() === 'embedded-mpv') {
            return true;
        }
        return this.supportedControls()?.[control] === true;
    }

    private handleSessionUpdate(session: EmbeddedMpvSession): void {
        const sessionBackend = session.backend ?? 'embedded-mpv';
        if (
            sessionBackend !== this.activeBackend() ||
            session.id !== this.sessionId()
        ) {
            return;
        }
        this.session.set(this.decorateSession(session, sessionBackend));
    }

    private decorateSession(
        session: EmbeddedMpvSession,
        backend: EmbeddedMpvBackend
    ): EmbeddedMpvSession {
        return {
            ...session,
            backend,
        };
    }

    private setSupport(support: EmbeddedMpvSupport): void {
        this.support.set(support);
    }

    private setSupportFromKs(
        support: KsPlayerMetalSupport,
        controls?: KsPlayerMetalControls
    ): void {
        this.support.set({
            supported: support.supported,
            platform: 'darwin',
            ...(support.reason ? { reason: support.reason } : {}),
            ...(support.architecture
                ? { architecture: support.architecture }
                : {}),
            ...(support.runtimePath
                ? { runtimePath: support.runtimePath }
                : {}),
            backend: 'ksplayer-metal',
            capabilities: { ...EMPTY_KS_CAPABILITIES },
            ...(controls ? { controls } : {}),
        });
    }

    private async loadKsControls(
        electron: ElectronBridge,
        requestId = this.supportRequestId
    ): Promise<void> {
        try {
            const controls = await electron.getKsPlayerMetalSupportedControls();
            if (
                requestId !== this.supportRequestId ||
                this.activeBackend() !== 'ksplayer-metal'
            ) {
                return;
            }
            this.supportedControls.set({
                pause: controls.pause === true,
                seek: controls.seek === true,
                volume: controls.volume === true,
                audioTracks: controls.audioTracks === true,
                playbackSpeed: controls.playbackSpeed === true,
            });
            const support = this.support();
            if (support?.backend === 'ksplayer-metal') {
                this.setSupportFromKs(
                    {
                        supported: support.supported,
                        reason: support.reason,
                        architecture: support.architecture,
                        runtimePath: support.runtimePath,
                    },
                    this.supportedControls() ?? undefined
                );
            }
        } catch {
            if (
                requestId !== this.supportRequestId ||
                this.activeBackend() !== 'ksplayer-metal'
            ) {
                return;
            }
            this.supportedControls.set({ ...EMPTY_KS_CONTROLS });
        }
    }

    private async prepareKsPlayerMetal(
        electron: ElectronBridge
    ): Promise<KsPlayerMetalSupport> {
        if (typeof electron.prepareKsPlayerMetal !== 'function') {
            return {
                supported: false,
                reason: 'KS Player IPC is unavailable in this build.',
            };
        }
        return electron.prepareKsPlayerMetal();
    }

    private async disposeKsSession(
        electron: ElectronBridge,
        sessionId: string | null
    ): Promise<void> {
        if (
            sessionId &&
            typeof electron.disposeKsPlayerMetalSession === 'function'
        ) {
            try {
                await electron.disposeKsPlayerMetalSession(sessionId);
            } catch {
                // Continue to the dispose-all guard below.
            }
        }
        if (typeof electron.disposeAllKsPlayerMetal === 'function') {
            try {
                await electron.disposeAllKsPlayerMetal();
            } catch {
                // Native cleanup is best effort; the caller still publishes a
                // terminal state for the requested backend.
            }
        }
    }

    private requestSupport(backend: EmbeddedMpvBackend): void {
        const requestId = ++this.supportRequestId;
        const request = this.loadSupport(backend, requestId);
        const trackedRequest = request.finally(() => {
            if (this.pendingSupportRequest === trackedRequest) {
                this.pendingSupportRequest = null;
            }
        });
        this.pendingSupportRequest = trackedRequest;
    }

    private async loadSupport(
        backend: EmbeddedMpvBackend,
        requestId: number
    ): Promise<void> {
        const electron = this.getElectronBridge();
        if (!electron) {
            if (requestId === this.supportRequestId) {
                this.support.set({
                    supported: false,
                    platform: 'web',
                    backend,
                    reason: 'Embedded native playback requires the Electron desktop build.',
                });
            }
            return;
        }

        try {
            if (backend === 'ksplayer-metal') {
                if (typeof electron.getKsPlayerMetalSupport !== 'function') {
                    throw new Error(
                        'KS Player IPC is unavailable in this build.'
                    );
                }
                const support = await electron.getKsPlayerMetalSupport();
                if (requestId !== this.supportRequestId) {
                    return;
                }
                this.setSupportFromKs(support);
                if (support.supported) {
                    await this.loadKsControls(electron, requestId);
                }
            } else {
                if (typeof electron.getEmbeddedMpvSupport !== 'function') {
                    throw new Error(
                        'Embedded MPV requires the Electron desktop build.'
                    );
                }
                const support = await electron.getEmbeddedMpvSupport();
                if (requestId !== this.supportRequestId) {
                    return;
                }
                this.setSupport({ ...support, backend: 'embedded-mpv' });
            }
        } catch (error) {
            if (requestId !== this.supportRequestId) {
                return;
            }
            this.support.set({
                supported: false,
                platform: electron.platform ?? 'unknown',
                backend,
                reason: this.errorMessage(error),
            });
        }
    }

    private errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private reconcileKsFailure(error: unknown): void {
        this.supportRequestId++;
        const currentSupport = this.support();
        this.supportedControls.set(null);
        this.setSupportFromKs({
            supported: false,
            reason: this.errorMessage(error),
            ...(currentSupport?.backend === 'ksplayer-metal' &&
            currentSupport.architecture
                ? { architecture: currentSupport.architecture }
                : {}),
            ...(currentSupport?.backend === 'ksplayer-metal' &&
            currentSupport.runtimePath
                ? { runtimePath: currentSupport.runtimePath }
                : {}),
        });
    }

    private getElectronBridge(): ElectronBridge | undefined {
        return window.electron;
    }
}

const EMPTY_KS_CAPABILITIES = {
    subtitles: false,
    playbackSpeed: false,
    aspectOverride: false,
    pictureAdjustments: false,
};
