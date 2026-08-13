import type {
    CredentialTestBatchStartRequest,
    CredentialTestResult,
} from '@arm-nator/shared/interfaces';

const MAX_CONCURRENCY = 6;
const MAX_INPUTS = 100;
const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;

function isNonEmptyString(value: unknown, maxLength = 4_096): value is string {
    return (
        typeof value === 'string' &&
        value.trim().length > 0 &&
        value.length <= maxLength
    );
}

function isInput(value: unknown): value is CredentialTestBatchStartRequest['inputs'][number] {
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
    return false;
}

/** Revalidates main-to-worker payloads before a worker can start network I/O. */
export function isCredentialTesterWorkerStartRequest(
    value: unknown
): value is CredentialTestBatchStartRequest {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const request = value as Record<string, unknown>;
    if (
        !Array.isArray(request['inputs']) ||
        request['inputs'].length === 0 ||
        request['inputs'].length > MAX_INPUTS ||
        !request['inputs'].every(isInput) ||
        !request['options'] ||
        typeof request['options'] !== 'object'
    ) {
        return false;
    }
    const options = request['options'] as Record<string, unknown>;
    if (
        !Number.isInteger(options['concurrency']) ||
        (options['concurrency'] as number) < 1 ||
        (options['concurrency'] as number) > MAX_CONCURRENCY ||
        !Number.isInteger(options['timeoutMs']) ||
        (options['timeoutMs'] as number) < MIN_TIMEOUT_MS ||
        (options['timeoutMs'] as number) > MAX_TIMEOUT_MS
    ) {
        return false;
    }
    const ids = new Set(request['inputs'].map((input) => input.id));
    return ids.size === request['inputs'].length;
}

export type CredentialTesterWorkerIncomingMessage =
    | {
          type: 'start';
          batchId: string;
          request: CredentialTestBatchStartRequest;
      }
    | {
          type: 'cancel';
          batchId: string;
      };

export type CredentialTesterWorkerOutgoingMessage =
    | { type: 'ready' }
    | { type: 'item-started'; batchId: string; id: string; startedAt: number }
    | { type: 'item-result'; batchId: string; result: CredentialTestResult }
    | { type: 'complete'; batchId: string }
    | { type: 'fatal'; batchId: string };
