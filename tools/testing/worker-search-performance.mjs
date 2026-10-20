import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const profile = resolve(process.argv[2]);
const marker = JSON.parse(readFileSync(join(profile, 'catalogue-fixture.json'), 'utf8'));
if (marker.items !== 200_000 || marker.sources !== 10) throw new Error('A marked performance fixture is required');
const worker = new Worker(resolve('dist/apps/electron-backend/workers/database.worker.js'), {
    env: { ...process.env, ARM_NATOR_E2E_DATA_DIR: profile },
});
const pending = new Map();
let id = 0;
const ready = new Promise((resolveReady, rejectReady) => {
    worker.on('message', message => {
        if (message.type === 'ready') resolveReady();
        if (message.type !== 'response') return;
        const request = pending.get(message.requestId);
        if (!request) return;
        pending.delete(message.requestId);
        clearTimeout(request.timeout);
        if (message.success) request.resolve(message.result);
        else request.reject(new Error(message.error?.message ?? 'Worker request failed'));
    });
    worker.on('error', error => { rejectReady(error); for (const request of pending.values()) request.reject(error); });
});
function request(operation, payload) {
    return new Promise((resolveResult, reject) => {
        const requestId = String(++id);
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`${operation} timed out`)); }, 15_000);
        pending.set(requestId, { resolve: resolveResult, reject, timeout });
        worker.postMessage({ type: 'request', requestId, operation, payload });
    });
}
const search = query => request('DB_GLOBAL_SEARCH', { searchTerm: query, types: ['movie'], excludeHidden: false, options: { limit: 101, offset: 0 } });
try {
    await ready;
    const queries = ['Matrix', 'Fixture Movie', '2024', 'fr', 'zzzznomatch', 'Drama'];
    const first = [], warm = [];
    for (const query of queries) {
        const start = performance.now();
        const rows = await search(query);
        first.push({ query, ms: performance.now() - start, count: rows.length });
    }
    for (let round = 0; round < 5; round++) for (const query of queries) {
        const start = performance.now();
        const rows = await search(query);
        warm.push({ query, ms: performance.now() - start, count: rows.length });
    }
    const catalogueTransport = [];
    if (process.argv.includes('--verify-transport')) {
        for (let source = 0; source < 10; source++) for (const type of ['live', 'movie', 'series']) {
            const payload = { playlistId: `performance-${source}`, type };
            const raw = await request('DB_GET_CONTENT', payload);
            const start = performance.now();
            const serialized = await request('DB_GET_CONTENT_SERIALIZED', payload);
            const decoded = JSON.parse(serialized);
            assert.deepEqual(decoded, raw, 'Serialized transport must preserve every catalogue field and row order');
            assert.equal(decoded.length, type === 'movie' ? 19_998 : 1);
            catalogueTransport.push({ ...payload, count: decoded.length, ms: performance.now() - start });
        }
    }
    if (process.argv.includes('--verify-invalidation')) {
        const probe = 'CacheInvalidationFixture';
        const row = await request('DB_GET_CONTENT_BY_XTREAM_ID', { playlistId: 'performance-0', xtreamId: 1, contentType: 'movie' });
        if (!row?.id || !row.genre) throw new Error('Fixture item missing its original genre');
        if ((await search(probe)).length) throw new Error('Unexpected existing probe genre');
        try {
            await request('DB_UPDATE_XTREAM_CONTENT_METADATA', { contentId: row.id, metadata: { genre: probe } });
            if (!(await search(probe)).some(result => result.id === row.id)) throw new Error('Catalogue mutation did not invalidate cached search');
        } finally {
            await request('DB_UPDATE_XTREAM_CONTENT_METADATA', { contentId: row.id, metadata: { genre: row.genre } });
        }
        if ((await search(probe)).length) throw new Error('Restored metadata left stale search results');
    }
    const sorted = warm.map(row => row.ms).sort((a,b) => a-b);
    console.log(JSON.stringify({ profile, first, warm, warmSearchP95Ms: sorted[Math.ceil(sorted.length * .95) - 1], invalidationVerified: process.argv.includes('--verify-invalidation'), catalogueTransport }, null, 2));
} finally {
    for (const request of pending.values()) clearTimeout(request.timeout);
    await worker.terminate();
}
