import assert from 'node:assert/strict';
import test from 'node:test';

import { CatalogueRefreshCoordinator } from './coalesced-catalogue-refresh';

test('duplicate refreshes share one fetch and one committed snapshot', async () => {
    const Coordinator = CatalogueRefreshCoordinator<string, string>;
    let finish!: (value: string) => void;
    let value = 'old'; let fetches = 0;
    const fetch = new Promise<string>(resolve => { finish = resolve; });
    const coordinator = new Coordinator({ fetch: () => { fetches++; return fetch; }, commit: async (_id: string, snapshot: string) => { value = snapshot; return value; }, cancel: async () => undefined });
    const a = coordinator.run('one', 'same-account', 'first', undefined);
    const b = coordinator.run('one', 'same-account', 'second', undefined);
    assert.equal(a, b);
    assert.equal(value, 'old');
    finish('new'); assert.equal(await a, 'new'); assert.equal(fetches, 1);
});

test('failed fetches keep the previous snapshot and permit a retry', async () => {
    const Coordinator = CatalogueRefreshCoordinator<string, string>;
    let value = 'old'; let attempt = 0;
    const coordinator = new Coordinator({ fetch: async () => { if (attempt++ === 0) throw new Error('provider failure'); return 'new'; }, commit: async (_id: string, snapshot: string) => { value = snapshot; return value; }, cancel: async () => undefined });
    await assert.rejects(coordinator.run('one', 'account', 'first', undefined), /provider failure/);
    assert.equal(value, 'old');
    assert.equal(await coordinator.run('one', 'account', 'second', undefined), 'new');
});

test('an old account fetch cannot commit after an account change', async () => {
    const Coordinator = CatalogueRefreshCoordinator<string, string>;
    let finish!: (value: string) => void;
    let value = 'old';
    const delayed = new Promise<string>(resolve => { finish = resolve; });
    const coordinator = new Coordinator({ fetch: (_id: string, operationId: string) => operationId === 'first' ? delayed : Promise.resolve('new-account'), commit: async (_id: string, snapshot: string) => { value = snapshot; return value; }, cancel: async () => undefined });
    const old = coordinator.run('one', 'old-account', 'first', undefined);
    const rejected = assert.rejects(old, /superseded/);
    assert.equal(await coordinator.run('one', 'new-account', 'second', undefined), 'new-account');
    finish('old-account'); await rejected;
    assert.equal(value, 'new-account');
});
