import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { closeDatabase, initDatabase } from '../../libs/database/src/lib/connection';
import * as schema from '../../libs/database/src/lib/schema';
import * as operations from '../../apps/electron-backend/src/app/database/operations/content.operations';

test('global search returns category names from title-index, FTS, and ORM fallback paths', async t => {
    const root = mkdtempSync(join(tmpdir(), 'arm-nator-global-search-category-'));
    process.env.ARM_NATOR_E2E_DATA_DIR = root;
    const db = await initDatabase();
    t.after(() => { closeDatabase(); rmSync(root, { recursive: true, force: true }); });

    db.insert(schema.playlists).values({ id: 'source', name: 'Source', type: 'xtream' }).run();
    const categories = db.insert(schema.categories).values([
        { playlistId: 'source', name: 'MULTI Movies', type: 'movies', xtreamId: 1 },
        { playlistId: 'source', name: 'MULTI FTS', type: 'movies', xtreamId: 2 },
        { playlistId: 'source', name: 'MULTI Fallback', type: 'movies', xtreamId: 3 },
    ]).returning().all();
    db.insert(schema.content).values([
        { categoryId: categories[0].id, title: 'Matrix Movie', xtreamId: 101, type: 'movie' },
        { categoryId: categories[1].id, title: 'Orbit Adventure', xtreamId: 102, type: 'movie' },
        { categoryId: categories[2].id, title: 'Fallback Feature', genre: 'Noir', xtreamId: 103, type: 'movie' },
    ]).run();

    const titleIndexResult = (await operations.globalSearch(db, 'Ma', ['movie']))
        .find(result => result.title === 'Matrix Movie');
    assert.equal(titleIndexResult?.category_name, 'MULTI Movies');

    const ftsResult = (await operations.globalSearch(db, 'Orbit', ['movie']))
        .find(result => result.title === 'Orbit Adventure');
    assert.equal(ftsResult?.category_name, 'MULTI FTS');

    db.run(sql`DROP TABLE content_search_fts`);
    const fallbackResult = (await operations.globalSearch(db, 'Noir', ['movie']))
        .find(result => result.title === 'Fallback Feature');
    assert.equal(fallbackResult?.category_name, 'MULTI Fallback');
});
