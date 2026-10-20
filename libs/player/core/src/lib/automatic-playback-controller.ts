import { VideoPlayer, type PlaybackRequestPolicy, type AutoPlaybackPreparationResult, type ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { AutomaticPlaybackSession, type AutomaticPreparationOptions } from './automatic-playback-session';
import { PlaybackAttemptManager, type PlaybackProgressSnapshot, type PlaybackRecoveryDecision } from './playback-attempt-manager';
import type { AutoPlaybackPreparation } from '@arm-nator/shared/interfaces';
import { rankAutomaticPlaybackEngines, type AutomaticNativeSupport } from './automatic-playback-plan';

export interface AutomaticPlaybackError { readonly code: string; readonly status: number | null; readonly message: string; }
export interface AutomaticPlaybackFailure<Context> { readonly playback: ResolvedPortalPlayback; readonly error: AutomaticPlaybackError; readonly token: number | null; readonly context?: Context; }
export interface AutomaticPlaybackDecision { readonly engine: VideoPlayer; readonly reason: string; readonly token: number; }
export interface AutomaticPlaybackActive<Context> {
    readonly token: number; readonly playback: ResolvedPortalPlayback; readonly originalUrl: string;
    readonly preparedPlayback: ResolvedPortalPlayback; readonly selectedEngine: VideoPlayer | null;
    readonly nativeAttempted: boolean; readonly context?: Context;
}
export interface AutomaticPlaybackDiagnostic { readonly attemptToken?: number; readonly code: string; readonly sourceUrl?: string; readonly details?: Readonly<Record<string, unknown>>; readonly positionSeconds?: number; readonly status?: number | null; readonly retryAfterMs?: number; readonly message?: string; }

export interface AutomaticPlaybackControllerDependencies<Context> {
    prepareForPlayback(): Promise<number | null>;
    isPlaybackTransitionCurrent(token: number): boolean;
    registerTeardown(dispose: () => Promise<void>): () => void;
    prepare(url: string, headers: Record<string, string>, isLive: boolean, attemptId: string, policy?: PlaybackRequestPolicy, options?: AutomaticPreparationOptions): Promise<AutoPlaybackPreparationResult>;
    cancel(attemptId: string): Promise<void>;
    release(sessionId: string): Promise<void>;
    getNativeSupport(): Promise<AutomaticNativeSupport>;
    startPlayback(playback: ResolvedPortalPlayback, engine: VideoPlayer, context: Context | undefined, token: number): Promise<void>;
    showFailure(failure: AutomaticPlaybackFailure<Context>): void;
    onPreparing?(playback: ResolvedPortalPlayback, token: number, context?: Context): void;
    onDecision?(decision: AutomaticPlaybackDecision): void;
    onCleanupFailure?(error: unknown, token: number): void;
    getBrowserCodecs?(media: AutoPlaybackPreparation): Readonly<Record<string, boolean>>;
    companionAvailable?(): boolean;
    conversionAllowed?(): boolean;
    now?(): number;
    random?(): number;
    getRememberedEngine?(playback: ResolvedPortalPlayback, media: AutoPlaybackPreparation): VideoPlayer | undefined;
    rememberEngine?(playback: ResolvedPortalPlayback, media: AutoPlaybackPreparation, engine: VideoPlayer): void;
    invalidateEngine?(playback: ResolvedPortalPlayback, media: AutoPlaybackPreparation, engine: VideoPlayer): void;
    renewPlayback?(playback: ResolvedPortalPlayback, context: Context | undefined, signal: AbortSignal): Promise<ResolvedPortalPlayback>;
    canRenew?(playback: ResolvedPortalPlayback, context: Context | undefined): boolean;
    snapshotPlayback?(playback: ResolvedPortalPlayback): ResolvedPortalPlayback;
    onRecovery?(reason: string): void;
}

type ActiveState<Context> = Omit<AutomaticPlaybackActive<Context>, 'preparedPlayback' | 'selectedEngine' | 'nativeAttempted'> & {
    preparedPlayback: ResolvedPortalPlayback; selectedEngine: VideoPlayer | null; nativeAttempted: boolean;
    support: AutomaticNativeSupport; readonly session: AutomaticPlaybackSession | null;
};
const BROWSER_ENGINES = new Set<VideoPlayer>([VideoPlayer.ArtPlayer, VideoPlayer.ArtPlayer2, VideoPlayer.Html5Player]);

function setHeader(headers: Record<string, string>, name: string, value: string): void {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    if (value) headers[name] = value;
}
function playbackHeaders(playback: ResolvedPortalPlayback): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(playback.headers ?? {})) setHeader(headers, name, value);
    if (playback.userAgent) setHeader(headers, 'User-Agent', playback.userAgent);
    if (playback.referer) setHeader(headers, 'Referer', playback.referer);
    if (playback.origin) setHeader(headers, 'Origin', playback.origin);
    return headers;
}
function playbackForEngine(playback: ResolvedPortalPlayback, engine: VideoPlayer): ResolvedPortalPlayback {
    if (BROWSER_ENGINES.has(engine)) return playback;
    // Automatic preparation already moved provider headers into the proxy session.
    // Native engines now request only its loopback URL, so forwarding provider-scoped
    // Origin/Cookie/Authorization headers would make the local proxy reject the request.
    return { ...playback, headers: undefined, userAgent: undefined, referer: undefined, origin: undefined };
}
function errorFromThrown(code: string, error: unknown): AutomaticPlaybackError {
    return { code, status: null, message: error instanceof Error ? error.message : String(error) };
}
function matchesSource(active: ActiveState<unknown>, sourceUrl: string | undefined): boolean {
    if (!sourceUrl) return false;
    const preparedUrl = active.preparedPlayback.preparedProxy?.url;
    return preparedUrl ? sourceUrl === preparedUrl :
        sourceUrl === active.originalUrl || sourceUrl === active.preparedPlayback.streamUrl;
}

