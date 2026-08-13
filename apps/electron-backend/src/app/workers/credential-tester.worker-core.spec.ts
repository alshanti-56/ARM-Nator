import assert from 'node:assert/strict';
import test from 'node:test';
import type { CredentialTestInput } from '@arm-nator/shared/interfaces';
import {
    probeCredentialTest,
    runCredentialTestBatch,
    type CredentialTestRequest,
} from './credential-tester.worker-core';

const options = { concurrency: 6, timeoutMs: 12_000 } as const;

function xtreamInput(id: string): CredentialTestInput {
    return {
        id,
        provider: 'xtream',
        serverUrl: `https://${id}.provider.test`,
        username: 'user',
        password: 'password',
    };
}

test('batch scheduler keeps Xtream request concurrency bounded', async () => {
    let active = 0;
    let maxActive = 0;
    const request: CredentialTestRequest = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return {
            status: 200,
            data: { user_info: { auth: 1, status: 'Active' } },
        };
    };

    const results: string[] = [];
    await runCredentialTestBatch(
        Array.from({ length: 14 }, (_, index) => xtreamInput(String(index))),
        options,
        new AbortController().signal,
        {
            onItemStarted: () => undefined,
            onItemResult: (result) => results.push(result.id),
        },
        { request }
    );

    // Each Xtream probe requests account info and three category counts in
    // parallel, so six source probes produce at most eighteen requests.
    assert.equal(maxActive, options.concurrency * 3);
    assert.equal(results.length, 14);
});

test('cancellation aborts the active request and prevents queued work', async () => {
    const controller = new AbortController();
    let requests = 0;
    let sawAbort = false;
    const request: CredentialTestRequest = async (_url, config) => {
        requests += 1;
        return new Promise((_, reject) => {
            config.signal.addEventListener(
                'abort',
                () => {
                    sawAbort = true;
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                },
                { once: true }
            );
        });
    };
    const outcomes: string[] = [];
    const batch = runCredentialTestBatch(
        [xtreamInput('one'), xtreamInput('two')],
        { concurrency: 1, timeoutMs: 12_000 },
        controller.signal,
        {
            onItemStarted: () => undefined,
            onItemResult: (result) => outcomes.push(result.outcome ?? ''),
        },
        { request }
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await batch;

    assert.equal(sawAbort, true);
    assert.equal(requests, 1);
    assert.deepEqual(outcomes, ['cancelled']);
});

test('classifies timeout, offline, and rejected responses through injected requests', async () => {
    const input = xtreamInput('classification');
    const signal = new AbortController().signal;
    const timeout = await probeCredentialTest(
        input,
        options,
        signal,
        0,
        {
            request: async () => {
                throw { code: 'ETIMEDOUT' };
            },
        }
    );
    const offline = await probeCredentialTest(
        input,
        options,
        signal,
        0,
        {
            request: async () => {
                throw { code: 'ENOTFOUND' };
            },
        }
    );
    const rejected = await probeCredentialTest(
        input,
        options,
        signal,
        0,
        {
            request: async () => ({ status: 401, data: '' }),
        }
    );

    assert.equal(timeout.outcome, 'timeout');
    assert.equal(offline.outcome, 'server-offline');
    assert.equal(rejected.outcome, 'invalid-credentials');
});

test('past numeric Xtream expiry wins over an active account status', async () => {
    const input: CredentialTestInput = {
        id: 'xtream-expired',
        provider: 'xtream',
        serverUrl: 'https://provider.test',
        username: 'user',
        password: 'password',
    };

    const result = await probeCredentialTest(
        input,
        options,
        new AbortController().signal,
        1_800_000_000_000,
        {
            now: () => 1_800_000_000_000,
            request: async () => ({
                status: 200,
                data: {
                    user_info: {
                        auth: 1,
                        exp_date: '1700000000',
                        status: 'Active',
                    },
                },
            }),
        }
    );

    assert.equal(result.outcome, 'expired');
    assert.equal(result.status, 'invalid');
});
