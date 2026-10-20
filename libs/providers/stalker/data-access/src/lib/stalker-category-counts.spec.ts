import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStalkerCategoryCounts } from './stalker-category-counts';

test('counts every loaded live channel, keeping opaque category IDs separate', () => {
    const result = buildStalkerCategoryCounts({
        type: 'itv', selectedCategory: '*', totalItems: 5, categories: [],
        items: [{ tv_genre_id: '01' }, { tv_genre_id: '01' }, { tv_genre_id: '1' }, { tv_genre_id: 'sports' }, { tv_genre_id: 'sports' }],
    });
    assert.deepEqual([...result.counts], [['01', 2], ['1', 1], ['sports', 2], ['*', 5]]);
    assert.equal(result.partialIds.size, 0);
});

test('paged catalogue counts are loaded lower bounds, not invented totals', () => {
    const result = buildStalkerCategoryCounts({
        type: 'vod', selectedCategory: '*', totalItems: 100, categories: [{ category_id: 'unknown' }],
        items: [{ category_id: 'movies' }, { category_id: 'movies' }, { genre_id: 'other' }],
    });
    assert.equal(result.counts.get('movies'), 2);
    assert.equal(result.counts.get('*'), 100);
    assert.deepEqual([...result.partialIds].sort(), ['movies', 'other']);
    assert.equal(result.counts.has('unknown'), false);
});

test('valid provider totals and selected-category totals override partial page counts', () => {
    const result = buildStalkerCategoryCounts({
        type: 'series', selectedCategory: 'shows', totalItems: 42,
        categories: [{ category_id: 'known', count: 17 }, { category_id: 'empty', count: 0 }, { category_id: 'missing', count: null }],
        items: [{ category_id: 'shows' }, { category_id: 'shows' }, { category_id: 'known' }],
    });
    assert.equal(result.counts.get('shows'), 42);
    assert.equal(result.counts.get('known'), 17);
    assert.equal(result.counts.get('empty'), 0);
    assert.equal(result.counts.has('missing'), false);
    assert.equal(result.partialIds.size, 0);
    assert.equal(result.counts.has('*'), false);
});

test('incomplete live fallback and missing page totals remain partial', () => {
    const live = buildStalkerCategoryCounts({ type: 'itv', selectedCategory: '*', totalItems: 300, categories: [], items: [{ tv_genre_id: '10' }, { tv_genre_id: '10' }] });
    assert.equal(live.counts.get('10'), 2);
    assert.equal(live.partialIds.has('10'), true);
    const vod = buildStalkerCategoryCounts({ type: 'vod', selectedCategory: '20', totalItems: 2, categories: [], items: [{ id: 'a' }, { id: 'b' }] });
    assert.equal(vod.counts.get('20'), 2);
    assert.equal(vod.partialIds.has('20'), true);
});

test('a selected-category provider total survives the store page-length fallback', () => {
    const result = buildStalkerCategoryCounts({ type: 'vod', selectedCategory: 'films', totalItems: 1,
        categories: [{ category_id: 'films', count: 75 }], items: [{ category_id: 'films' }] });
    assert.equal(result.counts.get('films'), 75);
    assert.equal(result.partialIds.has('films'), false);
});
