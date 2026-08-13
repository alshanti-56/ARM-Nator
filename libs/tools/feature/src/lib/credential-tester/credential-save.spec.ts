import assert from 'node:assert/strict';
import test from 'node:test';
import type { Playlist } from '@arm-nator/shared/interfaces';
import type { BulkTestCandidate } from '@arm-nator/tools/core';
import {
    resolveCredentialProviderList,
    saveCredentialSources,
} from './credential-save';

function candidate(id: string): BulkTestCandidate {
    return {
        id,
        type: 'xtream',
        originalText: id,
        serverUrl: `https://${id}.test`,
        username: 'user',
        password: 'password',
        normalizedKey: `xtream|${id}`,
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

test('imports Xtream candidates and persists the batch', async () => {
    const result = await saveCredentialSources(
        Array.from({ length: 8 }, (_, index) => candidate(String(index))),
        new Set(),
        {
            sourceKey: (value) => value.normalizedKey,
            createXtreamPlaylist: (value) => playlist(value.id),
            persist: async (playlists) => {
                assert.equal(playlists.length, 8);
            },
        }
    );

    assert.equal(result.imported.length, 8);
    assert.equal(result.persistenceFailed, false);
});

test('does not hydrate any imported rows when persistence fails', async () => {
    const result = await saveCredentialSources([candidate('one')], new Set(), {
        sourceKey: (value) => value.normalizedKey,
        createXtreamPlaylist: (value) => playlist(value.id),
        persist: async () => {
            throw new Error('database unavailable');
        },
    });

    assert.equal(result.persistenceFailed, true);
    assert.deepEqual(result.imported, []);
});

test('reports pre-existing and failed imports independently', async () => {
    const result = await saveCredentialSources(
        [candidate('exists'), candidate('fails'), candidate('xtream')],
        new Set(['xtream|exists']),
        {
            sourceKey: (value) => value.normalizedKey,
            createXtreamPlaylist: (value) => {
                if (value.id === 'fails') {
                    throw new Error('bad playlist');
                }
                return playlist(value.id);
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

test('saves credential-bearing Xtream URLs through the Xtream path', async () => {
    const parsed = {
        candidates: [
            {
                ...candidate('provider'),
                serverUrl: 'https://provider.test',
                username: 'user',
                password: 'secret',
            },
        ],
    };
    let xtreamCreates = 0;

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
            persist: async () => undefined,
        }
    );

    assert.equal(xtreamCreates, 1);
    assert.equal(result.imported.length, 1);
});
