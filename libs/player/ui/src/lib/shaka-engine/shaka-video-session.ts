/* eslint-disable max-lines -- keeps the Shaka session lifecycle and DRM wiring together. */
import type {
    AutoPlaybackPreparation,
    ChannelDrm,
    PlaybackRequestPolicy,
    PlaybackResourceKind,
} from '@arm-nator/shared/interfaces';
import type {
    InlinePlaybackPlayer,
    PlaybackDiagnostic,
    PlaybackSourceMetadata,
} from '../playback-diagnostics/playback-diagnostics.model';
import { PlaybackDiagnosticCode as DiagnosticCode } from '../playback-diagnostics/playback-diagnostics.model';
import { PlaybackDiagnosticSource as DiagnosticSource } from '../playback-diagnostics/playback-diagnostics.model';
import {
    createPlaybackDiagnostic,
    createPlaybackSourceMetadata,
} from '../playback-diagnostics/playback-diagnostics.util';
import {
    asShakaError,
    classifyShakaPlaybackIssue,
    createUnsupportedDrmDiagnostic,
    toErrorMessage,
} from './shaka-error-classifier';
import { ShakaTextTrackSuppression } from './shaka-text-track-suppression';
import {
    loadShakaModule,
    type ShakaNetworkingEngineLike,
    type ShakaErrorLike,
    type ShakaModuleLike,
    type ShakaModuleLoader,
    type ShakaPlayerLike,
    type ShakaRequestLike,
    type ShakaResponseLike,
} from './shaka-module.types';

export interface ShakaVideoSessionConfig {
    player: InlinePlaybackPlayer;
    emitPlaybackIssue: (issue: PlaybackDiagnostic) => void;
    showCaptions?: () => boolean;
    loadShaka?: ShakaModuleLoader;
}

const DASH_MIME_TYPE = 'application/dash+xml';
/** `shaka.util.Error.Severity.RECOVERABLE` — Shaka retries these itself. */
const SHAKA_SEVERITY_RECOVERABLE = 1;
/** `shaka.util.Error.Code.LOAD_INTERRUPTED` — expected when a newer
 * `load()`/`destroy()` supersedes an in-flight one. */
const SHAKA_LOAD_INTERRUPTED = 7000;
const SHAKA_LICENSE_REQUEST_TYPE = 2;
const SHAKA_MANIFEST_REQUEST_TYPE = 0;
const SHAKA_SEGMENT_REQUEST_TYPE = 1;
const SHAKA_TIMING_REQUEST_TYPE = 4;
const SHAKA_KEY_REQUEST_TYPE = 6;
const SHAKA_PLAYLIST_REQUEST_TYPE = 11;
const UPSTREAM_URI_HEADER = 'x-arm-nator-upstream-uri';

export interface ShakaPlaybackOptions {
    headers?: Record<string, string>;
    requestPolicy?: PlaybackRequestPolicy;
    preparedProxy?: AutoPlaybackPreparation;
    direct?: boolean;
    /** Retain the current buffer while the host resolves a rejected source. */
    providerRecovery?: boolean;
}

type ShakaPlaybackBridge = Pick<
    NonNullable<Window['electron']>,
    | 'createDashProxySession'
    | 'registerDashProxyResource'
    | 'registerDashProxyLicense'
    | 'releaseDashProxySession'
>;

function getShakaPlaybackBridge(): ShakaPlaybackBridge | undefined {
    return typeof window === 'undefined' ? undefined : window.electron;
}

function isHttpTarget(value: string): boolean {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') &&
            !url.username &&
            !url.password;
    } catch {
        return false;
    }
}

function isDashProxyUrl(value: string, sessionId: string): boolean {
    try {
        const url = new URL(value);
        return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
            url.pathname.startsWith(`/dash/${sessionId}/`);
    } catch {
        return false;
    }
}

