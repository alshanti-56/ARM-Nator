import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogueIdentityKey, xtreamItemIdentity, worksMatch, transferablePosition, isPlaybackFinished } from './viewing-continuity';

test('provider identities preserve string portal IDs and cannot collide through separators', () => {
    assert.notEqual(catalogueIdentityKey({ sourceType: 'stalker', playlistId: 'a:b', contentKind: 'vod', providerItemId: 'c' }), catalogueIdentityKey({ sourceType: 'stalker', playlistId: 'a', contentKind: 'vod', providerItemId: 'b:c' }));
    assert.equal(JSON.parse(catalogueIdentityKey({ sourceType: 'stalker', playlistId: 'one', contentKind: 'vod', providerItemId: '0007-A' }))[3], '0007-A');
    assert.deepEqual(xtreamItemIdentity('one', 'episode', 7), { sourceType: 'xtream', playlistId: 'one', contentKind: 'episode', providerItemId: '7' });
    assert.throws(() => xtreamItemIdentity('one', 'vod', NaN));
});

test('matching requires trusted identity or an exact normalized title and known equal year', () => {
    const matrix = { kind: 'movie' as const, title: '|FHD| The Matrix (1999)', releaseYear: 1999 };
    assert.equal(worksMatch(matrix, { ...matrix, title: 'EN - The Matrix (1999)' }), true);
    assert.equal(worksMatch(matrix, { ...matrix, releaseYear: 2026 }), false);
    assert.equal(worksMatch(matrix, { ...matrix, releaseYear: undefined }), false);
    assert.equal(worksMatch({ ...matrix, trustedIds: { tmdb: '603' } }, { ...matrix, trustedIds: { tmdb: '604' } }), false);
    assert.equal(worksMatch({ ...matrix, trustedIds: { tmdb: '603', imdb: 'tt0133093' } }, { ...matrix, trustedIds: { tmdb: '603', imdb: 'tt0000001' } }), false);
    assert.equal(worksMatch({ ...matrix, trustedIds: { tmdb: '603' } }, { kind: 'movie', title: 'Different localized title', trustedIds: { tmdb: '603' } }), true);
    assert.equal(worksMatch({ kind: 'movie', title: 'Rocky II', releaseYear: 1979 }, { kind: 'movie', title: 'Rocky III', releaseYear: 1979 }), false);
    assert.equal(worksMatch({ kind: 'movie', title: 'Blade Runner 2049', releaseYear: 2017 }, { kind: 'movie', title: 'Blade Runner', releaseYear: 2017 }), false);
});

test('episode continuity requires exact series identity, season and episode', () => {
    const first = { kind: 'episode' as const, title: 'Episode title', series: { kind: 'series' as const, title: 'The Show', releaseYear: 2024 }, seasonNumber: 1, episodeNumber: 2 };
    assert.equal(worksMatch(first, { ...first, title: 'Localized episode title' }), true);
    assert.equal(worksMatch(first, { ...first, episodeNumber: 3 }), false);
    assert.equal(worksMatch(first, { ...first, seasonNumber: undefined }), false);
    assert.equal(worksMatch(first, { ...first, series: { ...first.series, releaseYear: 2025 } }), false);
});

test('duration transfers use watched fraction and the inclusive 30 second / one percent tolerance', () => {
    assert.equal(transferablePosition(600, 1200, 1230), 615);
    assert.equal(transferablePosition(600, 1200, 1230.001), null);
    assert.equal(transferablePosition(5000, 10000, 10100), 5050);
    assert.equal(transferablePosition(5000, 10000, 10102), null);
    assert.equal(transferablePosition(600, 0, 1230), null);
    assert.equal(transferablePosition(NaN, 1200, 1200), null);
});

test('finished is based on the unrounded ratio against actual duration', () => {
    assert.equal(isPlaybackFinished(949, 1000), false);
    assert.equal(isPlaybackFinished(950, 1000), true);
    assert.equal(isPlaybackFinished(95, 100), true);
    assert.equal(isPlaybackFinished(0, 0), false);
    assert.equal(isPlaybackFinished(95, Infinity), false);
    assert.equal(isPlaybackFinished(-1, 100), false);
});
