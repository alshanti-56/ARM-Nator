import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import type {
    CredentialM3uTestInput,
    CredentialTestInput,
} from '@arm-nator/shared/interfaces';
import {
    isMeaningfulM3u,
    probeCredentialTest,
    readBoundedM3uSample,
    runCredentialTestBatch,
    type CredentialTestRequest,
} from './credential-tester.worker-core';

const options = { concurrency: 6, timeoutMs: 12_000 } as const;

function m3uInput(id: string): CredentialM3uTestInput {
    return {
        id,
        provider: 'm3u',
        playlistUrl: `https://provider.test/${id}.m3u`,
    };
}

const validPlaylist = '#EXTM3U\n#EXTINF:-1,One\nhttps://stream.test/one.ts\n';

test('M3U probe reads a bounded stream when a server ignores Range', async () => {
    const stream = Readable.from([
        Buffer.from(`${validPlaylist}${'x'.repeat(1024 * 1024)}`),
    ]);
    let destroyed = false;
    const destroy = stream.destroy.bind(stream);
    stream.destroy = ((error?: Error) => {
        destroyed = true;
        return destroy(error);
    }) as typeof stream.destroy;

    const sample = await readBoundedM3uSample(stream, new AbortController().signal, 64);

    assert.equal(sample.length, 64);
    assert.equal(destroyed, true);
});

test('requires a header, EXTINF, and a following playable HTTP(S) entry', () => {
    assert.equal(isMeaningfulM3u('#EXTM3U\n#EXTINF:-1,Only metadata\n'), false);
    assert.equal(isMeaningfulM3u('#EXTM3U\n#EXTINF:-1,File\nfile:///tmp/a.ts'), false);
    assert.equal(isMeaningfulM3u(validPlaylist), true);
});

test('batch scheduler never runs more than six source tests concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const request: CredentialTestRequest = async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { status: 200, data: validPlaylist };
    };

    const results: string[] = [];
    await runCredentialTestBatch(
        Array.from({ length: 14 }, (_, index) => m3uInput(String(index))),
        options,
        new AbortController().signal,
        {
            onItemStarted: () => undefined,
            onItemResult: (result) => results.push(result.id),
        },
        { request }
    );

    assert.equal(maxActive, 6);
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
        [m3uInput('one'), m3uInput('two')],
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
    const input = m3uInput('classification');
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
