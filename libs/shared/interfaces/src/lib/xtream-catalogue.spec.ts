import assert from 'node:assert/strict';
import test from 'node:test';
import { requireXtreamCatalogueArray as requireArray } from './xtream-catalogue.interface';

test('strict catalogue responses reject objects and preserve valid empty arrays', () => {
    for (const value of [null, undefined, { user_info: { auth: 0 } }, '[]', { error: 'unauthorized' }]) {
        assert.throws(() => requireArray(value), /array response/);
    }
    const rows = [{ stream_id: 1 }];
    assert.equal(requireArray(rows), rows);
    assert.deepEqual(requireArray([]), []);
});
