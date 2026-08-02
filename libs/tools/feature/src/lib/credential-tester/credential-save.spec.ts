import assert from 'node:assert/strict';
import test from 'node:test';
import type { Playlist } from '@arm-nator/shared/interfaces';
import {
    parseIptvCredentials,
    type BulkTestCandidate,
} from '@arm-nator/tools/core';
import {
    CREDENTIAL_SAVE_M3U_CONCURRENCY,
    resolveCredentialProviderList,
    saveCredentialSources,
} from './credential-save';

function candidate(id: string, type: 'm3u' | 'xtream' = 'm3u'): BulkTestCandidate {
    return {
        id,
        type,
        originalText: id,
        serverUrl: type === 'xtream' ? `https://${id}.test` : '',
        playlistUrl: type === 'm3u' ? `https://${id}.test/list.m3u` : '',
        username: type === 'xtream' ? 'user' : '',
        password: type === 'xtream' ? 'password' : '',
        normalizedKey: `${type}|${id}`,
    };
}

function playlist(id: string): Playlist {
    return {
        _id: id,
        title: id,
        count: 0,
        importDate: '',
        lastUsage: '',
        favorites: [],
        autoRefresh: false,
    };
}

test('limits M3U imports to three concurrent operations and persists after every import', async () => {
    let active = 0;
    let maxActive = 0;
    let importedBeforePersist = 0;
    const result = await saveCredentialSources(
        Array.from({ length: 8 }, (_, index) => candidate(String(index))),
        new Set(),
        {
            sourceKey: (value) => value.normalizedKey,
            createXtreamPlaylist: (value) => playlist(value.id),
            createM3uPlaylist: async (value) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise<void>((resolve) => setTimeout(resolve, 1));
                active -= 1;
                importedBeforePersist += 1;
                return playlist(value.id);
            },
            persist: async (playlists) => {
                assert.equal(importedBeforePersist, 8);
                assert.equal(playlists.length, 8);
            },
        }
    );

    assert.equal(maxActive, CREDENTIAL_SAVE_M3U_CONCURRENCY);
    assert.equal(result.imported.length, 8);
    assert.equal(result.persistenceFailed, false);
});

test('does not hydrate any imported rows when persistence fails', async () => {
    const result = await saveCredentialSources([candidate('one')], new Set(), {
        sourceKey: (value) => value.normalizedKey,
        createXtreamPlaylist: (value) => playlist(value.id),
        createM3uPlaylist: async (value) => playlist(value.id),
        persist: async () => {
            throw new Error('database unavailable');
        },
    });

    assert.equal(result.persistenceFailed, true);
    assert.deepEqual(result.imported, []);
});

test('reports pre-existing and failed imports independently', async () => {
    const result = await saveCredentialSources(
        [candidate('exists'), candidate('fails'), candidate('xtream', 'xtream')],
        new Set(['m3u|exists']),
        {
            sourceKey: (value) => value.normalizedKey,
            createXtreamPlaylist: (value) => playlist(value.id),
            createM3uPlaylist: async () => {
                throw new Error('bad playlist');
            },
            persist: async () => undefined,
        }
    );

    assert.equal(result.skippedExisting, 1);
    assert.equal(result.importFailures, 1);
    assert.equal(result.imported.length, 1);
});

test('provider list refresh includes newly saved sources', async () => {
    const existing = playlist('existing');
    const saved = playlist('saved');

    const providerList = await resolveCredentialProviderList(
        [saved],
        async () => [existing]
    );

    assert.deepEqual(
        providerList.map((item) => item._id),
        ['existing', 'saved']
    );
});

test('provider list refresh falls back to newly saved sources when reload fails', async () => {
    const saved = playlist('saved');

    const providerList = await resolveCredentialProviderList(
        [saved],
        async () => {
            throw new Error('provider list unavailable');
        }
    );

    assert.deepEqual(providerList, [saved]);
});

test('saves credential-bearing M3U-shaped URLs through the Xtream path', async () => {
    const parsed = parseIptvCredentials(
        'https://provider.test/get.php?username=user&password=secret&type=m3u_plus'
    );
    let xtreamCreates = 0;
    let m3uCreates = 0;

    const result = await saveCredentialSources(
        parsed.candidates,
        new Set(),
        {
            sourceKey: (value) => value.normalizedKey,
            createXtreamPlaylist: (value) => {
                xtreamCreates += 1;
                assert.equal(value.type, 'xtream');
                return playlist(value.id);
            },
            createM3uPlaylist: async (value) => {
                m3uCreates += 1;
                return playlist(value.id);
            },
            persist: async () => undefined,
        }
    );

    assert.equal(xtreamCreates, 1);
    assert.equal(m3uCreates, 0);
    assert.equal(result.imported.length, 1);
});
