import { isDnsFailure, isSourceRejection, isSourceRouteFailure } from './automatic-playback-sources';

export type PlaybackKind = 'live' | 'vod';
export type PlaybackFailureCategory = 'transport' | 'decoder' | 'account' | 'autoplay' | 'drm' | 'resource' | 'unknown';
export type PlaybackRecoveryAction = 'retry' | 'switch' | 'renew' | 'alternate' | 'stop';

export interface PlaybackFailureInput {
    readonly code?: string;
    readonly status?: number | null;
    readonly retryAfterMs?: number | null;
    readonly renewableLinkSupported?: boolean;
    readonly networkCode?: string;
    readonly sourceAlternativeAvailable?: boolean;
    readonly configuredSourceFallbackAvailable?: boolean;
}

export interface PlaybackRecoveryDecision {
    readonly category: PlaybackFailureCategory;
    readonly action: PlaybackRecoveryAction;
    readonly delayMs: number;
    readonly attemptNumber: number;
    readonly remainingAttempts: number;
    readonly rollingRemaining: number;
    readonly attemptDeadlineAtMs: number | null;
    readonly deadlineAtMs: number | null;
    readonly remainingMs: number | null;
    readonly reason: string;
}

export interface PlaybackAttemptWindow {
    readonly started: boolean;
    readonly attemptNumber: number | null;
    readonly attemptDeadlineAtMs: number | null;
    readonly deadlineAtMs: number | null;
    readonly remainingAttemptMs: number;
    readonly remainingMs: number;
    readonly reason?: 'attempt-limit' | 'deadline';
}

export interface PlaybackProgressSnapshot {
    readonly mediaTimeSeconds: number;
    readonly presentedFrames?: number;
    /** True when this load has presented at least one real frame. */
    readonly frameReady?: boolean;
    readonly audioOnly?: boolean;
    readonly paused?: boolean;
    readonly seeking?: boolean;
    readonly autoplayBlocked?: boolean;
    readonly ended?: boolean;
}

export type PlaybackPollResult =
    | { readonly type: 'none' }
    | { readonly type: 'episode-closed'; readonly stableForMs: number }
    | { readonly type: 'failure'; readonly decision: PlaybackRecoveryDecision };

export interface PlaybackAttemptManagerOptions {
    readonly now?: () => number;
    readonly random?: () => number;
}

const MAX_ATTEMPTS_PER_EPISODE = 3;
const MAX_AUTOMATIC_REPLACEMENTS = 6;
const ROLLING_WINDOW_MS = 10 * 60 * 1_000;
const STABLE_PLAYBACK_MS = 30_000;
const STABLE_PROGRESS_GAP_MS = 3_000;
const VIDEO_TIME_EPSILON_SECONDS = 0.05;
const NO_ACTION: PlaybackPollResult = { type: 'none' };

interface CurrentAttempt {
    readonly startedAtMs: number;
    deadlineAtMs: number;
    verified: boolean;
}

