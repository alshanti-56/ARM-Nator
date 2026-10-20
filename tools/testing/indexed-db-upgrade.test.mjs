import assert from 'node:assert/strict';
import test from 'node:test';
import '@angular/compiler';
import { createEnvironmentInjector, importProvidersFrom, PLATFORM_ID } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { IDBFactory } from 'fake-indexeddb';
import { NgxIndexedDBModule, NgxIndexedDBService } from 'ngx-indexed-db';
import { firstValueFrom } from 'rxjs';
import { dbConfig, DbStores } from '../../libs/shared/interfaces/src/lib/indexed-db.config.ts';

test('Angular can inject the upgraded IndexedDB service and preserve playlist CRUD', async (t) => {
    const indexedDB = new IDBFactory();
    const injector = createEnvironmentInjector([
        importProvidersFrom(NgxIndexedDBModule.forRoot({ ...dbConfig, name: 'arm-nator-upgrade-test' })),
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: { defaultView: { indexedDB } } },
    ], null);
    t.after(() => injector.destroy());

    const db = injector.get(NgxIndexedDBService);
    const playlist = { _id: 'playlist-1', title: 'Upgrade proof', favorites: ['channel-1'] };
    await firstValueFrom(db.add(DbStores.Playlists, playlist));
    assert.deepEqual(await firstValueFrom(db.getAll(DbStores.Playlists)), [playlist]);

    const updated = { ...playlist, title: 'Updated' };
    await firstValueFrom(db.update(DbStores.Playlists, updated));
    assert.deepEqual(await firstValueFrom(db.getByID(DbStores.Playlists, playlist._id)), updated);

    await firstValueFrom(db.delete(DbStores.Playlists, playlist._id));
    assert.deepEqual(await firstValueFrom(db.getAll(DbStores.Playlists)), []);
});