/** One selection owns all retries, deadlines, decoder replacements and retained responses. */
export class AutomaticPlaybackController<Context = unknown> {
    private active: ActiveState<Context> | null = null;
    private lastPlayback: ResolvedPortalPlayback | null = null;
    private readonly attempts: PlaybackAttemptManager;
    private selection = 0;
    private abort = new AbortController();
    private recovering: Promise<boolean> | null = null;
    private readonly tried = new Set<VideoPlayer>();
    private readonly failedDecoderFamilies = new Set<string>();
    private manualEngine?: VideoPlayer;
    private terminal = false;
    private remembered = false;
    private processingMode: 'direct' | 'proxy' | 'remux' | 'convert' = 'direct';

    constructor(private readonly dependencies: AutomaticPlaybackControllerDependencies<Context>) {
        this.attempts = new PlaybackAttemptManager({ now: dependencies.now, random: dependencies.random });
    }
    get activePlayback(): Readonly<ActiveState<Context>> | null { return this.active; }
    get originalPlayback(): ResolvedPortalPlayback | null { return this.active?.playback ?? this.lastPlayback; }

    async open(playback: ResolvedPortalPlayback, context?: Context, manualEngine?: VideoPlayer): Promise<number | null> {
        const selection = ++this.selection;
        this.abort.abort(); this.abort = new AbortController();
        this.recovering = null; this.terminal = false; this.remembered = false;
        this.tried.clear(); this.failedDecoderFamilies.clear(); this.manualEngine = manualEngine; this.processingMode = playback.preferredProcessingMode ?? 'direct';
        this.attempts.startSelection({ selectionId: String(selection), kind: playback.isLive ? 'live' : 'vod' });
        this.lastPlayback = playback;
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || !this.current(token)) return token;
        this.active = null;
        this.notifyPreparing(playback, token, context);
        const support = await this.bounded(this.dependencies.getNativeSupport(), 2000, this.abort.signal).catch(() => ({ embeddedMpv: false, ksPlayer: false }));
        if (selection !== this.selection || !this.current(token)) return token;
        await this.startAttempt(playback, context, token, support, manualEngine);
        return token;
    }

    async close(): Promise<number | null> {
        const previous = this.active;
        this.invalidate();
        const token = await this.dependencies.prepareForPlayback();
        if (previous?.session) await previous.session.dispose();
        if (token !== null && this.current(token)) this.active = null;
        return token;
    }
    invalidate(): void {
        this.abort.abort(); this.selection++; this.terminal = true;
        this.active = null; this.recovering = null;
    }

    observeProgress(progress: PlaybackProgressSnapshot, sourceUrl: string): void {
        const active = this.active;
        if (!active || this.terminal || this.recovering || !this.current(active.token) || !matchesSource(active, sourceUrl)) return;
        this.attempts.observeProgress({ ...progress, audioOnly: active.preparedPlayback.preparedProxy?.audioOnly === true || progress.audioOnly });
        if (!this.remembered && this.attempts.isVerified && active.selectedEngine && active.preparedPlayback.preparedProxy) {
            this.remembered = true;
            this.dependencies.rememberEngine?.(active.playback, active.preparedPlayback.preparedProxy, active.selectedEngine);
        }
    }
    async poll(): Promise<void> {
        const active = this.active;
        if (!active || this.terminal || this.recovering || !this.current(active.token)) return;
        const result = this.attempts.poll();
        if (result.type === 'failure') await this.recover(active, { code: 'startup-timeout', sourceUrl: active.preparedPlayback.streamUrl }, result.decision);
    }
    handleDiagnostic(issue: AutomaticPlaybackDiagnostic): Promise<boolean> {
        const previous = this.active;
        if (!previous || this.terminal || (issue.attemptToken !== undefined && issue.attemptToken !== previous.token) || !this.current(previous.token) || !matchesSource(previous, issue.sourceUrl)) return Promise.resolve(false);
        if (this.recovering) return this.recovering;
        return this.recover(previous, issue);
    }
    private recover(previous: ActiveState<Context>, issue: AutomaticPlaybackDiagnostic, decision?: PlaybackRecoveryDecision): Promise<boolean> {
        if (this.recovering) return this.recovering;
        const operation = this.replace(previous, issue, decision);
        this.recovering = operation;
        void operation.finally(() => { if (this.recovering === operation) this.recovering = null; }).catch(() => undefined);
        return operation;
    }
    private async replace(previous: ActiveState<Context>, issue: AutomaticPlaybackDiagnostic, supplied?: PlaybackRecoveryDecision): Promise<boolean> {
        const selection = this.selection, signal = this.abort.signal;
        const decision = supplied ?? this.attempts.recordFailure({
            code: issue.code === 'browser-access-error' && this.dependencies.companionAvailable?.() && this.processingMode === 'direct' ? 'network-error' : issue.code, status: issue.status, retryAfterMs: issue.retryAfterMs,
            renewableLinkSupported: this.dependencies.canRenew?.(previous.playback, previous.context) === true,
        });
        if (decision.category === 'decoder' && previous.selectedEngine) {
            // A different transport can support the same codec in a different container.
            if (issue.code !== 'unsupported-container') this.failedDecoderFamilies.add(this.family(previous.selectedEngine));
            const media = previous.preparedPlayback.preparedProxy;
            if (media) this.dependencies.invalidateEngine?.(previous.playback, media, previous.selectedEngine);
        }
        // Browser autoplay policy needs a user gesture; keep its existing controls mounted.
        if (decision.category === 'autoplay') { this.dependencies.onRecovery?.('Press Play to allow playback.'); return false; }
        if (decision.action === 'stop') return this.finishFailure(previous, issue, decision.reason);
        let playback = this.dependencies.snapshotPlayback?.(previous.playback) ?? previous.playback;
        if (!playback.isLive && Number.isFinite(issue.positionSeconds)) playback = { ...playback, startTime: Math.max(0, issue.positionSeconds!) };
        if (playback.isLive) playback = { ...playback, startTime: undefined };
        let engine = previous.selectedEngine ?? undefined;
        if (issue.code === 'browser-access-error' && this.processingMode === 'direct' && this.dependencies.companionAvailable?.()) this.processingMode = 'proxy';
        if (decision.action === 'switch') {
            const media = previous.preparedPlayback.preparedProxy ?? { id: '', url: playback.streamUrl, format: 'unknown' as const };
            engine = rankAutomaticPlaybackEngines(media, previous.support).find(candidate => !this.tried.has(candidate) && !this.failedDecoderFamilies.has(this.family(candidate)));
            if (!engine && this.dependencies.companionAvailable?.()) {
                if (this.processingMode === 'direct' || this.processingMode === 'proxy') this.processingMode = 'remux';
                else if (this.processingMode === 'remux' && this.dependencies.conversionAllowed?.()) this.processingMode = 'convert';
                else return this.finishFailure(previous, issue, 'No compatible untried in-app player remains.');
                engine = VideoPlayer.ArtPlayer;
            }
            if (!engine) return this.finishFailure(previous, issue, 'No compatible untried in-app player remains.');
        }
        this.dependencies.onRecovery?.(this.processingMode === 'convert' ? 'Converting for compatibility; quality may change.' : this.processingMode === 'remux' ? 'Repackaging the stream for browser compatibility.' : decision.action === 'switch' ? `Recovering playback with ${engine}.` : decision.action === 'renew' ? 'Refreshing the provider stream link.' : 'Reconnecting playback.');
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || signal.aborted || !this.current(token)) return false;
        this.active = null;
        this.notifyPreparing(playback, token, previous.context);
        try {
            if (decision.delayMs) await this.wait(decision.delayMs, signal);
            if (decision.action === 'renew') {
                if (!this.dependencies.renewPlayback) return false;
                const renewed = await this.bounded(this.dependencies.renewPlayback(playback, previous.context, signal), Math.max(1, decision.remainingMs ?? 1), signal);
                playback = { ...playback, ...renewed, startTime: playback.startTime, startPaused: playback.startPaused };
            }
            if (selection !== this.selection || signal.aborted || !this.current(token)) return false;
            await this.startAttempt(playback, previous.context, token, previous.support, engine);
            return !!this.activePlayback?.selectedEngine;
        } catch (error) {
            if (!signal.aborted && selection === this.selection && this.current(token)) {
                this.terminal = true;
                this.failure(playback, previous.context, token, errorFromThrown('recovery-failed', error));
            }
            return false;
        }
    }
    private async startAttempt(playback: ResolvedPortalPlayback, context: Context | undefined, token: number, support: AutomaticNativeSupport, forcedEngine?: VideoPlayer): Promise<void> {
        const window = this.attempts.startAttempt();
        if (!window.started) {
            this.terminal = true;
            this.failure(playback, context, token, { code: 'recovery-exhausted', status: null, message: 'Playback recovery budget exhausted. Retry to start again.' });
            return;
        }
        const originalUrl = playback.originalStreamUrl ?? playback.streamUrl;
        const session = playback.drm ? null : new AutomaticPlaybackSession(this.dependencies);
        const active: ActiveState<Context> = { token, playback, originalUrl, preparedPlayback: playback, selectedEngine: null, nativeAttempted: false, support, session, context };
        this.active = active; this.remembered = false;
        let result: AutoPlaybackPreparationResult;
        try {
            result = session ? await this.bounded(session.prepare(originalUrl, playbackHeaders(playback), Boolean(playback.isLive), playback.requestPolicy, { processingMode: this.processingMode, startTime: playback.startTime, audioOnly: true }), window.remainingAttemptMs, this.abort.signal)
                : { ok: true, session: { id: 'drm-direct', url: originalUrl, format: 'dash', encrypted: true, processingMode: 'direct' } };
        } catch (error) { result = { ok: false, error: errorFromThrown(error instanceof Error && error.name === 'TimeoutError' ? 'startup-timeout' : 'preparation-failed', error) }; }
        if (!this.current(token) || this.active !== active || this.abort.signal.aborted) return;
        if (!result.ok) {
            // Preparation errors use the same bounded policy; schedule after this attempt returns.
            await this.replace(active, { ...result.error, sourceUrl: playback.streamUrl });
            return;
        }
        const remembered = this.dependencies.getRememberedEngine?.(playback, result.session);
        const capabilities = { ...support, browserCodecs: { ...support.browserCodecs, ...this.dependencies.getBrowserCodecs?.(result.session) } };
        active.support = capabilities;
        active.preparedPlayback = { ...playback, streamUrl: result.session.url, originalStreamUrl: originalUrl, preparedProxy: result.session };
        const candidates = rankAutomaticPlaybackEngines(result.session, capabilities, remembered);
        const engine = forcedEngine ?? (playback.drm ? VideoPlayer.Html5Player : candidates.find(candidate => !this.tried.has(candidate)));
        if (!engine) { await this.replace(active, { code: 'unsupported-container', sourceUrl: playback.streamUrl }); return; }
        const preparedPlayback = { ...playback, playbackAttemptToken: token, streamUrl: result.session.url, originalStreamUrl: originalUrl, preparedProxy: result.session };
        const enginePlayback = playback.drm ? playback : result.session.processingMode === 'direct' ? preparedPlayback : playbackForEngine(preparedPlayback, engine);
        active.preparedPlayback = enginePlayback; active.selectedEngine = engine;
        active.nativeAttempted = !BROWSER_ENGINES.has(engine); this.tried.add(engine);
        this.decision(engine, result.session.processingMode === 'convert' ? 'Compatibility conversion is active; video quality may be reduced.' : result.session.processingMode === 'remux' ? 'Stream copy remux is active; original codecs are retained.' : this.tried.size > 1 ? `Recovered with ${engine}.` : this.manualEngine ? `Selected player: ${engine}.` : remembered === engine ? `Previously verified ${engine} selected.` : `Compatibility selection: ${engine}.`, token);
        if (!this.current(token) || this.active !== active) return;
        try { await this.dependencies.startPlayback(enginePlayback, engine, context, token); }
        catch (error) {
            await this.replace(active, { code: 'playback-start-failed', sourceUrl: enginePlayback.streamUrl });
        }
    }
    private family(engine: VideoPlayer): string { return BROWSER_ENGINES.has(engine) ? 'browser-decoder' : engine; }
    private async finishFailure(active: ActiveState<Context>, issue: AutomaticPlaybackDiagnostic, reason: string): Promise<boolean> {
        const selection = this.selection;
        this.terminal = true;
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || !this.current(token) || this.abort.signal.aborted) return false;
        if (active.session) await active.session.dispose();
        this.active = null;
        this.failure(active.playback, active.context, token, { code: issue.code, status: issue.status ?? null, message: issue.message ?? reason });
        return false;
    }
    private wait(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(new Error('Cancelled')); return; }
            const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
            signal.addEventListener('abort', abort, { once: true });
        });
    }
    private bounded<T>(operation: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(new Error('Cancelled')); return; }
            const abort = () => { clearTimeout(timer); reject(new Error('Cancelled')); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('Recovery timed out'), { name: 'TimeoutError' })); }, ms);
            signal.addEventListener('abort', abort, { once: true });
            operation.then(resolve, reject).finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort); }).catch(() => undefined);
        });
    }
    private current(token: number): boolean { return this.dependencies.isPlaybackTransitionCurrent(token); }
    private failure(playback: ResolvedPortalPlayback, context: Context | undefined, token: number | null, error: AutomaticPlaybackError): void { this.dependencies.showFailure({ playback, context, error, token }); }
    private notifyPreparing(playback: ResolvedPortalPlayback, token: number, context?: Context): void {
        try { this.dependencies.onPreparing?.(playback, token, context); } catch { /* Observer only. */ }
    }
    private decision(engine: VideoPlayer, reason: string, token: number): void {
        try { this.dependencies.onDecision?.({ engine, reason, token }); } catch { /* Observer only. */ }
    }
}