function normalizedCode(code: string | undefined): string {
    return (code ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** Maps known transport and player diagnostics into recovery policy categories. */
export function classifyPlaybackFailure(input: PlaybackFailureInput): PlaybackFailureCategory {
    const status = input.status;
    const code = normalizedCode(input.code);
    if (status === 401 || status === 403) return 'account';
    if (status === 408 || status === 429 || (status !== undefined && status !== null && status >= 500 && status <= 599)) return 'transport';
    if (status === 404 || status === 410) return 'resource';
    if (code === 'provider-rejected') return 'account';
    if (status !== undefined && status !== null && status >= 400 && status <= 499) return 'unknown';
    if (['unsupported-container', 'unsupported-codec', 'media-decode-error', 'decoder-error', 'decode-error'].includes(code)) return 'decoder';
    if (['autoplay-blocked', 'autoplay-error', 'not-allowed', 'user-gesture-required'].includes(code)) return 'autoplay';
    if (['license-error', 'drm-error', 'drm-or-encryption', 'encrypted', 'key-system-error'].includes(code)) return 'drm';
    if (['resource-not-found', 'not-found', 'invalid-resource', 'resource-error', 'unsupported-resource', 'browser-access-error', 'native-unavailable'].includes(code)) return 'resource';
    if (['unauthorized', 'forbidden', 'auth-required', 'account-expired', 'subscription-required'].includes(code)) return 'account';
    if (['network', 'network-error', 'timeout', 'startup-timeout', 'fetch-error', 'connection-error', 'playback-timeout', 'playback-stalled'].includes(code)) return 'transport';
    if (code === 'http-error') return status === undefined || status === null ? 'transport' : 'unknown';
    return 'unknown';
}

/** Pure policy state for retries, engine replacement, progress verification, and stall polling. */
export class PlaybackAttemptManager {
    private readonly now: () => number;
    private readonly random: () => number;
    private selection: { selectionId: string; kind: PlaybackKind } | null = null;
    private episodeDeadlineAtMs: number | null = null;
    private attemptCount = 0;
    private retryCount = 0;
    private renewalUsed = false;
    private episodeClosed = false;
    private currentAttempt: CurrentAttempt | null = null;
    private failureReported = false;
    private readonly automaticActionsAt: number[] = [];
    private lastProgressAtMs: number | null = null;
    private stableSinceAtMs: number | null = null;
    private lastMediaTimeSeconds: number | null = null;
    private lastPresentedFrames: number | null = null;
    private frameSeen = false;
    private verified = false;
    private eligible = true;
    private suspendedAtMs: number | null = null;

    constructor(options: PlaybackAttemptManagerOptions = {}) {
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
    }

    get isVerified(): boolean { return this.verified; }

    /** A new manual source or engine selection starts fresh selection and episode budgets. */
    startSelection(selection: { selectionId: string; kind: PlaybackKind }): void {
        this.selection = { ...selection };
        this.resetSelectionBudgets();
    }

    /** Explicit user Retry starts fresh budgets, including the rolling automatic replacement window. */
    retrySelection(): void {
        this.resetSelectionBudgets();
    }

    /** Begins one initial or replacement attempt and returns both applicable deadlines. */
    startAttempt(): PlaybackAttemptWindow {
        const now = this.now();
        if (!this.selection) return this.unstarted('deadline');
        if (this.episodeDeadlineAtMs === null) this.episodeDeadlineAtMs = now + this.totalBudgetMs();
        if (now >= this.episodeDeadlineAtMs) return this.unstarted('deadline');
        if (this.attemptCount >= MAX_ATTEMPTS_PER_EPISODE) return this.unstarted('attempt-limit');

        this.attemptCount += 1;
        const attemptDeadlineAtMs = Math.min(now + this.attemptBudgetMs(), this.episodeDeadlineAtMs);
        this.currentAttempt = { startedAtMs: now, deadlineAtMs: attemptDeadlineAtMs, verified: false };
        this.failureReported = false;
        this.episodeClosed = false;
        this.lastProgressAtMs = null;
        this.stableSinceAtMs = null;
        this.lastMediaTimeSeconds = null;
        this.lastPresentedFrames = null;
        this.frameSeen = false;
        this.verified = false;
        this.eligible = true;
        this.suspendedAtMs = null;

        return {
            started: true,
            attemptNumber: this.attemptCount,
            attemptDeadlineAtMs,
            deadlineAtMs: this.episodeDeadlineAtMs,
            remainingAttemptMs: Math.max(0, attemptDeadlineAtMs - now),
            remainingMs: Math.max(0, this.episodeDeadlineAtMs - now),
        };
    }

    /** Turns a failure into a bounded retry, decoder switch, account renewal, or stop decision. */
    recordFailure(input: PlaybackFailureInput): PlaybackRecoveryDecision {
        const now = this.now();
        this.pruneAutomaticActions(now);

        if (this.episodeClosed && this.currentAttempt) this.openNextEpisodeAfterStability(now);

        const category = classifyPlaybackFailure(input);
        const attemptNumber = this.attemptCount;
        let action: PlaybackRecoveryAction = 'stop';
        let reason = 'non-retryable';

        if (!this.selection || !this.currentAttempt || this.failureReported) {
            return this.decision(category, 'stop', 0, attemptNumber, this.failureReported ? 'failure-already-handled' : 'no-active-attempt');
        }

        if (this.episodeDeadlineAtMs === null || now >= this.episodeDeadlineAtMs) {
            this.failureReported = true;
            return this.decision(category, 'stop', 0, attemptNumber, 'episode-deadline');
        }
        if (attemptNumber >= MAX_ATTEMPTS_PER_EPISODE) {
            this.failureReported = true;
            return this.decision(category, 'stop', 0, attemptNumber, 'attempt-limit');
        }

        if (category === 'account' && input.renewableLinkSupported && !this.renewalUsed) {
            action = 'renew';
            reason = 'account-renewal';
            this.renewalUsed = true;
        } else if (input.configuredSourceFallbackAvailable && isSourceRouteFailure(input)) {
            action = 'alternate';
            reason = 'configured-source-fallback';
        } else if (input.sourceAlternativeAvailable && (isDnsFailure(input) || isSourceRejection(input))) {
            action = 'alternate';
            reason = 'source-alternative';
        } else if (category === 'decoder') {
            action = 'switch';
            reason = 'decoder-switch';
        } else if (isDnsFailure(input) && input.networkCode !== 'EAI_AGAIN') {
            reason = 'unresolved-host';
        } else if (category === 'transport') {
            action = 'retry';
            reason = 'transport-retry';
        } else if (category === 'account' && input.renewableLinkSupported && this.renewalUsed) {
            reason = 'renewal-already-used';
        }

        if (action === 'stop') {
            this.failureReported = true;
            return this.decision(category, action, 0, attemptNumber, reason);
        }

        if (this.automaticActionsAt.length >= MAX_AUTOMATIC_REPLACEMENTS) {
            this.failureReported = true;
            return this.decision(category, 'stop', 0, attemptNumber, 'rolling-limit');
        }

        let delayMs = 0;
        if (action === 'retry') {
            const baseDelayMs = this.retryCount === 0 ? 1_000 : 3_000;
            const random = Math.min(1, Math.max(0, this.random()));
            delayMs = Math.max(Math.round(baseDelayMs * (0.8 + random * 0.4)), validDuration(input.retryAfterMs));
            if (now + delayMs >= this.episodeDeadlineAtMs) {
                this.failureReported = true;
                return this.decision(category, 'stop', 0, attemptNumber, 'episode-deadline');
            }
            this.retryCount += 1;
        }

        this.failureReported = true;
        this.automaticActionsAt.push(now);
        return this.decision(category, action, delayMs, attemptNumber, reason);
    }

    /** Records evidence from the adapter; video needs a presented frame and advancing time. */
    observeProgress(snapshot: PlaybackProgressSnapshot): void {
        const now = this.now();
        const mediaTime = Number.isFinite(snapshot.mediaTimeSeconds) ? snapshot.mediaTimeSeconds : null;
        const frames = Number.isFinite(snapshot.presentedFrames) ? snapshot.presentedFrames as number : null;
        const excluded = Boolean(snapshot.paused || snapshot.seeking || snapshot.autoplayBlocked || snapshot.ended);

        if (excluded) {
            if (this.suspendedAtMs === null) this.suspendedAtMs = now;
            this.eligible = false;
            this.stableSinceAtMs = null;
            this.lastMediaTimeSeconds = mediaTime;
            this.lastPresentedFrames = frames;
            return;
        }

        if (this.suspendedAtMs !== null) {
            const suspendedForMs = Math.max(0, now - this.suspendedAtMs);
            if (this.episodeDeadlineAtMs !== null) this.episodeDeadlineAtMs += suspendedForMs;
            if (this.currentAttempt) this.currentAttempt.deadlineAtMs += suspendedForMs;
            if (this.lastProgressAtMs !== null) this.lastProgressAtMs += suspendedForMs;
            this.suspendedAtMs = null;
            this.eligible = true;
            this.lastMediaTimeSeconds = mediaTime;
            this.lastPresentedFrames = frames;
            if (snapshot.frameReady || (frames !== null && frames > 0)) this.frameSeen = true;
            return;
        }

        this.eligible = true;
        const mediaAdvanced = mediaTime !== null && this.lastMediaTimeSeconds !== null &&
            mediaTime > this.lastMediaTimeSeconds + VIDEO_TIME_EPSILON_SECONDS;
        if (snapshot.frameReady || (frames !== null && this.lastPresentedFrames !== null && frames > this.lastPresentedFrames) ||
            (frames !== null && this.lastPresentedFrames === null && frames > 0)) this.frameSeen = true;

        const hasFrameCounter = frames !== null || this.lastPresentedFrames !== null;
        const presentedFrameEvidence = hasFrameCounter
            ? frames !== null && this.lastPresentedFrames !== null && frames > this.lastPresentedFrames
            : this.frameSeen;
        const verifiedProgress = mediaAdvanced && (snapshot.audioOnly === true || presentedFrameEvidence);
        if (verifiedProgress && this.currentAttempt) {
            if (this.lastProgressAtMs !== null && now - this.lastProgressAtMs > STABLE_PROGRESS_GAP_MS) this.stableSinceAtMs = null;
            this.currentAttempt.verified = true;
            this.verified = true;
            this.lastProgressAtMs = now;
            if (!this.episodeClosed && this.stableSinceAtMs === null) this.stableSinceAtMs = now;
        } else {
            this.stableSinceAtMs = null;
        }
        this.lastMediaTimeSeconds = mediaTime;
        this.lastPresentedFrames = frames;
    }

    /** Polls startup and progress deadlines. Repeated polls publish each failure only once. */
    poll(configuredSourceFallbackAvailable = false): PlaybackPollResult {
        if (!this.selection || !this.currentAttempt || this.failureReported || !this.eligible || this.suspendedAtMs !== null) return NO_ACTION;
        const now = this.now();
        if (this.currentAttempt.verified && this.lastProgressAtMs !== null) {
            const stalledForMs = now - this.lastProgressAtMs;
            if (stalledForMs > STABLE_PROGRESS_GAP_MS) this.stableSinceAtMs = null;
            if (stalledForMs >= this.attemptBudgetMs()) {
                return { type: 'failure', decision: this.recordFailure({ code: 'playback-stalled', configuredSourceFallbackAvailable }) };
            }
            const stableForMs = this.stableSinceAtMs === null ? 0 : now - this.stableSinceAtMs;
            if (!this.episodeClosed && stableForMs >= STABLE_PLAYBACK_MS) {
                this.closeStableEpisode();
                return { type: 'episode-closed', stableForMs };
            }
            return NO_ACTION;
        }

        const deadline = Math.min(this.currentAttempt.deadlineAtMs, this.episodeDeadlineAtMs ?? this.currentAttempt.deadlineAtMs);
        if (now >= deadline) return { type: 'failure', decision: this.recordFailure({ code: 'playback-timeout', configuredSourceFallbackAvailable }) };
        return NO_ACTION;
    }

    private unstarted(reason: 'attempt-limit' | 'deadline'): PlaybackAttemptWindow {
        return {
            started: false,
            attemptNumber: null,
            attemptDeadlineAtMs: null,
            deadlineAtMs: this.episodeDeadlineAtMs,
            remainingAttemptMs: 0,
            remainingMs: this.episodeDeadlineAtMs === null ? 0 : Math.max(0, this.episodeDeadlineAtMs - this.now()),
            reason,
        };
    }

    private decision(category: PlaybackFailureCategory, action: PlaybackRecoveryAction, delayMs: number, attemptNumber: number, reason: string): PlaybackRecoveryDecision {
        const now = this.now();
        const deadlineAtMs = this.episodeDeadlineAtMs;
        return {
            category,
            action,
            delayMs,
            attemptNumber,
            remainingAttempts: Math.max(0, MAX_ATTEMPTS_PER_EPISODE - attemptNumber),
            rollingRemaining: Math.max(0, MAX_AUTOMATIC_REPLACEMENTS - this.automaticActionsAt.length),
            attemptDeadlineAtMs: this.currentAttempt?.deadlineAtMs ?? null,
            deadlineAtMs,
            remainingMs: deadlineAtMs === null ? null : Math.max(0, deadlineAtMs - now),
            reason,
        };
    }

    private totalBudgetMs(): number { return this.selection?.kind === 'live' ? 30_000 : 60_000; }
    private attemptBudgetMs(): number { return this.selection?.kind === 'live' ? 12_000 : 20_000; }

    private pruneAutomaticActions(now: number): void {
        while (this.automaticActionsAt.length && now - this.automaticActionsAt[0] >= ROLLING_WINDOW_MS) this.automaticActionsAt.shift();
    }

    private resetSelectionBudgets(): void {
        this.episodeDeadlineAtMs = null;
        this.attemptCount = 0;
        this.retryCount = 0;
        this.renewalUsed = false;
        this.episodeClosed = false;
        this.currentAttempt = null;
        this.failureReported = false;
        this.automaticActionsAt.length = 0;
        this.lastProgressAtMs = null;
        this.stableSinceAtMs = null;
        this.lastMediaTimeSeconds = null;
        this.lastPresentedFrames = null;
        this.frameSeen = false;
        this.verified = false;
        this.eligible = true;
        this.suspendedAtMs = null;
    }

    private closeStableEpisode(): void {
        this.attemptCount = 0;
        this.retryCount = 0;
        this.renewalUsed = false;
        this.episodeDeadlineAtMs = null;
        this.episodeClosed = true;
        this.failureReported = false;
        this.stableSinceAtMs = null;
    }

    private openNextEpisodeAfterStability(now: number): void {
        const duration = this.totalBudgetMs();
        this.attemptCount = 1;
        this.retryCount = 0;
        this.renewalUsed = false;
        this.episodeDeadlineAtMs = now + duration;
        this.episodeClosed = false;
        if (this.currentAttempt) this.currentAttempt.deadlineAtMs = Math.min(now + this.attemptBudgetMs(), this.episodeDeadlineAtMs);
        this.stableSinceAtMs = null;
    }
}

function validDuration(value: number | null | undefined): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
