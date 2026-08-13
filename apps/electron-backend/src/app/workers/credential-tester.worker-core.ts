/* eslint-disable max-lines */
import type {
    CredentialAccountSummary,
    CredentialTestBatchOptions,
    CredentialTestInput,
    CredentialTestOutcome,
    CredentialTestResult,
    CredentialXtreamTestInput,
} from '@arm-nator/shared/interfaces';
const CLIENT_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';

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

export interface CredentialTestHttpResponse<T = unknown> {
    readonly status: number;
    readonly data: T;
}

export interface CredentialTestRequestConfig {
    readonly headers?: Readonly<Record<string, string>>;
    readonly method: 'GET';
    readonly responseType?: 'stream';
    readonly signal: AbortSignal;
    readonly timeout: number;
    readonly validateStatus: (status: number) => boolean;
}

export type CredentialTestRequest = <T>(
    url: string,
    config: CredentialTestRequestConfig
) => Promise<CredentialTestHttpResponse<T>>;

export interface CredentialReadable {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
    destroy?: (error?: Error) => void;
}

export interface CredentialTesterWorkerDependencies {
    readonly now?: () => number;
    readonly request: CredentialTestRequest;
}

export interface CredentialTesterBatchCallbacks {
    readonly onItemResult: (result: CredentialTestResult) => void;
    readonly onItemStarted: (id: string, startedAt: number) => void;
}

type XtreamUserInfo = {
    auth?: number | string;
    status?: string;
    exp_date?: string | number;
    active_cons?: string | number;
    max_connections?: string | number;
};

type XtreamAccountResponse = {
    auth?: number | string;
    user_info?: XtreamUserInfo;
};

function now(dependencies: CredentialTesterWorkerDependencies): number {
    return dependencies.now?.() ?? Date.now();
}

function createAbortError(): Error {
    const error = new Error('Credential test was cancelled');
    error.name = 'AbortError';
    return error;
}

function isAbortError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'CanceledError')
    );
}

function staticMessage(outcome: CredentialTestOutcome): string {
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

function sourceUrl(input: CredentialTestInput): string {
    return input.serverUrl;
}

function resultFor(
    input: CredentialTestInput,
    outcome: CredentialTestOutcome,
    startedAt: number,
    dependencies: CredentialTesterWorkerDependencies,
    partial: Omit<CredentialTestResult, 'id' | 'message' | 'outcome' | 'provider' | 'sourceUrl' | 'startedAt' | 'status'> = {}
): CredentialTestResult {
    return {
        id: input.id,
        provider: input.provider,
        status: OUTCOME_STATUS[outcome],
        outcome,
        sourceUrl: sourceUrl(input),
        startedAt,
        finishedAt: now(dependencies),
        latencyMs: now(dependencies) - startedAt,
        message: staticMessage(outcome),
        ...partial,
    };
}

function statusResult(
    input: CredentialTestInput,
    status: number,
    startedAt: number,
    dependencies: CredentialTesterWorkerDependencies
): CredentialTestResult {
    const outcome: CredentialTestOutcome =
        status === 401 || status === 403
            ? 'invalid-credentials'
            : status >= 400
              ? 'server-error'
              : 'unknown-error';
    return resultFor(input, outcome, startedAt, dependencies, {
        httpStatus: status,
    });
}

function classifyError(
    input: CredentialTestInput,
    error: unknown,
    startedAt: number,
    signal: AbortSignal,
    dependencies: CredentialTesterWorkerDependencies
): CredentialTestResult {
    if (signal.aborted || isAbortError(error)) {
        return resultFor(input, 'cancelled', startedAt, dependencies);
    }

    const candidate = error as {
        code?: unknown;
        name?: unknown;
        response?: { status?: unknown };
        status?: unknown;
    };
    const code = typeof candidate?.code === 'string' ? candidate.code : '';
    const status = Number(candidate?.response?.status ?? candidate?.status);
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return resultFor(input, 'timeout', startedAt, dependencies);
    }
    if (status === 401 || status === 403) {
        return resultFor(input, 'invalid-credentials', startedAt, dependencies, {
            httpStatus: status,
        });
    }
    if (Number.isFinite(status) && status >= 400) {
        return resultFor(input, 'server-error', startedAt, dependencies, {
            httpStatus: status,
        });
    }
    if (
        code === 'ENOTFOUND' ||
        code === 'ECONNREFUSED' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH'
    ) {
        return resultFor(input, 'server-offline', startedAt, dependencies);
    }
    if (
        code === 'ERR_INVALID_URL' ||
        candidate?.name === 'UnsafeUrlError' ||
        candidate?.name === 'TypeError'
    ) {
        return resultFor(input, 'invalid-url', startedAt, dependencies);
    }

    return resultFor(input, 'unknown-error', startedAt, dependencies);
}

function requestConfig(
    timeout: number,
    signal: AbortSignal,
    responseType?: 'stream'
): CredentialTestRequestConfig {
    return {
        method: 'GET',
        timeout,
        signal,
        responseType,
        validateStatus: (status) => status >= 200 && status < 500,
        headers: {
            Accept: 'application/json, text/plain, */*',
            'User-Agent': CLIENT_USER_AGENT,
        },
    };
}

