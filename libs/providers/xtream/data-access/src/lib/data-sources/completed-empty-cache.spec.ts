import '@angular/compiler';
import { restoreNodeTestEnvironment } from '@arm-nator/providers/shared/util/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { DatabaseService, PlaybackPositionService, XtreamPendingRestoreService } from '@arm-nator/services';
import { XtreamApiService } from '../services/xtream-api.service';
import { ElectronXtreamDataSource } from './electron-xtream-data-source';
import { signalStore, withState } from '@ngrx/signals';
import { XTREAM_DATA_SOURCE } from './xtream-data-source.interface';
import { withContent } from '../stores/features/with-content.feature';

const account = { serverUrl: 'http://fixture.example', username: 'fixture', password: 'fixture' };

test('a completed empty catalogue remains a valid cache and makes no provider requests', async t => {
    t.after(restoreNodeTestEnvironment);
    const injector = createEnvironmentInjector([
        { provide: DatabaseService, useValue: { getXtreamImportStatus: async () => 'completed', getXtreamCategories: async () => [], getXtreamContent: async () => [] } },
        { provide: PlaybackPositionService, useValue: {} },
        { provide: XtreamPendingRestoreService, useValue: {} },
        { provide: XtreamApiService, useValue: { getCategories: async () => { throw new Error('unexpected provider request'); }, getStreams: async () => { throw new Error('unexpected provider request'); } } },
    ]);
    t.after(() => injector.destroy());
    const source = runInInjectionContext(injector, () => new ElectronXtreamDataSource());
    assert.deepEqual(await source.getCategories('fixture', account, 'live'), []);
    assert.deepEqual(await source.getContent('fixture', account, 'live'), []);
});

test('completed empty kinds are usable offline while an unfinished empty import is not', async t => {
    let status = 'completed';
    const injector = createEnvironmentInjector([
        { provide: DatabaseService, useValue: { getXtreamImportStatus: async () => status } },
        { provide: XtreamPendingRestoreService, useValue: {} },
        { provide: XtreamApiService, useValue: {} },
        { provide: XTREAM_DATA_SOURCE, useValue: { hasCategories: async () => false, hasContent: async () => false } },
    ]);
    t.after(() => injector.destroy());
    const Store = signalStore(withState({ playlistId: 'fixture', currentPlaylist: { id: 'fixture', ...account } }), withContent());
    const store = runInInjectionContext(injector, () => new Store());
    assert.equal(await store.hasUsableOfflineCache('live'), true);
    assert.equal(await store.hasUsableOfflineCache('search'), true);
    status = 'pending';
    assert.equal(await store.hasUsableOfflineCache('live'), false);
});
