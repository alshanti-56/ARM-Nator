import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, initDatabase } from '../../libs/database/src/lib/connection';
import * as schema from '../../libs/database/src/lib/schema';
import * as operations from '../../apps/electron-backend/src/app/database/operations/content.operations';
import type { AppDatabase } from '../../apps/electron-backend/src/app/database/database.types';

type Snapshot = Record<'live' | 'movie' | 'series', { categories: Record<string, unknown>[]; streams: Record<string, unknown>[] }>;
type Replace = (db: AppDatabase, playlistId: string, snapshot: Snapshot, control?: { checkpoint?: () => void | Promise<void> }) => Promise<unknown>;
function replace(): Replace {
    const value = (operations as unknown as Record<string, unknown>)['replaceXtreamCatalogue'];
    assert.equal(typeof value, 'function', 'refresh must expose atomic catalogue replacement');
    return value as Replace;
}
function snapshot(title = 'Updated'): Snapshot {
    return { live: { categories: [], streams: [] }, movie: {
        categories: [{ category_id: 7, category_name: 'Renamed' }, { category_id: 8, category_name: 'New' }],
        streams: [{ stream_id: 101, category_id: 8, name: title }, { stream_id: 103, category_id: 7, name: 'Added' }],
    }, series: { categories: [], streams: [] } };
}
async function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'arm-nator-refresh-'));
    process.env.ARM_NATOR_E2E_DATA_DIR = root;
    const db = await initDatabase();
    t.after(() => { closeDatabase(); rmSync(root, { recursive: true, force: true }); });
    db.insert(schema.playlists).values([{ id: 'one', name: 'One', type: 'xtream' }, { id: 'two', name: 'Two', type: 'xtream' }]).run();
    const category = db.insert(schema.categories).values({ playlistId: 'one', name: 'Old', type: 'movies', xtreamId: 7, hidden: true }).returning().get();
    const other = db.insert(schema.categories).values({ playlistId: 'two', name: 'Other', type: 'movies', xtreamId: 7 }).returning().get();
    const row = db.insert(schema.content).values({ categoryId: category.id, title: 'Old', xtreamId: 101, type: 'movie', description: 'Enriched plot' }).returning().get();
    const removed = db.insert(schema.content).values({ categoryId: category.id, title: 'Removed', xtreamId: 102, type: 'movie' }).returning().get();
    db.insert(schema.content).values({ categoryId: other.id, title: 'Untouched', xtreamId: 101, type: 'movie' }).run();
    db.insert(schema.favorites).values([{ playlistId: 'one', contentId: row.id }, { playlistId: 'one', contentId: removed.id }]).run();
    db.insert(schema.recentlyViewed).values({ playlistId: 'one', contentId: row.id }).run();
    db.insert(schema.playbackPositions).values({ playlistId: 'one', contentXtreamId: 101, contentType: 'vod', positionSeconds: 123 }).run();
    return { db, category, row, removed };
}

test('refresh retains row identity, enrichment and user state while moving an item between categories', async t => {
    const { db, category, row } = await fixture(t);
    await replace()(db, 'one', snapshot());
    const retained = db.select().from(schema.content).where(eq(schema.content.id, row.id)).get();
    assert.equal(retained?.title, 'Updated');
    assert.equal(retained?.description, 'Enriched plot');
    assert.notEqual(retained?.categoryId, category.id);
    assert.equal(db.select().from(schema.categories).where(eq(schema.categories.id, category.id)).get()?.hidden, true);
    assert.equal(db.select().from(schema.favorites).all().length, 2);
    assert.equal(db.select().from(schema.recentlyViewed).get()?.contentId, row.id);
    assert.equal(db.select().from(schema.playbackPositions).get()?.positionSeconds, 123);
    assert.deepEqual((await operations.getContent(db, 'two', 'movie')).map(item => item.title), ['Untouched']);
    assert.deepEqual((await operations.getContent(db, 'one', 'movie')).map(item => item.xtream_id).sort(), [101, 103]);
});

test('malformed or incomplete snapshots cannot remove cached content', async t => {
    const { db } = await fixture(t);
    const bad = snapshot(); bad.movie.streams[0].stream_id = 'invalid';
    await assert.rejects(() => replace()(db, 'one', bad));
    await assert.rejects(() => replace()(db, 'one', { movie: bad.movie } as Snapshot));
    assert.deepEqual((await operations.getContent(db, 'one', 'movie')).map(item => item.title).sort(), ['Old', 'Removed']);
});

test('cancelled staging leaves cached data and favorites unchanged', async t => {
    const { db } = await fixture(t);
    await assert.rejects(() => replace()(db, 'one', snapshot(), { checkpoint: () => { throw new Error('cancelled'); } }), /cancelled/);
    assert.equal((await operations.getContent(db, 'one', 'movie')).length, 2);
    assert.equal(db.select().from(schema.favorites).all().length, 2);
});

