import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCatalogueContent } from './serialized-catalogue';

const row = { id: 3, category_id: 1, xtream_id: 100, type: 'movie', title: 'Été العربية "movie"', rating: null, added: null, poster_url: null, genre: 'Drama', metadata_status: 'complete', direct_source: null };
test('serialized catalogue preserves IDs, ordering, Unicode, nulls and enrichment', () => {
    const rows = [row, { ...row, id: 9, xtream_id: 101, description: 'Enriched plot' }];
    assert.deepEqual(decodeCatalogueContent(JSON.stringify(rows), 'movie'), rows);
    assert.deepEqual(decodeCatalogueContent('[]', 'live'), []);
});

test('malformed transport and mismatched content kinds cannot populate the catalogue', () => {
    for (const value of ['{', '{}', '[null]', JSON.stringify([{ ...row, id: '3' }]), JSON.stringify([{ ...row, type: 'series' }])]) {
        assert.throws(() => decodeCatalogueContent(value, 'movie'));
    }
});