function createXtreamUrl(input: CredentialXtreamTestInput, action?: string): string {
    const server = new URL(input.serverUrl);
    if (
        (server.protocol !== 'http:' && server.protocol !== 'https:') ||
        server.username ||
        server.password
    ) {
        throw new TypeError('Invalid URL');
    }

    const url = new URL('/player_api.php', server.origin);
    url.searchParams.set('username', input.username);
    url.searchParams.set('password', input.password);
    if (action) {
        url.searchParams.set('action', action);
    }
    return url.toString();
}

function toOptionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    return String(value);
}

function isPastExpiry(value: unknown, currentTime: number): boolean {
    const expiry = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(expiry) && expiry > 0 && expiry * 1_000 < currentTime;
}

async function categoryCount(
    input: CredentialXtreamTestInput,
    action: string,
    options: CredentialTestBatchOptions,
    signal: AbortSignal,
    dependencies: CredentialTesterWorkerDependencies
): Promise<number> {
    try {
        const response = await dependencies.request<unknown>(
            createXtreamUrl(input, action),
            requestConfig(options.timeoutMs, signal)
        );
        if (signal.aborted) {
            throw createAbortError();
        }
        return response.status < 400 && Array.isArray(response.data)
            ? response.data.length
            : 0;
    } catch (error) {
        if (signal.aborted || isAbortError(error)) {
            throw createAbortError();
        }
        return 0;
    }
}

async function testXtream(
    input: CredentialXtreamTestInput,
    options: CredentialTestBatchOptions,
    signal: AbortSignal,
    startedAt: number,
    dependencies: CredentialTesterWorkerDependencies
): Promise<CredentialTestResult> {
    const response = await dependencies.request<XtreamAccountResponse>(
        createXtreamUrl(input),
        requestConfig(options.timeoutMs, signal)
    );
    if (signal.aborted) {
        throw createAbortError();
    }
    if (response.status >= 400) {
        return statusResult(input, response.status, startedAt, dependencies);
    }

    const userInfo = response.data?.user_info;
    const auth = Number(userInfo?.auth ?? response.data?.auth ?? 0);
    const account: CredentialAccountSummary = {
        status: toOptionalString(userInfo?.status),
        expiresAt: toOptionalString(userInfo?.exp_date),
        activeConnections: toOptionalString(userInfo?.active_cons),
        maxConnections: toOptionalString(userInfo?.max_connections),
    };

    if (auth !== 1) {
        return resultFor(input, 'invalid-credentials', startedAt, dependencies, {
            account,
        });
    }

    const normalizedStatus = account.status?.trim().toLowerCase();
    const outcome: CredentialTestOutcome = isPastExpiry(
        userInfo?.exp_date,
        now(dependencies)
    )
        ? 'expired'
        : normalizedStatus === 'expired'
          ? 'expired'
          : normalizedStatus === 'disabled' || normalizedStatus === 'banned'
            ? 'disabled'
            : 'working';
    if (outcome !== 'working') {
        return resultFor(input, outcome, startedAt, dependencies, { account });
    }

    const [liveCategoriesCount, moviesCount, seriesCount] = await Promise.all([
        categoryCount(input, 'get_live_categories', options, signal, dependencies),
        categoryCount(input, 'get_vod_categories', options, signal, dependencies),
        categoryCount(input, 'get_series_categories', options, signal, dependencies),
    ]);
    if (signal.aborted) {
        throw createAbortError();
    }

    return resultFor(input, 'working', startedAt, dependencies, {
        account: {
            ...account,
            liveCategoriesCount,
            moviesCount,
            seriesCount,
        },
    });
}

export async function probeCredentialTest(
    input: CredentialTestInput,
    options: CredentialTestBatchOptions,
    signal: AbortSignal,
    startedAt: number,
    dependencies: CredentialTesterWorkerDependencies
): Promise<CredentialTestResult> {
    try {
        return await testXtream(input, options, signal, startedAt, dependencies);
    } catch (error) {
        return classifyError(input, error, startedAt, signal, dependencies);
    }
}

/** Runs a bounded input scheduler; aborting stops new work and aborts active requests. */
export async function runCredentialTestBatch(
    inputs: readonly CredentialTestInput[],
    options: CredentialTestBatchOptions,
    signal: AbortSignal,
    callbacks: CredentialTesterBatchCallbacks,
    dependencies: CredentialTesterWorkerDependencies
): Promise<void> {
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
        while (!signal.aborted) {
            const index = nextIndex;
            nextIndex += 1;
            const input = inputs[index];
            if (!input) {
                return;
            }
            const startedAt = now(dependencies);
            callbacks.onItemStarted(input.id, startedAt);
            const result = await probeCredentialTest(
                input,
                options,
                signal,
                startedAt,
                dependencies
            );
            callbacks.onItemResult(result);
            if (result.outcome === 'cancelled') {
                return;
            }
        }
    };

    await Promise.all(
        Array.from(
            { length: Math.min(options.concurrency, inputs.length) },
            runNext
        )
    );
}
