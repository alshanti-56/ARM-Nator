import assert from 'node:assert/strict';
import test from 'node:test';
import { probeUserAgentMedia, runUserAgentTests, type UserAgentTestResult } from './user-agent-test-runner';

const profiles = [
    { id: 'a', label: 'First profile', value: 'First' },
    { id: 'b', label: 'Second profile', value: 'Second' },
];
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test('refreshes each sample, tries a second channel after rejection and runs sequentially', async () => {
    const calls: string[] = [];
    const results: UserAgentTestResult[] = [];
    let active = 0;
    await runUserAgentTests(profiles, new AbortController().signal, {
        resolveSample: async (profile, index) => {
            assert.equal(active, 0);
            calls.push(`${profile.id}:${index}`);
            return { url: `https://example.test/${profile.id}/${index}`, headers: { 'User-Agent': profile.value } };
        },
        probe: async (sample) => {
            assert.equal(active++, 0);
            await Promise.resolve();
            active--;
            return { working: sample.url.endsWith('/a/1'), detail: sample.url.endsWith('/a/1') ? 'mpegts media detected' : 'HTTP 458' };
        },
    }, (result) => results.push(result));
    assert.deepEqual(calls, ['a:0', 'a:1', 'b:0', 'b:1']);
    assert.equal(results.find((result) => result.profile.id === 'a' && result.state === 'working')?.detail, 'mpegts media detected');
    assert.equal(results.at(-1)?.state, 'failed');
    assert.equal(results.at(-1)?.detail, 'HTTP 458');
});

test('cancelling an in-flight test starts no further samples or profiles', async () => {
    const controller = new AbortController();
    const results: UserAgentTestResult[] = [];
    let resolves = 0;
    await runUserAgentTests(profiles, controller.signal, {
        resolveSample: async () => { resolves++; return { url: 'https://example.test', headers: {} }; },
        probe: async () => { controller.abort(); throw controller.signal.reason; },
    }, (result) => results.push(result));
    assert.equal(resolves, 1);
    assert.deepEqual(results.filter((result) => result.state === 'cancelled').map((result) => result.profile.id), ['a', 'b']);
});

test('media probe reports HTTP rejection without classifying it as playable', async () => {
    const result = await probeUserAgentMedia({
        prepareAutoPlayback: async () => ({ ok: false, error: { status: 458, code: 'http-error', message: 'private upstream details' } }),
        cancelAutoPlaybackPreparation: async () => undefined,
        releaseAutoPlaybackSession: async () => { assert.fail('No session should exist'); },
    }, { url: 'https://example.test', headers: {} }, new AbortController().signal);
    assert.deepEqual(result, { working: false, detail: 'HTTP 458' });
});

test('recognized media is released before publishing a successful probe', async () => {
    let released = false;
    const result = await probeUserAgentMedia({
        prepareAutoPlayback: async () => ({ ok: true, session: { id: 'test', url: 'http://127.0.0.1/test', format: 'mpegts', container: 'mpegts' } }),
        cancelAutoPlaybackPreparation: async () => undefined,
        releaseAutoPlaybackSession: async () => { released = true; },
    }, { url: 'https://example.test', headers: {} }, new AbortController().signal);
    assert.equal(released, true);
    assert.equal(result.working, true);
});

test('cancellation waits for cleanup and releases a late successful preparation exactly once', async () => {
    const controller = new AbortController();
    const preparation = deferred<Awaited<ReturnType<Parameters<typeof probeUserAgentMedia>[0]['prepareAutoPlayback']>>>();
    const cleanup = deferred<void>();
    let cancelled = 0;
    let released = 0;
    let finished = false;
    const probe = probeUserAgentMedia({
        prepareAutoPlayback: () => preparation.promise,
        cancelAutoPlaybackPreparation: () => { cancelled++; return cleanup.promise; },
        releaseAutoPlaybackSession: async () => { released++; },
    }, { url: 'https://example.test', headers: {} }, controller.signal).finally(() => { finished = true; });
    const rejection = assert.rejects(probe);
    controller.abort();
    await Promise.resolve();
    assert.equal(cancelled, 1);
    assert.equal(finished, false);
    cleanup.resolve();
    await rejection;
    preparation.resolve({ ok: true, session: { id: 'late', url: 'http://127.0.0.1/test', format: 'mpegts' } });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(released, 1);
});
