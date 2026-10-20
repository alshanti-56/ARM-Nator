import { strict as assert } from 'node:assert';
import test from 'node:test';
import type { AutoPlaybackPreparationResult } from '@arm-nator/shared/interfaces';
import { AutomaticPlaybackSession } from './automatic-playback-session';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

test('closing during preparation releases a late successful session before acknowledging disposal', async () => {
    const response = deferred<AutoPlaybackPreparationResult>();
    const release = deferred<void>();
    const resources = new Set(['retained-response']);
    let disposer: (() => Promise<void>) | undefined;
    const session = new AutomaticPlaybackSession({
        prepare: () => response.promise,
        cancel: async () => undefined,
        release: async () => { await release.promise; resources.clear(); },
        registerTeardown: (dispose) => { disposer = dispose; return () => undefined; },
    });
    const pending = session.prepare('https://provider.example/channel', {}, true);
    assert.ok(disposer);
    const disposed = disposer!();
    response.resolve({ ok: true, session: { id: 'retained-response', url: 'http://127.0.0.1/media', format: 'hls' } });
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(resources.size, 1);
    release.resolve();
    await disposed;
    assert.equal(resources.size, 0);
});

test('disposal of an accepted preparation releases its resource and is idempotent', async () => {
    const resources = new Set(['owned']);
    const session = new AutomaticPlaybackSession({
        prepare: async () => ({ ok: true, session: { id: 'owned', url: 'http://127.0.0.1/media', format: 'progressive' } }),
        cancel: async () => undefined,
        release: async (id) => { assert.equal(id, 'owned'); resources.delete(id); },
        registerTeardown: () => () => undefined,
    });
    assert.equal((await session.prepare('https://provider.example/movie', {}, false)).ok, true);
    await Promise.all([session.dispose(), session.dispose()]);
    assert.equal(resources.size, 0);
});

test('authorization failure is retained intact and cleanup failure is not acknowledged as success', async () => {
    const failure: AutoPlaybackPreparationResult = { ok: false, error: { code: 'http-error', status: 401, message: 'HTTP 401' } };
    const session = new AutomaticPlaybackSession({
        prepare: async () => failure,
        cancel: async () => { throw new Error('Release failed'); },
        release: async () => undefined,
        registerTeardown: () => () => undefined,
    });
    assert.deepEqual(await session.prepare('https://provider.example/channel', {}, true), failure);
    await assert.rejects(session.dispose(), /Release failed/);
});

test('failed release keeps its teardown registered so the next transition can retry cleanup', async () => {
    let disposer: (() => Promise<void>) | null = null;
    let failRelease = true;
    const resources = new Set(['owned']);
    const session = new AutomaticPlaybackSession({
        prepare: async () => ({ ok: true, session: { id: 'owned', url: 'http://127.0.0.1/media', format: 'hls' } }),
        cancel: async () => undefined,
        release: async () => { if (failRelease) throw new Error('Pending release'); resources.clear(); },
        registerTeardown: (dispose) => { disposer = dispose; return () => { disposer = null; }; },
    });
    await session.prepare('https://provider.example/channel', {}, true);
    await assert.rejects(session.dispose(), /Pending release/);
    assert.ok(disposer);
    assert.equal(resources.size, 1);
    failRelease = false;
    await session.dispose();
    assert.equal(resources.size, 0);
    assert.equal(disposer, null);
});

test('combined disposal failures retain their underlying reasons in the user-visible message', async () => {
    const session = new AutomaticPlaybackSession({
        prepare: async () => ({ ok: true, session: { id: 'owned', url: 'http://127.0.0.1/media', format: 'progressive' } }),
        cancel: async () => { throw new Error('Timed out draining handler for owned'); },
        release: async () => { throw new Error('Local response close acknowledgement missing'); },
        registerTeardown: () => () => undefined,
    });
    await session.prepare('https://provider.example/movie', {}, false);
    await assert.rejects(session.dispose(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /Timed out draining handler for owned/);
        assert.match(error.message, /Local response close acknowledgement missing/);
        return true;
    });
});