function resourceKindForRequest(type: number): PlaybackResourceKind {
    switch (type) {
        case SHAKA_MANIFEST_REQUEST_TYPE: return 'manifest';
        case SHAKA_SEGMENT_REQUEST_TYPE: return 'segment';
        case SHAKA_KEY_REQUEST_TYPE: return 'encryption-key';
        case SHAKA_PLAYLIST_REQUEST_TYPE: return 'playlist';
        case SHAKA_TIMING_REQUEST_TYPE: return 'unknown';
        default: return 'unknown';
    }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
    return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function restoreDashResponseUri(response: ShakaResponseLike): void {
    const upstreamUri = headerValue(response.headers, UPSTREAM_URI_HEADER);
    if (upstreamUri && isHttpTarget(upstreamUri)) {
        response.uri = upstreamUri;
    }
}

const PLAYER_REFRESH_EVENTS = [
    'loaded',
    'trackschanged',
    'adaptation',
    'variantchanged',
    'textchanged',
    'texttrackvisibility',
] as const;

/**
 * Owns one Shaka Player engine for DASH (`.mpd`) playback, mirroring how
 * hls.js/mpegts.js engines are owned by their player components.
 *
 * - `shaka-player` is loaded lazily on the first start; the module is cached.
 * - `start()`/`stop()` are synchronous entry points; the async work is
 *   serialized on an internal chain and guarded by a generation counter, so a
 *   channel switch during an in-flight load can never resurrect a stale
 *   engine.
 * - ClearKey, Widevine, and PlayReady DRM come from the channel's
 *   {@link ChannelDrm}; unsupported license types emit a DRM diagnostic
 *   instead of starting an engine.
 */
export class ShakaVideoSession {
    private module: ShakaModuleLike | null = null;
    private player: ShakaPlayerLike | null = null;
    private playerErrorListener: ((event: Event) => void) | null = null;
    private playerRefreshListener: (() => void) | null = null;
    private readonly refreshListeners = new Set<() => void>();
    private operationChain: Promise<void> = Promise.resolve();
    private pendingTeardown: Promise<void> = Promise.resolve();
    private pendingPlayer: ShakaPlayerLike | null = null;
    private teardownInFlight: Promise<void> | null = null;
    private readonly textSuppression = new ShakaTextTrackSuppression();
    private ownedDashSession: {
        id: string;
        bridge: ShakaPlaybackBridge;
    } | null = null;
    private dashSessionReleaseInFlight: Promise<void> | null = null;
    private pendingSessionRelease: Promise<void> = Promise.resolve();
    private generation = 0;
    private destroyed = false;

    constructor(private readonly config: ShakaVideoSessionConfig) {}

    /** Starts DASH playback of `url` on `video`. Synchronous entry point. */
    start(
        video: HTMLVideoElement,
        url: string,
        drm?: ChannelDrm,
        options: ShakaPlaybackOptions = {}
    ): void {
        if (this.destroyed) {
            return;
        }

        if (drm && !drm.supported) {
            this.stop();
            this.config.emitPlaybackIssue(
                createUnsupportedDrmDiagnostic(
                    drm.licenseType,
                    this.createMetadata(url)
                )
            );
            return;
        }

        const generation = ++this.generation;
        this.beginPlayerTeardown();
        this.enqueue(async () => {
            await this.pendingTeardown;
            if (this.isStale(generation)) {
                return;
            }
            await this.startPlayback(generation, video, url, drm, options);
        });
    }

    /** Tears down the current engine (if any) without ending the session. */
    stop(): void {
        this.generation += 1;
        this.beginPlayerTeardown();
    }

    async stopAndWait(): Promise<void> {
        this.stop();
        await this.requestPlayerTeardown();
        await this.operationChain.catch(() => undefined);
    }

    destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.generation += 1;
        this.refreshListeners.clear();
        this.beginPlayerTeardown();
    }

    async destroyAndWait(): Promise<void> {
        this.destroy();
        await this.releaseOwnedDashSession();
        await this.requestPlayerTeardown();
        await this.operationChain.catch(() => undefined);
    }

    /** Current engine, for the shared-controls track bridge. */
    getPlayer(): ShakaPlayerLike | null {
        return this.player;
    }

    /** Registers a callback fired whenever tracks/text state may have changed. */
    subscribe(listener: () => void): () => void {
        this.refreshListeners.add(listener);
        return () => this.refreshListeners.delete(listener);
    }

    private async startPlayback(
        generation: number,
        video: HTMLVideoElement,
        url: string,
        drm: ChannelDrm | undefined,
        options: ShakaPlaybackOptions
    ): Promise<void> {
        let module: ShakaModuleLike;
        try {
            module = await this.loadModule();
        } catch (error: unknown) {
            this.emitIfCurrent(
                generation,
                classifyShakaPlaybackIssue(
                    { message: toErrorMessage(error) },
                    this.createMetadata(url)
                )
            );
            return;
        }

        if (this.isStale(generation)) {
            return;
        }

        if (!module.Player.isBrowserSupported()) {
            this.emitIfCurrent(
                generation,
                createPlaybackDiagnostic({
                    code: DiagnosticCode.UnsupportedContainer,
                    source: DiagnosticSource.Shaka,
                    metadata: this.createMetadata(url),
                    details: 'Shaka Player is not supported in this browser',
                })
            );
            return;
        }

        const bridge = getShakaPlaybackBridge();
        let playbackUrl = url;
        let dashSessionId: string | undefined;
        let licenseServerUrl = drm?.licenseServerUrl;
        const needsLicenseProxy =
            options.requestPolicy?.licenseProxy === true &&
            Boolean(drm?.licenseServerUrl);
        try {
            if (
                options.direct !== true &&
                options.preparedProxy?.format === 'dash'
            ) {
                dashSessionId = options.preparedProxy.id;
                playbackUrl = options.preparedProxy.url;
            } else if (
                options.direct !== true || needsLicenseProxy
            ) {
                if (bridge?.createDashProxySession) {
                    const session = await bridge.createDashProxySession(
                        url,
                        options.headers,
                        options.requestPolicy
                    );
                    dashSessionId = session.id;
                    if (options.direct !== true) {
                        playbackUrl = session.url;
                    }
                    this.ownedDashSession = { id: session.id, bridge };
                } else if (needsLicenseProxy) {
                    throw new Error('The DASH license relay is unavailable.');
                }
            }

            if (this.isStale(generation)) {
                await this.releaseOwnedDashSession(dashSessionId);
                return;
            }

            if (needsLicenseProxy && drm?.licenseServerUrl) {
                if (!bridge?.registerDashProxyLicense) {
                    throw new Error('The DASH license relay is unavailable.');
                }
                if (!dashSessionId) {
                    throw new Error('The DASH license relay session is unavailable.');
                }
                licenseServerUrl = await bridge.registerDashProxyLicense(
                    dashSessionId,
                    drm.licenseServerUrl,
                    drm.licenseRequestHeaders
                );
            }
        } catch (error: unknown) {
            await this.releaseOwnedDashSession(dashSessionId);
            this.emitIfCurrent(
                generation,
                classifyShakaPlaybackIssue(
                    { message: toErrorMessage(error) },
                    this.createMetadata(url)
                )
            );
            return;
        }

        if (this.isStale(generation)) {
            await this.releaseOwnedDashSession(dashSessionId);
            return;
        }

        const player = new module.Player();
        this.player = player;
        this.bindPlayerListeners(
            player,
            generation,
            url,
            drm !== undefined,
            options
        );
        if (dashSessionId && options.direct !== true) {
            try {
                this.configureDashNetworking(player, dashSessionId, bridge);
            } catch (error: unknown) {
                this.config.emitPlaybackIssue(
                    classifyShakaPlaybackIssue(
                        { message: toErrorMessage(error) },
                        this.createMetadata(url)
                    )
                );
                this.beginPlayerTeardown();
                return;
            }
        }

        if (drm) {
            const drmConfig: Record<string, unknown> = {};
            if (drm.clearKeys) {
                drmConfig['clearKeys'] = drm.clearKeys;
            }
            if (licenseServerUrl) {
                drmConfig['servers'] = {
                    [drm.licenseType]: licenseServerUrl,
                };
            }
            player.configure({ drm: drmConfig });
            if (licenseServerUrl === drm.licenseServerUrl) {
                this.configureLicenseHeaders(player, drm.licenseRequestHeaders);
            }
        }

        try {
            await player.attach(video);
            await player.load(playbackUrl);
        } catch (error: unknown) {
            this.handleLoadFailure(
                generation,
                player,
                url,
                error,
                drm !== undefined,
                options
            );
            return;
        }

        if (this.isStale(generation)) {
            return;
        }

        // Shaka 5 shows a text track by selecting it; keep captions off when
        // the preference is disabled in case the manifest auto-selected one.
        if (!(this.config.showCaptions?.() ?? false)) {
            this.textSuppression.suppress(player);
        }
        this.notifyRefresh();
    }

    /** Hides the active text track, remembering it for a later restore. */
    suppressTextTracks(): void {
        const player = this.player;
        if (player) {
            this.textSuppression.suppress(player);
        }
    }

    /** Reselects the text track hidden by {@link suppressTextTracks}. */
    restoreSuppressedTextTrack(): void {
        const player = this.player;
        if (player) {
            this.textSuppression.restore(player);
        }
    }

    private handleLoadFailure(
        generation: number,
        player: ShakaPlayerLike,
        url: string,
        error: unknown,
        drmProvided: boolean,
        options: ShakaPlaybackOptions
    ): void {
        const shakaError = asShakaError(error);
        if (
            this.isStale(generation) ||
            this.player !== player ||
            shakaError?.code === SHAKA_LOAD_INTERRUPTED
        ) {
            return;
        }

        const issue = this.withoutUnusableDrmFallback(
            classifyShakaPlaybackIssue(
                shakaError ?? { message: toErrorMessage(error) },
                this.createMetadata(url)
            ),
            drmProvided
        );
        this.config.emitPlaybackIssue(issue);
        if (this.shouldRetainForProviderRecovery(issue, options)) return;
        // Never leave a non-functional engine attached to the media element
        // or exposed to the shared-controls bridge.
        this.beginPlayerTeardown();
    }

    private configureLicenseHeaders(
        player: ShakaPlayerLike,
        headers: Record<string, string> | undefined
    ): void {
        if (!headers || Object.keys(headers).length === 0) {
            return;
        }

        const networkingEngine: ShakaNetworkingEngineLike | null =
            player.getNetworkingEngine();
        networkingEngine?.registerRequestFilter((type, request) => {
            if (type !== SHAKA_LICENSE_REQUEST_TYPE) {
                return;
            }
            Object.assign(request.headers, headers);
        });
    }

    private configureDashNetworking(
        player: ShakaPlayerLike,
        sessionId: string,
        bridge: ShakaPlaybackBridge | undefined
    ): void {
        const networkingEngine = player.getNetworkingEngine();
        if (!networkingEngine) {
            throw new Error('Shaka networking is unavailable for DASH proxy transport.');
        }

        networkingEngine.registerRequestFilter(async (type, request) => {
            if (type === SHAKA_LICENSE_REQUEST_TYPE) {
                return;
            }
            if (!bridge?.registerDashProxyResource) {
                throw new Error('The DASH resource registry is unavailable.');
            }
            request.uris = await Promise.all(
                request.uris.map(async (uri) => {
                    if (!isHttpTarget(uri) || isDashProxyUrl(uri, sessionId)) {
                        return uri;
                    }
                    return bridge.registerDashProxyResource(
                        sessionId,
                        uri,
                        resourceKindForRequest(type)
                    );
                })
            );
        });

        networkingEngine.registerResponseFilter(
            (_type, response, _request) => restoreDashResponseUri(response)
        );
    }

    private async releaseOwnedDashSession(sessionId?: string): Promise<void> {
        const ownedSession = this.ownedDashSession;
        if (!ownedSession || (sessionId && sessionId !== ownedSession.id)) {
            return;
        }
        if (this.dashSessionReleaseInFlight) {
            await this.dashSessionReleaseInFlight;
            return;
        }
        if (!ownedSession.bridge.releaseDashProxySession) {
            throw new Error('The DASH session release API is unavailable.');
        }

        const tracked: Promise<void> = Promise.resolve()
            .then(() => ownedSession.bridge.releaseDashProxySession(ownedSession.id))
            .then(() => {
                if (this.ownedDashSession === ownedSession) {
                    this.ownedDashSession = null;
                }
            })
            .finally(() => {
                if (this.dashSessionReleaseInFlight === tracked) {
                    this.dashSessionReleaseInFlight = null;
                    if (this.pendingSessionRelease === tracked) {
                        this.pendingSessionRelease = Promise.resolve();
                    }
                }
            });
        this.dashSessionReleaseInFlight = tracked;
        this.pendingSessionRelease = tracked;
        await tracked;
    }

    /**
     * Channels carrying KODIPROP DRM config cannot be handed to MPV/VLC at
     * all — external players never receive the license config, so the
     * encrypted stream fails there regardless of what broke inline (DRM,
     * manifest, codec, network, …). Suppress the fallback hint entirely.
     */
    private withoutUnusableDrmFallback(
        issue: PlaybackDiagnostic,
        drmProvided: boolean
    ): PlaybackDiagnostic {
        if (!drmProvided || !issue.externalFallbackRecommended) {
            return issue;
        }
        return { ...issue, externalFallbackRecommended: false };
    }

    private bindPlayerListeners(
        player: ShakaPlayerLike,
        generation: number,
        url: string,
        drmProvided: boolean,
        options: ShakaPlaybackOptions
    ): void {
        const errorListener = (event: Event): void => {
            if (this.isStale(generation) || this.player !== player) {
                return;
            }

            const detail = (event as { detail?: Partial<ShakaErrorLike> })
                .detail;
            if (detail?.severity === SHAKA_SEVERITY_RECOVERABLE) {
                return;
            }

            const issue = this.withoutUnusableDrmFallback(
                classifyShakaPlaybackIssue(
                    detail,
                    this.createMetadata(url)
                ),
                drmProvided
            );
            this.config.emitPlaybackIssue(issue);
            if (this.shouldRetainForProviderRecovery(issue, options)) return;
            // Critical errors end playback; never leave the dead engine
            // attached or exposed to the shared-controls bridge.
            this.beginPlayerTeardown();
        };
        const refreshListener = (): void => {
            if (!this.isStale(generation) && this.player === player) {
                this.notifyRefresh();
            }
        };

        this.playerErrorListener = errorListener;
        this.playerRefreshListener = refreshListener;
        player.addEventListener('error', errorListener);
        for (const event of PLAYER_REFRESH_EVENTS) {
            player.addEventListener(event, refreshListener);
        }
    }

    private shouldRetainForProviderRecovery(
        issue: PlaybackDiagnostic,
        options: ShakaPlaybackOptions
    ): boolean {
        return options.providerRecovery === true &&
            (issue.network?.status === 401 || issue.network?.status === 403) &&
            issue.network.resourceKind !== 'license';
    }

    /**
     * Detaches and destroys the current engine immediately — never queued
     * behind pending operations. `player.destroy()` interrupts an in-flight
     * `load()` (it rejects with `LOAD_INTERRUPTED`), so a stalled manifest
     * fetch cannot wedge the operation chain. New starts await
     * {@link pendingTeardown} before attaching to the media element.
     */
    private beginPlayerTeardown(): void {
        const player = this.player;
        this.player = null;
        void this.releaseOwnedDashSession().catch(() => undefined);
        this.textSuppression.reset();
        if (player) {
            this.pendingPlayer = player;
            if (this.playerErrorListener) {
                player.removeEventListener('error', this.playerErrorListener);
            }
            if (this.playerRefreshListener) {
                for (const event of PLAYER_REFRESH_EVENTS) {
                    player.removeEventListener(event, this.playerRefreshListener);
                }
            }
            this.playerErrorListener = null;
            this.playerRefreshListener = null;
            this.notifyRefresh();
        } else if (!this.pendingPlayer) {
            this.playerErrorListener = null;
            this.playerRefreshListener = null;
            void this.requestPlayerTeardown().catch(() => undefined);
            return;
        }

        void this.requestPlayerTeardown().catch(() => undefined);
    }

    private requestPlayerTeardown(): Promise<void> {
        if (this.teardownInFlight) {
            const combined = Promise.all([
                this.teardownInFlight,
                this.pendingSessionRelease,
            ]).then(() => undefined);
            this.pendingTeardown = combined;
            return combined;
        }
        const player = this.pendingPlayer;
        if (!player) {
            this.pendingTeardown = this.pendingSessionRelease;
            return this.pendingTeardown;
        }

        const playerDestroy = Promise.resolve()
            .then(() => player.destroy())
            .then(() => undefined);
        const tracked: Promise<void> = Promise.allSettled([
            playerDestroy,
            this.pendingSessionRelease,
        ])
            .then((results) => {
                if (this.pendingPlayer === player && results[0]?.status === 'fulfilled') {
                    this.pendingPlayer = null;
                }
                const failure = results.find(
                    (result): result is PromiseRejectedResult =>
                        result.status === 'rejected'
                );
                if (failure) throw failure.reason;
            })
            .finally(() => {
                if (this.teardownInFlight === tracked) {
                    this.teardownInFlight = null;
                }
            });
        this.teardownInFlight = tracked;
        this.pendingTeardown = tracked;
        void tracked.catch(() => undefined);
        return tracked;
    }

    private async loadModule(): Promise<ShakaModuleLike> {
        if (this.module) {
            return this.module;
        }

        const loader = this.config.loadShaka ?? loadShakaModule;
        const module = await loader();
        module.polyfill.installAll();
        this.module = module;
        return module;
    }

    private createMetadata(url: string): PlaybackSourceMetadata {
        return createPlaybackSourceMetadata({
            url,
            mimeType: DASH_MIME_TYPE,
            player: this.config.player,
        });
    }

    private enqueue(operation: () => Promise<void>): void {
        this.operationChain = this.operationChain.then(operation, operation);
    }

    private isStale(generation: number): boolean {
        return this.destroyed || generation !== this.generation;
    }

    private emitIfCurrent(
        generation: number,
        issue: PlaybackDiagnostic
    ): void {
        if (!this.isStale(generation)) {
            this.config.emitPlaybackIssue(issue);
        }
    }

    private notifyRefresh(): void {
        for (const listener of [...this.refreshListeners]) {
            listener();
        }
    }
}
