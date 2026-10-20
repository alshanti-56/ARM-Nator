import { eq, sql } from 'drizzle-orm';
import * as schema from '@arm-nator/database/schema';
import type { XtreamCatalogueKind, XtreamCatalogueSnapshot, XtreamCatalogueRefreshResult, XtreamCatalogueAccountIdentity } from '@arm-nator/shared/interfaces';
import type { AppDatabase } from '../database.types';
import { checkpointOperation, type OperationControl } from './operation-control';
import { toXtreamContentValue } from './content.operations';

let nextStageId = 0;
const generations = new WeakMap<AppDatabase, Map<string, number>>();
const kinds: XtreamCatalogueKind[] = ['live', 'movie', 'series'];
const categoryKind = (kind: XtreamCatalogueKind) => kind === 'movie' ? 'movies' : kind;

function providerId(value: unknown): number {
    if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value))) {
        throw new Error('Malformed catalogue: invalid provider identity');
    }
    const id = Number(value);
    if (!Number.isSafeInteger(id)) throw new Error('Malformed catalogue: invalid provider identity');
    return id;
}

/** Stage all kinds, then expose a complete snapshot in one synchronous transaction. */
export async function replaceXtreamCatalogue(
    db: AppDatabase,
    playlistId: string,
    snapshot: XtreamCatalogueSnapshot,
    control?: OperationControl,
    expectedAccount?: XtreamCatalogueAccountIdentity,
): Promise<XtreamCatalogueRefreshResult> {
    const versions = generations.get(db) ?? new Map<string, number>();
    generations.set(db, versions);
    const generation = (versions.get(playlistId) ?? 0) + 1;
    versions.set(playlistId, generation);
    const checkpoint = async () => {
        await checkpointOperation(control);
        if (versions.get(playlistId) !== generation) throw new Error('Catalogue refresh superseded');
    };
    await checkpoint();
    if (!db.select().from(schema.playlists).where(eq(schema.playlists.id, playlistId)).get()) {
        throw new Error('Catalogue playlist no longer exists');
    }
    const suffix = ++nextStageId;
    const cats = sql.raw(`catalogue_categories_${suffix}`);
    const rows = sql.raw(`catalogue_rows_${suffix}`);
    db.run(sql`CREATE TEMP TABLE ${cats} (type TEXT, xtream_id INTEGER, name TEXT, PRIMARY KEY(type,xtream_id))`);
    db.run(sql`CREATE TEMP TABLE ${rows} (type TEXT, xtream_id INTEGER, category_id INTEGER, payload TEXT, row_id INTEGER, PRIMARY KEY(type,xtream_id))`);
    try {
        let count = 0;
        for (const kind of kinds) {
            const part = snapshot?.[kind];
            if (!part || !Array.isArray(part.categories) || !Array.isArray(part.streams)) {
                throw new Error('Malformed catalogue: complete array responses are required');
            }
            const categoryMap = new Map<number, string>();
            for (const item of part.categories) {
                if (!item || typeof item.category_name !== 'string') throw new Error('Malformed catalogue category');
                const id = providerId(item.category_id);
                if (categoryMap.has(id) && categoryMap.get(id) !== item.category_name) throw new Error('Conflicting catalogue category identity');
                categoryMap.set(id, item.category_name);
            }
            const normalized: { id: number; categoryId: number; payload: string }[] = [];
            const seen = new Map<number, string>();
            for (const item of part.streams) {
                if (!item || typeof item !== 'object') throw new Error('Malformed catalogue item');
                const id = providerId(kind === 'series' ? item.series_id : item.stream_id);
                const catId = providerId(item.category_id ?? 0);
                if (!categoryMap.has(catId)) categoryMap.set(catId, catId === 0 ? 'Uncategorized' : `Category ${catId}`);
                const name = item.name ?? item.title;
                if (name != null && typeof name !== 'string') throw new Error('Malformed catalogue title');
                const value = toXtreamContentValue({ ...item, category_id: catId }, kind, new Map([[catId, catId + 1]]));
                if (!value) throw new Error('Malformed catalogue item');
                const payload = JSON.stringify(value);
                if (seen.has(id)) {
                    if (seen.get(id) !== payload) throw new Error('Conflicting catalogue item identity');
                    continue;
                }
                seen.set(id, payload);
                normalized.push({ id, categoryId: catId, payload });
                if (normalized.length % 500 === 0) await checkpoint();
            }
            for (const [id, name] of categoryMap) {
                db.run(sql`INSERT INTO ${cats} VALUES (${categoryKind(kind)},${id},${name})`);
            }
            for (let i = 0; i < normalized.length; i += 100) {
                await checkpoint();
                const batch = normalized.slice(i, i + 100);
                db.run(sql`INSERT INTO ${rows}(type,xtream_id,category_id,payload) VALUES ${sql.join(batch.map(item => sql`(${kind},${item.id},${item.categoryId},${item.payload})`), sql`, `)}`);
            }
            count += normalized.length;
        }
        await checkpoint();
        db.run(sql`UPDATE ${rows} SET row_id = (
            SELECT c.id FROM content c JOIN categories cat ON cat.id=c.category_id
            WHERE cat.playlist_id=${playlistId} AND c.type=${rows}.type AND c.xtream_id=${rows}.xtream_id
            ORDER BY (cat.xtream_id=${rows}.category_id) DESC,c.available DESC,c.id LIMIT 1
        )`);
        db.run(sql`CREATE INDEX ${sql.raw(`catalogue_row_ids_${suffix}`)} ON ${rows}(row_id)`);
        await checkpoint();
        return db.transaction(tx => {
            if (expectedAccount) {
                const current = tx.select().from(schema.playlists).where(eq(schema.playlists.id, playlistId)).get();
                if (!current || current.serverUrl !== expectedAccount.serverUrl || current.username !== expectedAccount.username || current.password !== expectedAccount.password) {
                    throw new Error('Catalogue refresh superseded by an account change');
                }
            }
            tx.run(sql`INSERT INTO categories(playlist_id,type,xtream_id,name,available)
                SELECT ${playlistId},type,xtream_id,name,1 FROM ${cats} WHERE 1
                ON CONFLICT(playlist_id,type,xtream_id) DO UPDATE SET name=excluded.name,available=1
                WHERE categories.name IS NOT excluded.name OR categories.available<>1`);
            tx.run(sql`UPDATE categories SET available=0 WHERE playlist_id=${playlistId} AND available=1
                AND NOT EXISTS(SELECT 1 FROM ${cats} s WHERE s.type=categories.type AND s.xtream_id=categories.xtream_id)`);
            const removed = tx.run(sql`UPDATE content SET available=0 WHERE available=1
                AND category_id IN(SELECT id FROM categories WHERE playlist_id=${playlistId})
                AND NOT EXISTS(SELECT 1 FROM ${rows} s WHERE s.row_id=content.id)`).changes;
            const inserted = (tx.get(sql`SELECT count(*) AS count FROM ${rows} WHERE row_id IS NULL`) as { count: number }).count;
            const metadata = ['rating','genre','releaseDate','country','director','cast','description','metadataStatus','added','posterUrl','directSource'] as const;
            const columns = ['rating','genre','release_date','country','director','cast','description','metadata_status','added','poster_url','direct_source'];
            const values = metadata.map((key, i) => key === 'directSource'
                ? sql`json_extract(s.payload,'$.directSource')`
                : sql`COALESCE(NULLIF(json_extract(s.payload,${`$.${key}`}),''),old.${sql.raw(columns[i])})`);
            const updated = tx.run(sql`INSERT INTO content(id,category_id,xtream_id,type,title,available,${sql.raw(columns.join(','))})
                SELECT s.row_id,cat.id,s.xtream_id,s.type,json_extract(s.payload,'$.title'),1,${sql.join(values,sql`, `)}
                FROM ${rows} s JOIN categories cat ON cat.playlist_id=${playlistId} AND cat.xtream_id=s.category_id AND cat.type=CASE s.type WHEN 'movie' THEN 'movies' ELSE s.type END
                LEFT JOIN content old ON old.id=s.row_id WHERE 1
                ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,title=excluded.title,available=1,
                    ${sql.raw(columns.map(column => `${column}=excluded.${column}`).join(','))}
                WHERE content.category_id IS NOT excluded.category_id OR content.title IS NOT excluded.title OR content.available<>1
                    OR ${sql.raw(columns.map(column => `content.${column} IS NOT excluded.${column}`).join(' OR '))}`).changes - inserted;
            for (const kind of kinds) {
                tx.insert(schema.appState).values({ key: `xtream-import-status:${playlistId}:${kind}`, value: 'completed' })
                    .onConflictDoUpdate({ target: schema.appState.key, set: { value: 'completed' } }).run();
            }
            tx.update(schema.playlists).set({ updateDate: Date.now(), count }).where(eq(schema.playlists.id, playlistId)).run();
            return { success: true as const, count, inserted, updated, removed };
        });
    } finally {
        db.run(sql`DROP TABLE IF EXISTS ${rows}`);
        db.run(sql`DROP TABLE IF EXISTS ${cats}`);
    }
}
