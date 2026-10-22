import { VideoPlayer, type PlaybackRequestPolicy, type AutoPlaybackPreparationResult, type ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { AutomaticPlaybackSession, type AutomaticPreparationOptions } from './automatic-playback-session';
import { PlaybackAttemptManager, type PlaybackProgressSnapshot, type PlaybackRecoveryDecision } from './playback-attempt-manager';
import type { AutoPlaybackPreparation } from '@arm-nator/shared/interfaces';
import { rankAutomaticPlaybackEngines, type AutomaticNativeSupport } from './automatic-playback-plan';
import { inferAutomaticPlaybackFormat, isDnsFailure, isSourceRouteFailure, nextAutomaticSource, sourceKey } from './automatic-playback-sources';

import { AutomaticPlaybackActivityLog, type AutomaticPlaybackActivity } from './automatic-playback-activity';

export interface AutomaticPlaybackError { readonly code: string; readonly status: number | null; readonly message: string; readonly networkCode?: string; readonly retryAfterMs?: number; }
export interface AutomaticPlaybackFailure<Context> { readonly playback: ResolvedPortalPlayback; readonly error: AutomaticPlaybackError; readonly token: number | null; readonly context?: Context; }
export interface AutomaticPlaybackDecision { readonly engine: VideoPlayer; readonly reason: string; readonly token: number; }
export interface AutomaticPlaybackActive<Context> {
    readonly token: number; readonly playback: ResolvedPortalPlayback; readonly originalUrl: string;
    readonly preparedPlayback: ResolvedPortalPlayback; readonly selectedEngine: VideoPlayer | null;
    readonly nativeAttempted: boolean; readonly context?: Context;
}
export interface AutomaticPlaybackDiagnostic { readonly attemptToken?: number; readonly code: string; readonly sourceUrl?: string; readonly details?: Readonly<Record<string, unknown>>; readonly positionSeconds?: number; readonly status?: number | null; readonly retryAfterMs?: number; readonly message?: string; readonly networkCode?: string; }

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
    getRememberedSource?(playback: ResolvedPortalPlayback): string | undefined;
    rememberSource?(playback: ResolvedPortalPlayback, media: AutoPlaybackPreparation): void;
    invalidateSource?(playback: ResolvedPortalPlayback, issue: AutomaticPlaybackDiagnostic): void;
    onActivity?(activity: AutomaticPlaybackActivity): void;
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
    private readonly activity: AutomaticPlaybackActivityLog;
    private selection = 0;
    private abort = new AbortController();
    private recovering: Promise<boolean> | null = null;
    private readonly tried = new Set<VideoPlayer>();
    private readonly attemptedSources = new Set<string>();
    private readonly failedDnsHosts = new Set<string>();
    private readonly failedDecoderFamilies = new Set<string>();
    private manualEngine?: VideoPlayer;
    private terminal = false;
    private remembered = false;
    private sourceVerified = false;
    private rememberedSourceApplied = false;
    private pendingConfiguredPlayback: ResolvedPortalPlayback | null = null;
    private processingMode: 'direct' | 'proxy' | 'remux' | 'convert' = 'direct';

    constructor(private readonly dependencies: AutomaticPlaybackControllerDependencies<Context>) {
        this.activity = new AutomaticPlaybackActivityLog(dependencies.onActivity);
        this.attempts = new PlaybackAttemptManager({ now: dependencies.now, random: dependencies.random });
    }
    get activePlayback(): Readonly<ActiveState<Context>> | null { return this.active; }
    get originalPlayback(): ResolvedPortalPlayback | null { return this.active?.playback ?? this.lastPlayback; }

    async open(playback: ResolvedPortalPlayback, context?: Context, manualEngine?: VideoPlayer): Promise<number | null> {
        const selection = ++this.selection;
        this.abort.abort(); this.abort = new AbortController();
        this.recovering = null; this.terminal = false; this.remembered = false;
        this.tried.clear(); this.failedDecoderFamilies.clear(); this.manualEngine = manualEngine; this.processingMode = playback.preferredProcessingMode ?? 'direct';
        this.attemptedSources.clear(); this.failedDnsHosts.clear();
        this.activity.reset();
        this.pendingConfiguredPlayback = null;
        const rememberedSource = manualEngine === undefined && !playback.drm ? this.dependencies.getRememberedSource?.(playback) : undefined;
        this.rememberedSourceApplied = rememberedSource !== undefined;
        const configuredUrl = playback.originalStreamUrl ?? playback.streamUrl;
        if (rememberedSource && sourceKey(rememberedSource) !== sourceKey(configuredUrl)) {
            this.pendingConfiguredPlayback = playback;
            let differentHost = false;
            try { differentHost = new URL(rememberedSource).origin !== new URL(configuredUrl).origin; } catch { /* The preference store validates URLs. */ }
            playback = { ...playback, streamUrl: rememberedSource, originalStreamUrl: rememberedSource, preparedProxy: undefined,
                recovery: differentHost ? { ...playback.recovery, alternateHostUrl: configuredUrl } : playback.recovery };
        }
        this.attempts.startSelection({ selectionId: String(selection), kind: playback.isLive ? 'live' : 'vod' });
        this.lastPlayback = playback;
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || !this.current(token)) {
            if (token === null && selection === this.selection) this.activity.stop('Playback could not be prepared. Close the previous player and retry.');
            return token;
        }
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
        this.activity.cancel();
        this.abort.abort(); this.selection++; this.terminal = true;
        this.active = null; this.recovering = null;
    }

    observeProgress(progress: PlaybackProgressSnapshot, sourceUrl: string): void {
        const active = this.active;
        if (!active || this.terminal || this.recovering || !this.current(active.token) || !matchesSource(active, sourceUrl)) return;
        this.attempts.observeProgress({ ...progress, audioOnly: active.preparedPlayback.preparedProxy?.audioOnly === true || progress.audioOnly });
        if (this.attempts.isVerified && !this.sourceVerified) this.activity.update({ outcome: 'playing' }, 'playing');
        if (!this.remembered && this.attempts.isVerified && active.selectedEngine && active.preparedPlayback.preparedProxy) {
            this.remembered = true;
            this.dependencies.rememberEngine?.(active.playback, active.preparedPlayback.preparedProxy, active.selectedEngine);
        }
    }
    async poll(): Promise<void> {
        const active = this.active;
        if (!active || this.terminal || this.recovering || !this.current(active.token)) return;
        const result = this.attempts.poll(this.configuredFallback(active, { code: 'startup-timeout' }) !== undefined);
        if (result.type === 'episode-closed' && !this.sourceVerified) {
            this.sourceVerified = true;
            this.pendingConfiguredPlayback = null;
            if (!active.playback.drm && active.preparedPlayback.preparedProxy) this.dependencies.rememberSource?.(active.preparedPlayback, active.preparedPlayback.preparedProxy);
            this.activity.update({ outcome: 'verified', verified: true }, 'verified');
        }
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
        this.dependencies.invalidateSource?.(previous.preparedPlayback, issue);
        if (isDnsFailure(issue) && issue.networkCode !== 'EAI_AGAIN') {
            try { this.failedDnsHosts.add(new URL(previous.originalUrl).hostname); } catch { /* Invalid sources have no usable alternative. */ }
        }
        const configuredFallback = this.configuredFallback(previous, issue);
        const alternative = configuredFallback ? configuredFallback.originalStreamUrl ?? configuredFallback.streamUrl : nextAutomaticSource(previous.playback, previous.originalUrl, issue, this.attemptedSources, this.failedDnsHosts);
        const decision = supplied ?? this.attempts.recordFailure({
            code: issue.code === 'browser-access-error' && this.dependencies.companionAvailable?.() && this.processingMode === 'direct' ? 'network-error' : issue.code, status: issue.status, retryAfterMs: issue.retryAfterMs,
            renewableLinkSupported: this.dependencies.canRenew?.(previous.playback, previous.context) === true,
            networkCode: issue.networkCode, sourceAlternativeAvailable: alternative !== undefined, configuredSourceFallbackAvailable: configuredFallback !== undefined,
        });
        if (decision.category === 'decoder' && previous.selectedEngine) {
            // A different transport can support the same codec in a different container.
            if (issue.code !== 'unsupported-container') this.failedDecoderFamilies.add(this.family(previous.selectedEngine));
            const media = previous.preparedPlayback.preparedProxy;
            if (media) this.dependencies.invalidateEngine?.(previous.playback, media, previous.selectedEngine);
        }
        // Browser autoplay policy needs a user gesture; keep its existing controls mounted.
        if (decision.category === 'autoplay') { this.activity.update({ reason: 'Press Play to allow playback.' }); this.dependencies.onRecovery?.('Press Play to allow playback.'); return false; }
        this.activity.update({ outcome: 'failed', reason: this.failureReason(issue) }, 'recovering');
        if (decision.action === 'stop') return this.finishFailure(previous, issue, decision.reason);
        let playback = this.dependencies.snapshotPlayback?.(previous.playback) ?? previous.playback;
        if (!playback.isLive && Number.isFinite(issue.positionSeconds)) playback = { ...playback, startTime: Math.max(0, issue.positionSeconds!) };
        if (playback.isLive) playback = { ...playback, startTime: undefined };
        let engine = previous.selectedEngine ?? undefined;
        if (decision.action === 'alternate') {
            if (!alternative) return this.finishFailure(previous, issue, 'No untried provider source remains.');
            playback = { ...playback, streamUrl: alternative, originalStreamUrl: alternative, preparedProxy: undefined,
                recovery: configuredFallback ? configuredFallback.recovery : playback.recovery };
            this.pendingConfiguredPlayback = null;
            engine = this.manualEngine;
            this.tried.clear();
        }
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
        const recoveryReason = this.processingMode === 'convert' ? 'Converting for compatibility; quality may change.' : this.processingMode === 'remux' ? 'Repackaging the stream for browser compatibility.' : decision.action === 'switch' ? `Recovering playback with ${engine}.` : decision.action === 'renew' ? 'Refreshing the provider stream link.' : decision.action === 'alternate' ? configuredFallback ? 'The remembered choice failed; trying the channel’s configured source.' : 'Trying a provider-supported host or stream format.' : 'Reconnecting playback.';
        this.activity.update({ reason: `${this.failureReason(issue)} ${recoveryReason}` }, 'recovering');
        this.dependencies.onRecovery?.(recoveryReason);
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || signal.aborted || !this.current(token)) {
            if (token === null && selection === this.selection && !signal.aborted) this.activity.stop('Recovery could not close the previous player. Close it and retry.');
            return false;
        }
        this.active = null;
        this.notifyPreparing(playback, token, previous.context);
        try {
            if (decision.delayMs) await this.wait(decision.delayMs, signal);
            if (decision.action === 'renew') {
                if (!this.dependencies.renewPlayback) return false;
                const renewed = await this.bounded(this.dependencies.renewPlayback(playback, previous.context, signal), Math.max(1, decision.remainingMs ?? 1), signal);
                if (selection !== this.selection || signal.aborted || !this.current(token)) return false;
                this.pendingConfiguredPlayback = null;
                playback = { ...playback, ...renewed, originalStreamUrl: renewed.originalStreamUrl ?? renewed.streamUrl,
                    preparedProxy: undefined, recovery: renewed.recovery, startTime: playback.startTime, startPaused: playback.startPaused };
            }
            if (selection !== this.selection || signal.aborted || !this.current(token)) return false;
            await this.startAttempt(playback, previous.context, token, previous.support, engine);
            return !!this.activePlayback?.selectedEngine;
        } catch (error) {
            if (!signal.aborted && selection === this.selection && this.current(token)) {
                this.terminal = true;
                this.activity.stop('Auto could not complete recovery within this selection. Retry to start again.');
                this.failure(playback, previous.context, token, errorFromThrown('recovery-failed', error));
            }
            return false;
        }
    }
    private async startAttempt(playback: ResolvedPortalPlayback, context: Context | undefined, token: number, support: AutomaticNativeSupport, forcedEngine?: VideoPlayer): Promise<void> {
        const window = this.attempts.startAttempt();
        if (!window.started) {
            this.terminal = true;
            this.activity.stop('Playback recovery budget exhausted. Retry to start again.');
            this.failure(playback, context, token, { code: 'recovery-exhausted', status: null, message: 'Playback recovery budget exhausted. Retry to start again.' });
            return;
        }
        const originalUrl = playback.originalStreamUrl ?? playback.streamUrl;
        this.activity.start(originalUrl, inferAutomaticPlaybackFormat(originalUrl), this.attemptedSources.size === 0 && this.rememberedSourceApplied ? 'Using a previously verified host and format.' : undefined);
        this.attemptedSources.add(sourceKey(originalUrl));
        const session = playback.drm ? null : new AutomaticPlaybackSession(this.dependencies);
        const active: ActiveState<Context> = { token, playback, originalUrl, preparedPlayback: playback, selectedEngine: null, nativeAttempted: false, support, session, context };
        this.active = active; this.remembered = false; this.sourceVerified = false;
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
        try { this.failedDnsHosts.delete(new URL(originalUrl).hostname); } catch { /* Source validation is owned by preparation. */ }
        this.activity.update({ format: result.session.format });
        const remembered = this.dependencies.getRememberedEngine?.(playback, result.session);
        const capabilities = { ...support, browserCodecs: { ...support.browserCodecs, ...this.dependencies.getBrowserCodecs?.(result.session) } };
        active.support = capabilities;
        active.preparedPlayback = { ...playback, streamUrl: result.session.url, originalStreamUrl: originalUrl, preparedProxy: result.session };
        const candidates = rankAutomaticPlaybackEngines(result.session, capabilities, remembered);
        const engine = forcedEngine ?? (playback.drm ? VideoPlayer.Html5Player : candidates.find(candidate => !this.tried.has(candidate) && !this.failedDecoderFamilies.has(this.family(candidate))));
        if (!engine) { await this.replace(active, { code: 'unsupported-container', sourceUrl: playback.streamUrl }); return; }
        const preparedPlayback = { ...playback, playbackAttemptToken: token, streamUrl: result.session.url, originalStreamUrl: originalUrl, preparedProxy: result.session };
        const enginePlayback = playback.drm ? playback : result.session.processingMode === 'direct' ? preparedPlayback : playbackForEngine(preparedPlayback, engine);
        active.preparedPlayback = enginePlayback; active.selectedEngine = engine;
        this.activity.update({ engine });
        active.nativeAttempted = !BROWSER_ENGINES.has(engine); this.tried.add(engine);
        this.decision(engine, result.session.processingMode === 'convert' ? 'Compatibility conversion is active; video quality may be reduced.' : result.session.processingMode === 'remux' ? 'Stream copy remux is active; original codecs are retained.' : this.tried.size > 1 ? `Recovered with ${engine}.` : this.manualEngine ? `Selected player: ${engine}.` : remembered === engine ? `Previously verified ${engine} selected.` : `Compatibility selection: ${engine}.`, token);
        if (!this.current(token) || this.active !== active) return;
        try { await this.dependencies.startPlayback(enginePlayback, engine, context, token); }
        catch {
            if (this.current(token) && this.active === active && !this.abort.signal.aborted) {
                await this.replace(active, { code: 'playback-start-failed', sourceUrl: enginePlayback.streamUrl });
            }
        }
    }
    private configuredFallback(active: ActiveState<Context>, issue: AutomaticPlaybackDiagnostic): ResolvedPortalPlayback | undefined {
        const configured = this.pendingConfiguredPlayback;
        if (!configured || this.sourceVerified || !isSourceRouteFailure(issue)) return undefined;
        const url = configured.originalStreamUrl ?? configured.streamUrl;
        if (this.attemptedSources.has(sourceKey(url))) return undefined;
        try { if (this.failedDnsHosts.has(new URL(url).hostname)) return undefined; } catch { return undefined; }
        return configured;
    }
    private failureReason(issue: AutomaticPlaybackDiagnostic): string {
        if (typeof issue.status === 'number' && Number.isInteger(issue.status) && issue.status >= 100 && issue.status <= 599) return `Provider returned HTTP ${issue.status}.`;
        if (isDnsFailure(issue)) return 'The stream host could not be found.';
        if (issue.code === 'startup-timeout') return 'Playback did not start or stopped advancing.';
        if (issue.code === 'unsupported-container') return 'The player cannot open this media format.';
        if (['unsupported-codec', 'decoder-error', 'media-decode-error'].includes(issue.code)) return 'The player could not decode this stream.';
        if (issue.code === 'drm-error') return 'This protected stream cannot be played.';
        return 'This playback attempt failed.';
    }
    private stopReason(reason: string, issue: AutomaticPlaybackDiagnostic): string {
        switch (reason) {
            case 'episode-deadline': return issue.status === 429 && Number.isFinite(issue.retryAfterMs) && issue.retryAfterMs! > 0
                ? `The provider requested a wait of ${Math.ceil(issue.retryAfterMs! / 1000)} seconds, longer than Auto's remaining recovery window. Retry later.`
                : 'The recovery time limit was reached. Retry to start again.';
            case 'attempt-limit': return 'Auto stopped after three attempts in this recovery episode. Retry to start again.';
            case 'rolling-limit': return 'Auto reached its limit of six recovery actions in ten minutes. Wait before retrying.';
            case 'unresolved-host': return 'No untried provider-supported alternate host remains. Check the provider and retry.';
            case 'renewal-already-used': return 'The refreshed provider link also failed. Check the provider and retry.';
            case 'non-retryable': return 'No supported automatic recovery remains for this failure. Check the source or choose a recovery option.';
            case 'failure-already-handled': return 'This failure has already been handled.';
            case 'no-active-attempt': return 'There is no active playback attempt. Retry to start again.';
            default: return reason;
        }
    }
    private family(engine: VideoPlayer): string { return BROWSER_ENGINES.has(engine) ? 'browser-decoder' : engine; }
    private async finishFailure(active: ActiveState<Context>, issue: AutomaticPlaybackDiagnostic, reason: string): Promise<boolean> {
        const selection = this.selection;
        this.terminal = true;
        this.activity.stop(`${this.failureReason(issue)} ${this.stopReason(reason, issue)}`);
        const token = await this.dependencies.prepareForPlayback();
        if (token === null || selection !== this.selection || !this.current(token) || this.abort.signal.aborted) return false;
        if (active.session) await active.session.dispose();
        this.active = null;
        this.failure(active.playback, active.context, token, { code: issue.code, status: issue.status ?? null, message: issue.message ?? reason, ...(issue.networkCode === undefined ? {} : { networkCode: issue.networkCode }), ...(issue.retryAfterMs === undefined ? {} : { retryAfterMs: issue.retryAfterMs }) });
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