test('a transaction failure rolls back updates and removals', async t => {
    const { db, row } = await fixture(t);
    db.run(sql`CREATE TRIGGER reject_refresh BEFORE INSERT ON content WHEN NEW.title = 'Added' BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END`);
    await assert.rejects(() => replace()(db, 'one', snapshot()), error => {
        assert.match(String((error as Error & { cause?: Error }).cause?.message), /fixture rejection/);
        return true;
    });
    assert.equal(db.select().from(schema.content).where(eq(schema.content.id, row.id)).get()?.title, 'Old');
    assert.equal((await operations.getContent(db, 'one', 'movie')).length, 2);
});

test('validated empty catalogues hide removed items without destroying favorites and restore them when they return', async t => {
    const { db, row } = await fixture(t);
    await replace()(db, 'one', { live: { categories: [], streams: [] }, movie: { categories: [], streams: [] }, series: { categories: [], streams: [] } });
    assert.equal((await operations.getContent(db, 'one', 'movie')).length, 0);
    assert.equal((await operations.globalSearch(db, 'Old', ['movie'])).length, 0);
    assert.equal(db.select().from(schema.favorites).all().length, 2);
    await replace()(db, 'one', snapshot());
    assert.equal(db.select().from(schema.content).where(eq(schema.content.id, row.id)).get()?.title, 'Updated');
    assert.equal(db.select().from(schema.favorites).all().length, 2);
});

test('an older overlapping refresh cannot overwrite the newer committed catalogue', async t => {
    const { db } = await fixture(t);
    let release!: () => void;
    let signalStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let held = false;
    const old = replace()(db, 'one', snapshot('Older'), { checkpoint: async () => { if (!held) { held = true; signalStarted(); await gate; } } });
    const failure = assert.rejects(old, /superseded/i);
    await started;
    await replace()(db, 'one', snapshot('Newer'));
    release(); await failure;
    assert.equal((await operations.getContent(db, 'one', 'movie')).find(item => item.xtream_id === 101)?.title, 'Newer');
});

test('legacy duplicate provider IDs in different categories retain their referenced rows', async t => {
    const { db, row } = await fixture(t);
    const category = db.insert(schema.categories).values({ playlistId: 'one', name: 'Target', type: 'movies', xtreamId: 8 }).returning().get();
    const duplicate = db.insert(schema.content).values({ categoryId: category.id, title: 'Duplicate', xtreamId: 101, type: 'movie' }).returning().get();
    db.insert(schema.favorites).values({ playlistId: 'one', contentId: duplicate.id }).run();
    await replace()(db, 'one', snapshot());
    assert.equal(db.select().from(schema.content).where(eq(schema.content.id, duplicate.id)).get()?.title, 'Updated');
    assert.ok(db.select().from(schema.content).where(eq(schema.content.id, row.id)).get());
    assert.equal(db.select().from(schema.favorites).all().length, 3);
    assert.equal((await operations.getContent(db, 'one', 'movie')).filter(item => item.xtream_id === 101).length, 1);
});

test('changing stored account credentials prevents a stale snapshot commit', async t => {
    const { db } = await fixture(t);
    db.update(schema.playlists).set({ serverUrl: 'http://new-account', username: 'new', password: 'new' }).where(eq(schema.playlists.id, 'one')).run();
    await assert.rejects(() => operations.replaceXtreamCatalogue(db, 'one', snapshot(), undefined, { serverUrl: 'http://old-account', username: 'old', password: 'old' }), /account change/);
    assert.deepEqual((await operations.getContent(db, 'one', 'movie')).map(item => item.title).sort(), ['Old', 'Removed']);
});

test('missing provider categories are synthesized; conflicting duplicate items reject the entire snapshot', async t => {
    const { db } = await fixture(t);
    const incoming = snapshot(); incoming.movie.categories = [];
    await replace()(db, 'one', incoming);
    assert.equal((await operations.getContent(db, 'one', 'movie')).length, 2);
    incoming.movie.streams.push({ ...incoming.movie.streams[0], name: 'Conflicting name' });
    await assert.rejects(() => replace()(db, 'one', incoming), /Conflicting/);
    assert.equal((await operations.getContent(db, 'one', 'movie')).length, 2);
});

test('refresh clears a removed provider playback URL instead of preserving an obsolete endpoint', async t => {
    const { db } = await fixture(t);
    const incoming = snapshot();
    incoming.live = { categories: [{ category_id: 10, category_name: 'Live' }], streams: [{ stream_id: 99, category_id: 10, name: 'Channel', direct_source: 'https://old-cdn.example/token' }] };
    await replace()(db, 'one', incoming);
    assert.equal((await operations.getContent(db, 'one', 'live'))[0].direct_source, 'https://old-cdn.example/token');
    incoming.live.streams[0].direct_source = '';
    await replace()(db, 'one', incoming);
    assert.equal((await operations.getContent(db, 'one', 'live'))[0].direct_source, null);
});
