import type {
    CredentialAccountSummary,
    CredentialTestBatchLifecycleStatus,
    CredentialTestInput,
    CredentialTestOutcome,
    CredentialTestProgress,
    CredentialTestResult,
} from '@arm-nator/shared/interfaces';
type TerminalReason = 'cancelled' | 'completed' | 'error';

const OUTCOMES: readonly CredentialTestOutcome[] = [
    'working',
    'expired',
    'disabled',
    'invalid-credentials',
    'invalid-url',
    'timeout',
    'server-offline',
    'server-error',
    'unknown-error',
    'cancelled',
];

const OUTCOME_STATUS: Readonly<Record<CredentialTestOutcome, CredentialTestResult['status']>> = {
    working: 'valid',
    expired: 'invalid',
    disabled: 'invalid',
    'invalid-credentials': 'invalid',
    'invalid-url': 'invalid',
    timeout: 'error',
    'server-offline': 'error',
    'server-error': 'error',
    'unknown-error': 'error',
    cancelled: 'cancelled',
};

function messageFor(outcome: CredentialTestOutcome): string {
    switch (outcome) {
        case 'working':
            return 'Source is valid.';
        case 'expired':
            return 'Account is expired.';
        case 'disabled':
            return 'Account is disabled.';
        case 'invalid-credentials':
            return 'Provider rejected the credentials.';
        case 'invalid-url':
            return 'The source URL or playlist response is invalid.';
        case 'timeout':
            return 'The request timed out.';
        case 'server-offline':
            return 'The server could not be reached.';
        case 'server-error':
            return 'The server returned an error.';
        case 'cancelled':
            return 'Testing was cancelled.';
        case 'unknown-error':
            return 'The source could not be tested.';
    }
}

function isOutcome(value: unknown): value is CredentialTestOutcome {
    return (
        typeof value === 'string' &&
        (OUTCOMES as readonly string[]).includes(value)
    );
}

function safeNumber(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max
        ? value
        : undefined;
}

function safeCount(value: unknown): number | undefined {
    return safeNumber(value, 0, 1_000_000);
}

function safeDigits(value: unknown): string | undefined {
    const normalized = typeof value === 'string' ? value.trim() : String(value ?? '');
    return /^\d{1,20}$/.test(normalized) ? normalized : undefined;
}

function safeAccount(value: unknown): CredentialAccountSummary | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const account = value as CredentialAccountSummary;
    const status = typeof account.status === 'string'
        && /^(active|enabled|disabled|banned|expired)$/i.test(account.status.trim())
        ? account.status.trim()
        : undefined;
    const sanitized: CredentialAccountSummary = {
        ...(status ? { status } : {}),
        ...(safeDigits(account.expiresAt) ? { expiresAt: safeDigits(account.expiresAt) } : {}),
        ...(safeDigits(account.activeConnections)
            ? { activeConnections: safeDigits(account.activeConnections) }
            : {}),
        ...(safeDigits(account.maxConnections)
            ? { maxConnections: safeDigits(account.maxConnections) }
            : {}),
        ...(safeCount(account.liveCategoriesCount) !== undefined
            ? { liveCategoriesCount: safeCount(account.liveCategoriesCount) }
            : {}),
        ...(safeCount(account.moviesCount) !== undefined
            ? { moviesCount: safeCount(account.moviesCount) }
            : {}),
        ...(safeCount(account.seriesCount) !== undefined
            ? { seriesCount: safeCount(account.seriesCount) }
            : {}),
        ...(safeCount(account.playlistChannelCount) !== undefined
            ? { playlistChannelCount: safeCount(account.playlistChannelCount) }
            : {}),
    };
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sourceFor(input: CredentialTestInput): string {
    return input.serverUrl;
}

function queuedResult(input: CredentialTestInput): CredentialTestResult {
    return {
        id: input.id,
        provider: input.provider,
        sourceUrl: sourceFor(input),
        status: 'queued',
    };
}

