import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CatalogueNavigationMemory, readCatalogueRefinements, resolveCatalogueOrigin } from './catalogue-navigation-state';

const state = { scrollTop: 420, limit: 50, sortMode: 'name-asc' as const, minRating: 7, genreFilter: 'Drama', yearFilter: 2024 };
test('list snapshots isolate routes and retain independent filters and offsets within a bounded cache', () => {
    const memory = new CatalogueNavigationMemory(2);
    memory.save('/a?page=2', state);
    memory.save('/b', { ...state, scrollTop: 50 });
    const returned = memory.read('/a?page=2')!;
    returned.scrollTop = 999;
    memory.save('/c', state);
    assert.equal(memory.read('/a?page=2')?.scrollTop, 420);
    assert.equal(memory.read('/b'), null);
    assert.equal(memory.read('/a?page=3'), null);
});
test('detail back targets preserve the originating all-items/category URL and reject other sources and detail routes', () => {
    assert.equal(resolveCatalogueOrigin({ catalogueOrigin: '/workspace/xtreams/source/vod?q=Matrix&page=3' }, 'source', 'vod'), '/workspace/xtreams/source/vod?q=Matrix&page=3');
    assert.equal(resolveCatalogueOrigin({ catalogueOrigin: '/workspace/xtreams/source/series/24?page=2' }, 'source', 'series'), '/workspace/xtreams/source/series/24?page=2');
    for (const origin of ['https://example.invalid', '/workspace/xtreams/other/vod', '/workspace/xtreams/source/vod/24/5', '/workspace/xtreams/source/series', '/workspace/xtreams/source/vod/../search']) assert.equal(resolveCatalogueOrigin({ catalogueOrigin: origin }, 'source', 'vod'), null);
});
test('URL refinements restore valid state and reject malformed limits, sort modes and numeric filters', () => {
    assert.deepEqual(readCatalogueRefinements(new URLSearchParams('limit=50&sort=name-asc&rating=7&genre=Drama&year=2024'), { ...state, limit: 25 }), { limit: 50, sortMode: 'name-asc', minRating: 7, genreFilter: 'Drama', yearFilter: 2024 });
    assert.deepEqual(readCatalogueRefinements(new URLSearchParams('limit=-2&sort=garbage&rating=999&year=NaN'), state), { limit: 50, sortMode: 'name-asc', minRating: null, genreFilter: 'Drama', yearFilter: null });
});
