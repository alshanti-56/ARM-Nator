export const CREDENTIAL_TESTER_IPC = {
    cancel: 'IPTV_CREDENTIAL_TEST_CANCEL',
    progress: 'IPTV_CREDENTIAL_TEST_PROGRESS',
    start: 'IPTV_CREDENTIAL_TEST_START',
} as const;

export const CREDENTIAL_TESTER_DEFAULT_CONCURRENCY = 6;
export const CREDENTIAL_TESTER_MAX_CONCURRENCY = 6;
export const CREDENTIAL_TESTER_MAX_INPUTS = 100;
export const CREDENTIAL_TESTER_DEFAULT_TIMEOUT_MS = 12_000;
export const CREDENTIAL_TESTER_MAX_TIMEOUT_MS = 30_000;
export const CREDENTIAL_TESTER_MIN_TIMEOUT_MS = 1_000;

export type CredentialTestProvider = 'xtream' | 'm3u';

export interface CredentialXtreamTestInput {
    readonly id: string;
    readonly provider: 'xtream';
    readonly serverUrl: string;
    readonly username: string;
    readonly password: string;
}

export interface CredentialM3uTestInput {
    readonly id: string;
    readonly provider: 'm3u';
    readonly playlistUrl: string;
}

export type CredentialTestInput =
    | CredentialXtreamTestInput
    | CredentialM3uTestInput;

export type CredentialTestStatus =
    | 'queued'
    | 'testing'
    | 'valid'
    | 'invalid'
    | 'error'
    | 'cancelled';

export const CREDENTIAL_TEST_OUTCOMES = [
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
] as const;

export type CredentialTestOutcome = (typeof CREDENTIAL_TEST_OUTCOMES)[number];

export const CREDENTIAL_TEST_OUTCOME_STATUS: Readonly<
    Record<CredentialTestOutcome, CredentialTestStatus>
> = {
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

export type CredentialTestBatchLifecycleStatus =
    | 'queued'
    | 'testing'
    | 'completed'
    | 'cancelled'
    | 'error';

export interface CredentialAccountSummary {
    readonly status?: string;
    readonly expiresAt?: string;
    readonly activeConnections?: string;
    readonly maxConnections?: string;
    readonly liveCategoriesCount?: number;
    readonly moviesCount?: number;
    readonly seriesCount?: number;
    readonly playlistChannelCount?: number;
}

/** A credential-free snapshot that is safe to send to a renderer. */
export interface CredentialTestResult {
    readonly id: string;
    readonly provider: CredentialTestProvider;
    readonly status: CredentialTestStatus;
    readonly outcome?: CredentialTestOutcome;
    readonly sourceUrl?: string;
    readonly startedAt?: number;
    readonly finishedAt?: number;
    readonly latencyMs?: number;
    readonly httpStatus?: number;
    readonly account?: CredentialAccountSummary;
    readonly message?: string;
}

export interface CredentialTestBatchOptions {
    readonly concurrency: number;
    readonly timeoutMs: number;
}

export interface CredentialTestBatchStartRequest {
    readonly inputs: readonly CredentialTestInput[];
    readonly options: CredentialTestBatchOptions;
}

export interface CredentialTestProgress {
    readonly batchId: string;
    readonly total: number;
    readonly completed: number;
    readonly lifecycleStatus: CredentialTestBatchLifecycleStatus;
    readonly current: readonly CredentialTestResult[];
}

function isNonEmptyString(value: unknown, maxLength = 4_096): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength
    );
}

function isCredentialTestInput(value: unknown): value is CredentialTestInput {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const input = value as Record<string, unknown>;
    if (!isNonEmptyString(input['id'], 256)) {
        return false;
    }

    if (input['provider'] === 'xtream') {
        return (
            isNonEmptyString(input['serverUrl']) &&
            isNonEmptyString(input['username'], 1_024) &&
            isNonEmptyString(input['password'], 1_024)
        );
    }

    return input['provider'] === 'm3u' && isNonEmptyString(input['playlistUrl']);
}

export function isCredentialTestBatchStartRequest(
    value: unknown
): value is CredentialTestBatchStartRequest {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const request = value as Record<string, unknown>;
    if (
        !Array.isArray(request['inputs']) ||
        !request['options'] ||
        typeof request['options'] !== 'object'
    ) {
        return false;
    }

    const options = request['options'] as Record<string, unknown>;
    if (
        !Number.isInteger(options['concurrency']) ||
        (options['concurrency'] as number) < 1 ||
        (options['concurrency'] as number) > CREDENTIAL_TESTER_MAX_CONCURRENCY ||
        !Number.isInteger(options['timeoutMs']) ||
        (options['timeoutMs'] as number) < CREDENTIAL_TESTER_MIN_TIMEOUT_MS ||
        (options['timeoutMs'] as number) > CREDENTIAL_TESTER_MAX_TIMEOUT_MS ||
        request['inputs'].length === 0 ||
        request['inputs'].length > CREDENTIAL_TESTER_MAX_INPUTS ||
        !request['inputs'].every(isCredentialTestInput)
    ) {
        return false;
    }

    const ids = new Set(request['inputs'].map((input) => input.id));
    return ids.size === request['inputs'].length;
}
