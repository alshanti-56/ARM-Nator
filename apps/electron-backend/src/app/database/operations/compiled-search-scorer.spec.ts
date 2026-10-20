import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchTextScorer } from './content-search.util';

test('a compiled query preserves scoring for accents, tags, short prefixes and multiword matches', () => {
    const titles = ['FR - Fixture Movie 00001 (2025)', '|FHD| Café society (2016)', 'US: A&E', 'The Matrix', 'Drama', '', 'Comedy 2025', 'Matrix Reloaded'];
    const expected: Record<string, Array<number | null>> = { 'fixture movie': [30,null,null,null,null,null,null,null], cafe: [null,20,null,null,null,null,null,null], 'a e': [null,null,40,null,null,null,null,null], fr: [10,null,null,null,null,null,null,null], matrix: [null,null,null,20,null,null,null,20], '2025 comedy': [null,null,null,null,null,null,30,null], '': [null,null,null,null,null,null,null,null], zzzz: [null,null,null,null,null,null,null,null] };
    for (const [query, scores] of Object.entries(expected)) {
        const score = createSearchTextScorer(query);
        titles.forEach((title, index) => assert.equal(score(title), scores[index], `${query}: ${title}`));
    }
});
