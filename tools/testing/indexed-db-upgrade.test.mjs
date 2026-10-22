import assert from 'node:assert/strict';
import test from 'node:test';
import '@angular/compiler';
import { createEnvironmentInjector, importProvidersFrom, PLATFORM_ID } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { IDBFactory } from 'fake-indexeddb';
import { NgxIndexedDBModule, NgxIndexedDBService } from 'ngx-indexed-db';
import { firstValueFrom } from 'rxjs';
import { dbConfig, DbStores } from '../../libs/shared/interfaces/src/lib/indexed-db.config.ts';

function createIndexedDbInjector(indexedDB, databaseName) {
    return createEnvironmentInjector([
        importProvidersFrom(
            NgxIndexedDBModule.forRoot({ ...dbConfig, name: databaseName })
        ),
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: { defaultView: { indexedDB } } },
    ], null);
}

async function seedPreviousInstallDatabase(indexedDB, databaseName, playlist) {
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, dbConfig.version);
        request.onupgradeneeded = () => {
            const store = request.result.createObjectStore(DbStores.Playlists, {
                keyPath: '_id',
                autoIncrement: false,
            });
            store.createIndex('_id', '_id', { unique: false });
            store.createIndex('title', 'title', { unique: false });
            store.createIndex('favorites', 'favorites', { unique: false });
            store.createIndex('recentlyViewed', 'recentlyViewed', {
                unique: false,
            });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });

    await new Promise((resolve, reject) => {
        const transaction = database.transaction(
            DbStores.Playlists,
            'readwrite'
        );
        transaction.objectStore(DbStores.Playlists).put(playlist);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });
    database.close();
}

test('reopens a prior-install IndexedDB playlist with all favorite metadata intact', async (t) => {
    const indexedDB = new IDBFactory();
    const databaseName = 'arm-nator-upgrade-test';
    const playlist = {
        _id: 'playlist-1',
        title: 'Upgrade proof',
        favorites: [
            'channel-1',
            { id: 'vod-2', title: 'Saved movie', category_id: '7' },
        ],
        recentlyViewed: [{ id: 'vod-3', title: 'Recent movie' }],
    };
    await seedPreviousInstallDatabase(indexedDB, databaseName, playlist);

    const injectors = new Set();
    const makeInjector = () => {
        const injector = createIndexedDbInjector(indexedDB, databaseName);
        injectors.add(injector);
        return injector;
    };
    t.after(() => injectors.forEach((injector) => injector.destroy()));

    let injector = makeInjector();
    let db = injector.get(NgxIndexedDBService);
    assert.deepEqual(
        await firstValueFrom(db.getAll(DbStores.Playlists)),
        [playlist]
    );

    const updated = { ...playlist, title: 'Updated' };
    await firstValueFrom(db.update(DbStores.Playlists, updated));
    assert.deepEqual(
        await firstValueFrom(db.getByID(DbStores.Playlists, playlist._id)),
        updated
    );

    injector.destroy();
    injectors.delete(injector);
    injector = makeInjector();
    db = injector.get(NgxIndexedDBService);
    const reopenedPlaylist = await firstValueFrom(
        db.getByID(DbStores.Playlists, playlist._id)
    );
    assert.deepEqual(reopenedPlaylist, updated);
    assert.deepEqual(reopenedPlaylist.favorites, playlist.favorites);
    assert.deepEqual(reopenedPlaylist.recentlyViewed, playlist.recentlyViewed);

    await firstValueFrom(db.delete(DbStores.Playlists, playlist._id));
    assert.deepEqual(await firstValueFrom(db.getAll(DbStores.Playlists)), []);
});
