import assert from 'node:assert/strict';
import test from 'node:test';
import { InFlightCatalogueReads } from './in-flight-catalogue-reads';

test('identical pending reads share work but settled snapshots are not retained', async () => {
    const reads = new InFlightCatalogueReads();
    let finish!: (value: string) => void;
    let calls = 0;
    const fetch = () => { calls++; return new Promise<string>(resolve => { finish = resolve; }); };
    const a = reads.run('source:movie', fetch);
    const b = reads.run('source:movie', fetch);
    assert.equal(a, b); assert.equal(calls, 1);
    finish('first'); await a;
    const c = reads.run('source:movie', fetch);
    assert.notEqual(c, a); assert.equal(calls, 2);
    finish('replacement'); assert.equal(await c, 'replacement');
});

test('failures and invalidation allow new reads without an old completion evicting the new one', async () => {
    const reads = new InFlightCatalogueReads();
    await assert.rejects(() => reads.run('one', async () => { throw new Error('read failure'); }), /read failure/);
    let finish!: () => void;
    const old = reads.run('one', () => new Promise<void>(resolve => { finish = resolve; }));
    reads.clear();
    let finishNew!: () => void;
    const next = reads.run('one', () => new Promise<void>(resolve => { finishNew = resolve; }));
    finish(); await old;
    assert.equal(reads.run('one', () => Promise.reject(new Error('duplicate'))), next);
    finishNew(); await next;
});

test('retained pending keys are bounded even when a caller leaves requests hanging', async () => {
    const reads = new InFlightCatalogueReads(2);
    const never = () => new Promise<void>(() => undefined);
    const first = reads.run('one', never);
    reads.run('two', never); reads.run('three', never);
    assert.notEqual(reads.run('one', never), first);
});
