import '@angular/compiler';
import { restoreNodeTestEnvironment } from '@arm-nator/providers/shared/util/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { signalStore, withState } from '@ngrx/signals';
import { XTREAM_DATA_SOURCE } from '../../data-sources/xtream-data-source.interface';
import { withSearch } from './with-search.feature';

test('typing a new query invalidates old results before the next debounced request begins', async t => {
    t.after(restoreNodeTestEnvironment);
    let resolveOld!: (value: unknown[]) => void;
    const old = new Promise<unknown[]>(resolve => { resolveOld = resolve; });
    const injector = createEnvironmentInjector([{ provide: XTREAM_DATA_SOURCE, useValue: {
        searchContent: async (_id: string, query: string) => query === 'old' ? old : [{ title: 'new result', xtream_id: 2, type: 'movie' }],
    } }]);
    t.after(() => injector.destroy());
    const Store = signalStore(withState({ playlistId: 'one' }), withSearch());
    const store = runInInjectionContext(injector, () => new Store());
    store.setSearchTerm('old');
    const pending = store.searchContent('old', ['movie']);
    store.setSearchTerm('new');
    resolveOld([{ title: 'stale result', xtream_id: 1, type: 'movie' }]);
    await pending;
    assert.deepEqual(store.searchResults(), []);
    await store.searchContent('new', ['movie']);
    assert.equal(store.searchResults()[0].title, 'new result');
});
