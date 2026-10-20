import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateStalkerCategoryVisibility } from './stalker-category-visibility';

test('visibility keeps opaque IDs, other sections and unavailable categories', () => {
    const before = { itv: ['01', 'retired'], vod: ['movies'] };
    assert.deepEqual(updateStalkerCategoryVisibility(before, 'itv', ['01', '1', '*'], ['1', '*']), {
        itv: ['retired', '1'], vod: ['movies'],
    });
    assert.deepEqual(before, { itv: ['01', 'retired'], vod: ['movies'] });
});

test('selecting all restores loaded categories without clearing other sections', () => {
    assert.deepEqual(updateStalkerCategoryVisibility({ vod: ['a'], series: ['a'] }, 'vod', ['a'], []), {
        vod: [], series: ['a'],
    });
});

test('cannot hide synthetic All or IDs outside the dialog snapshot', () => {
    assert.deepEqual(updateStalkerCategoryVisibility(undefined, 'series', ['episode-group'], ['*', 'unknown', 'episode-group', 'episode-group']), {
        series: ['episode-group'],
    });
});
