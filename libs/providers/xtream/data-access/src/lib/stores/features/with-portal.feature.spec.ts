import '@angular/compiler';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { signalStore } from '@ngrx/signals';
import { XTREAM_DATA_SOURCE } from '../../data-sources/xtream-data-source.interface';
import { XtreamApiService } from '../../services/xtream-api.service';
import { withPortal } from './with-portal.feature';

function createStore(getAccountInfo: (credentials: unknown) => Promise<unknown>) {
    const injector = createEnvironmentInjector([
        {
            provide: XtreamApiService,
            useValue: { getAccountInfo },
        },
        { provide: XTREAM_DATA_SOURCE, useValue: {} },
    ]);
    const Store = signalStore(withPortal());
    return runInInjectionContext(injector, () => new Store());
}

function playlist(id: string, serverUrl: string) {
    return {
        id,
        name: id,
        serverUrl,
        username: `user-${id}`,
        password: `pass-${id}`,
        type: 'xtream',
        playbackServerUrl: 'https://stale-media.example',
    };
}

test('checks the configured API server and stores authenticated playback metadata', async () => {
    let observedCredentials: unknown;
    const store = createStore(async (credentials) => {
        observedCredentials = credentials;
        return {
            user_info: {
                auth: 1,
                status: 'Active',
                allowed_output_formats: ['m3u8'],
            },
            server_info: {
                url: '100main.cc',
                server_protocol: 'http',
                port: '80',
            },
        };
    });
    store.setPlaylistId('account-1');
    store.setCurrentPlaylist(playlist('account-1', 'https://api.example'));

    assert.equal(await store.checkPortalStatus(), 'active');
    assert.deepEqual(observedCredentials, {
        serverUrl: 'https://api.example',
        username: 'user-account-1',
        password: 'pass-account-1',
    });
    assert.equal(store.currentPlaylist()?.playbackServerUrl, 'http://100main.cc:80');
    assert.deepEqual(store.currentPlaylist()?.allowedOutputFormats, ['m3u8']);
});

test('does not apply a delayed account response after the selected account changes', async () => {
    let resolveAccountInfo!: (response: unknown) => void;
    const store = createStore(
        () => new Promise((resolve) => (resolveAccountInfo = resolve))
    );
    store.setPlaylistId('account-1');
    store.setCurrentPlaylist(playlist('account-1', 'https://api-one.example'));

    const pending = store.checkPortalStatus();
    store.setPlaylistId('account-2');
    store.setCurrentPlaylist(playlist('account-2', 'https://api-two.example'));
    resolveAccountInfo({
        user_info: { auth: 1, status: 'Active' },
        server_info: {
            url: 'old-media.example',
            server_protocol: 'https',
            port: '443',
        },
    });

    await pending;
    assert.equal(store.currentPlaylist()?.id, 'account-2');
    assert.equal(store.currentPlaylist()?.playbackServerUrl, 'https://stale-media.example');
    assert.equal(store.portalStatus(), 'unavailable');
});

test('guards every account identity field and clears stale media metadata when missing', async () => {
    let resolveAccountInfo!: (response: unknown) => void;
    const store = createStore(
        () => new Promise((resolve) => (resolveAccountInfo = resolve))
    );
    store.setPlaylistId('account-1');
    store.setCurrentPlaylist(playlist('account-1', 'https://api-one.example'));

    const pending = store.checkPortalStatus();
    store.setCurrentPlaylist({
        ...playlist('account-1', 'https://api-changed.example'),
        username: 'new-user',
        password: 'new-password',
    });
    resolveAccountInfo({
        user_info: { auth: 1, status: 'Active' },
        server_info: {
            url: 'old-media.example',
            server_protocol: 'https',
            port: '443',
        },
    });

    await pending;
    assert.equal(store.currentPlaylist()?.serverUrl, 'https://api-changed.example');
    assert.equal(store.currentPlaylist()?.playbackServerUrl, 'https://stale-media.example');
    assert.equal(store.portalStatus(), 'unavailable');
});

test('clears a prior playback endpoint when an authenticated response omits valid metadata', async () => {
    const store = createStore(async () => ({
        user_info: { auth: 1, status: 'Active' },
    }));
    store.setPlaylistId('account-1');
    store.setCurrentPlaylist(playlist('account-1', 'https://api-one.example'));

    assert.equal(await store.checkPortalStatus(), 'active');
    assert.equal(store.currentPlaylist()?.playbackServerUrl, undefined);
});

test('does not apply a response when its caller has moved to another item', async () => {
    let resolveAccountInfo!: (response: unknown) => void;
    const store = createStore(
        () => new Promise((resolve) => (resolveAccountInfo = resolve))
    );
    store.setPlaylistId('account-1');
    store.setCurrentPlaylist(playlist('account-1', 'https://api-one.example'));

    const pending = store.checkPortalStatus(() => false);
    resolveAccountInfo({
        user_info: { auth: 1, status: 'Active' },
        server_info: {
            url: 'new-media.example',
            server_protocol: 'https',
            port: '443',
        },
    });

    await pending;
    assert.equal(store.currentPlaylist()?.playbackServerUrl, 'https://stale-media.example');
    assert.equal(store.portalStatus(), 'unavailable');
});
