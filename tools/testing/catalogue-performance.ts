import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDatabase, getDatabasePath, initDatabase } from '../../libs/database/src/lib/connection';
import * as schema from '../../libs/database/src/lib/schema';
import { getContent, globalSearch } from '../../apps/electron-backend/src/app/database/operations/content.operations';

async function main(): Promise<void> {
    const profile = process.argv[2]
        ? resolve(process.argv[2])
        : mkdtempSync(join(tmpdir(), 'arm-nator-catalogue-performance-'));
    // A fixture marker prevents accidentally using an existing personal database.
    mkdirSync(profile, { recursive: true });
    const dbPath = join(profile, 'databases', 'arm-nator.db');
    const { existsSync } = await import('node:fs');
    if (existsSync(dbPath) && !existsSync(join(profile, 'catalogue-fixture.json'))) {
        throw new Error('Refusing to benchmark an unmarked existing database');
    }
    writeFileSync(join(profile, 'catalogue-fixture.json'), JSON.stringify({ items: 200_000, sources: 10 }));
    process.env.ARM_NATOR_E2E_DATA_DIR = profile;
    await initDatabase();
    closeDatabase();
    const client = new Database(getDatabasePath());
    client.pragma('journal_mode = WAL');
    client.pragma('foreign_keys = ON');
    const db = drizzle(client, { schema });
    const count = (client.prepare('SELECT count(*) AS count FROM content').get() as { count: number }).count;
    if (count !== 200_000) {
        if (count !== 0) throw new Error('Fixture has an unexpected item count');
        const source = client.prepare('INSERT INTO playlists (id,name,serverUrl,username,password,type,position) VALUES (?,?,?,?,?,?,?)');
        const category = client.prepare('INSERT INTO categories (playlist_id,name,type,xtream_id) VALUES (?,?,?,?)');
        const item = client.prepare('INSERT INTO content (category_id,title,genre,release_date,xtream_id,type) VALUES (?,?,?,?,?,?)');
        const start = performance.now();
        client.transaction(() => {
            for (let s = 0; s < 10; s++) {
                const playlistId = `performance-${s}`;
                source.run(playlistId, `Performance fixture ${s}`, 'http://127.0.0.1:9876', 'fixture', 'fixture', 'xtream', s);
                const catId = Number(category.run(playlistId, 'Movies', 'movies', 20).lastInsertRowid);
                const liveCat = Number(category.run(playlistId, 'Live', 'live', 10).lastInsertRowid);
                const seriesCat = Number(category.run(playlistId, 'Series', 'series', 30).lastInsertRowid);
                item.run(liveCat, `Fixture Live ${s}`, null, null, 1, 'live');
                item.run(seriesCat, 'Fixture Series (2020)', 'Drama', '2020', 1, 'series');
                for (let i = 0; i < 19_998; i++) {
                    const title = i % 1000 === 0 ? '|FHD| The Matrix (1999)' : `${i % 2 === 0 ? 'FR' : 'EN'} - Fixture Movie ${String(i).padStart(5, '0')} (${2000 + i % 26})`;
                    item.run(catId, title, i % 3 === 0 ? 'Action' : 'Drama', String(2000 + i % 26), i + 1, 'movie');
                }
            }
        })();
        writeFileSync(join(profile, 'catalogue-fixture.json'), JSON.stringify({ items: 200_000, sources: 10, seedMs: performance.now() - start }));
    }
    client.transaction(() => {
        const status = client.prepare('INSERT OR REPLACE INTO app_state(key,value) VALUES (?,?)');
        for (let source = 0; source < 10; source++) {
            for (const kind of ['live', 'movie', 'series']) status.run(`xtream-import-status:performance-${source}:${kind}`, 'completed');
        }
    })();
    // Populate realistic dashboard rails without depending on remote metadata.
    client.transaction(() => {
        const favorite = client.prepare('INSERT OR IGNORE INTO favorites(content_id,playlist_id) VALUES (?,?)');
        const recent = client.prepare('INSERT OR IGNORE INTO recently_viewed(content_id,playlist_id,viewed_at) VALUES (?,?,?)');
        const position = client.prepare('INSERT OR IGNORE INTO playback_positions(content_xtream_id,playlist_id,content_type,position_seconds,duration_seconds) VALUES (?,?,?,?,?)');
        const rows = client.prepare("SELECT c.id,c.xtream_id,cat.playlist_id FROM content c JOIN categories cat ON cat.id=c.category_id WHERE c.type='movie' AND c.xtream_id<=3").all() as { id: number; xtream_id: number; playlist_id: string }[];
        for (const row of rows) {
            favorite.run(row.id, row.playlist_id);
            if (row.xtream_id === 1) {
                recent.run(row.id, row.playlist_id, '2026-10-13 11:00:00');
                position.run(1, row.playlist_id, 'vod', 600, 3600);
            }
        }
        client.prepare("UPDATE content SET added='1791889200' WHERE xtream_id<=20 AND added IS NOT '1791889200'").run();
        client.prepare("UPDATE content SET release_date='1999' WHERE type='movie' AND xtream_id=1 AND release_date<>'1999'").run();
    })();
    const queries = ['Matrix', 'Fixture Movie', '2024', 'fr', 'zzzznomatch', 'Drama'];
    const search: { query: string; ms: number; count: number }[] = [];
    for (const query of queries) await globalSearch(db, query, ['movie']);
    for (let round = 0; round < 5; round++) {
        for (const query of queries) {
            const start = performance.now();
            const result = await globalSearch(db, query, ['movie']);
            search.push({ query, ms: performance.now() - start, count: result.length });
        }
    }
    const navigation: number[] = [];
    for (let i = 0; i < 10; i++) {
        const start = performance.now();
        const rows = await getContent(db, `performance-${i}`, 'movie');
        JSON.parse(JSON.stringify(rows));
        navigation.push(performance.now() - start);
    }
    const percentile = (values: number[], p: number) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    console.log(JSON.stringify({ profile, items: 200_000, sources: 10, warmSearchP95Ms: percentile(search.map(row => row.ms), .95), cachedDataNavigationP95Ms: percentile(navigation, .95), search, navigation, memory: process.memoryUsage(), note: 'Data/serialization baseline; renderer paint and app startup measured separately.' }, null, 2));
    client.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
