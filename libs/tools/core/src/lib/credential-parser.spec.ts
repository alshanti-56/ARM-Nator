import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIptvCredentials } from './credential-parser';

test('normalizes Xtream hosts and reports duplicates without losing credentials', () => {
    const parsed = parseIptvCredentials(
        [
            'HTTPS://Example.TEST:443 user password',
            'https://example.test user password',
            'https://example.test user another-password',
        ].join('\n')
    );

    assert.equal(parsed.candidates.length, 2);
    assert.equal(parsed.duplicates.length, 1);
    assert.equal(parsed.candidates[0].type, 'xtream');
    assert.equal(parsed.candidates[0].serverUrl, 'https://example.test');
});

test('keeps M3U path and query case while normalizing only URL authority', () => {
    const parsed = parseIptvCredentials(
        [
            'HTTPS://Example.TEST:443/CaseSensitive/Feed.m3u?Token=AbC',
            'https://example.test/CaseSensitive/Feed.m3u?Token=AbC',
            'https://example.test/casesensitive/Feed.m3u?Token=AbC',
            'https://example.test/CaseSensitive/Feed.m3u?token=AbC',
        ].join('\n')
    );

    assert.equal(parsed.candidates.length, 3);
    assert.equal(parsed.duplicates.length, 1);
    assert.deepEqual(
        parsed.candidates.map((candidate) => candidate.playlistUrl),
        [
            'https://example.test/CaseSensitive/Feed.m3u?Token=AbC',
            'https://example.test/casesensitive/Feed.m3u?Token=AbC',
            'https://example.test/CaseSensitive/Feed.m3u?token=AbC',
        ]
    );
});

test('prioritizes Xtream when an advertised M3U URL contains credentials', () => {
    const parsed = parseIptvCredentials(
        'https://provider.test/get.php?username=user&password=secret&type=m3u_plus'
    );

    assert.equal(parsed.invalidEntries.length, 0);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].type, 'xtream');
    assert.equal(parsed.candidates[0].serverUrl, 'https://provider.test');
    assert.equal(parsed.candidates[0].username, 'user');
    assert.equal(parsed.candidates[0].password, 'secret');
});

test('prioritizes Xtream URL userinfo and trailing credentials over M3U markers', () => {
    const parsed = parseIptvCredentials(
        [
            'https://alice:hunter2@provider.test/list.m3u',
            'https://provider-two.test/list.m3u bob password',
        ].join('\n')
    );

    assert.deepEqual(
        parsed.candidates.map((candidate) => ({
            type: candidate.type,
            serverUrl: candidate.serverUrl,
            username: candidate.username,
            password: candidate.password,
        })),
        [
            {
                type: 'xtream',
                serverUrl: 'https://provider.test',
                username: 'alice',
                password: 'hunter2',
            },
            {
                type: 'xtream',
                serverUrl: 'https://provider-two.test',
                username: 'bob',
                password: 'password',
            },
        ]
    );
});

test('reports invalid entries and enforces the first 100 unique candidates', () => {
    const entries = Array.from(
        { length: 101 },
        (_, index) => `https://provider.test/list-${index}.m3u`
    );
    entries.push('not a source');

    const parsed = parseIptvCredentials(entries.join('\n'));

    assert.equal(parsed.candidates.length, 100);
    assert.equal(parsed.invalidEntries.length, 2);
    assert.match(parsed.invalidEntries[0].reason, /100 unique/);
});