export class CredentialTesterBatchLifecycle {
    private readonly inputs = new Map<string, CredentialTestInput>();
    private readonly orderedIds: string[];
    private readonly results = new Map<string, CredentialTestResult>();
    private lifecycleStatus: CredentialTestBatchLifecycleStatus = 'queued';
    private terminal = false;

    constructor(
        readonly batchId: string,
        inputs: readonly CredentialTestInput[]
    ) {
        this.orderedIds = inputs.map((input) => input.id);
        for (const input of inputs) {
            this.inputs.set(input.id, input);
            this.results.set(input.id, queuedResult(input));
        }
    }

    get isTerminal(): boolean {
        return this.terminal;
    }

    snapshot(): CredentialTestProgress {
        const current: CredentialTestResult[] = [];
        for (const id of this.orderedIds) {
            const result = this.results.get(id);
            if (result) {
                current.push(result);
            }
        }
        return {
            batchId: this.batchId,
            total: current.length,
            completed: current.filter((result) => Boolean(result.outcome)).length,
            lifecycleStatus: this.lifecycleStatus,
            current,
        };
    }

    markTesting(id: string, startedAt: number): CredentialTestProgress | null {
        if (this.terminal) {
            return null;
        }
        const current = this.results.get(id);
        if (!current || current.status !== 'queued') {
            return null;
        }
        this.lifecycleStatus = 'testing';
        this.results.set(id, {
            ...current,
            status: 'testing',
            startedAt: safeNumber(startedAt),
        });
        return this.snapshot();
    }

    recordResult(result: CredentialTestResult): CredentialTestProgress | null {
        if (this.terminal || !isOutcome(result.outcome)) {
            return null;
        }
        const input = this.inputs.get(result.id);
        const current = this.results.get(result.id);
        if (!input || !current || current.outcome) {
            return null;
        }

        const outcome = result.outcome;
        this.lifecycleStatus = 'testing';
        this.results.set(result.id, {
            id: result.id,
            provider: input.provider,
            sourceUrl: sourceFor(input),
            status: OUTCOME_STATUS[outcome],
            outcome,
            message: messageFor(outcome),
            ...(safeNumber(result.startedAt) !== undefined
                ? { startedAt: safeNumber(result.startedAt) }
                : current.startedAt !== undefined
                  ? { startedAt: current.startedAt }
                  : {}),
            ...(safeNumber(result.finishedAt) !== undefined
                ? { finishedAt: safeNumber(result.finishedAt) }
                : {}),
            ...(safeNumber(result.latencyMs) !== undefined
                ? { latencyMs: safeNumber(result.latencyMs) }
                : {}),
            ...(safeNumber(result.httpStatus, 100, 599) !== undefined
                ? { httpStatus: safeNumber(result.httpStatus, 100, 599) }
                : {}),
            ...(safeAccount(result.account) ? { account: safeAccount(result.account) } : {}),
        });
        return this.snapshot();
    }

    finish(reason: TerminalReason): CredentialTestProgress | null {
        if (this.terminal) {
            return null;
        }
        this.terminal = true;
        const hadUnfinished = [...this.results.values()].some(
            (result) => !result.outcome
        );
        const fallback: CredentialTestOutcome =
            reason === 'cancelled' ? 'cancelled' : 'unknown-error';
        for (const id of this.orderedIds) {
            const current = this.results.get(id);
            if (!current || current.outcome) {
                continue;
            }
            this.results.set(id, {
                ...current,
                status: OUTCOME_STATUS[fallback],
                outcome: fallback,
                message: messageFor(fallback),
                finishedAt: Date.now(),
            });
        }
        this.lifecycleStatus =
            reason === 'cancelled'
                ? 'cancelled'
                : reason === 'completed' &&
                    !hadUnfinished
                  ? 'completed'
                  : 'error';
        return this.snapshot();
    }
}
