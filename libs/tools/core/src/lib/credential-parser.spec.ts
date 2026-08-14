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

test('extracts credentials from an Xtream API URL', () => {
    const parsed = parseIptvCredentials(
        'https://provider.test/player_api.php?username=user&password=secret'
    );

    assert.equal(parsed.invalidEntries.length, 0);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].type, 'xtream');
    assert.equal(parsed.candidates[0].serverUrl, 'https://provider.test');
    assert.equal(parsed.candidates[0].username, 'user');
    assert.equal(parsed.candidates[0].password, 'secret');
});

test('extracts Xtream credentials from URL userinfo and trailing credentials', () => {
    const parsed = parseIptvCredentials(
        [
            'https://alice:hunter2@provider.test/player_api.php',
            'https://provider-two.test/player_api.php bob password',
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

test('combines a server URL with labeled credentials on following lines', () => {
    const parsed = parseIptvCredentials(
        [
            'https://provider.example:80',
            'username=user&123',
            'pass=passs',
        ].join('\n')
    );

    assert.equal(parsed.invalidEntries.length, 0);
    assert.equal(parsed.candidates.length, 1);
    assert.equal(parsed.candidates[0].type, 'xtream');
    assert.equal(parsed.candidates[0].serverUrl, 'https://provider.example:80');
    assert.equal(parsed.candidates[0].username, 'user&123');
    assert.equal(parsed.candidates[0].password, 'passs');
});

test('combines unlabeled three-line Xtream credential blocks', () => {
    const parsed = parseIptvCredentials(
        [
            'http://provider-one.example:8080',
            'user-one',
            'password-one',
            '',
            'http://provider-two.example',
            'user-two',
            'password-two',
        ].join('\n')
    );

    assert.equal(parsed.invalidEntries.length, 0);
    assert.deepEqual(
        parsed.candidates.map((candidate) => ({
            serverUrl: candidate.serverUrl,
            username: candidate.username,
            password: candidate.password,
        })),
        [
            {
                serverUrl: 'http://provider-one.example:8080',
                username: 'user-one',
                password: 'password-one',
            },
            {
                serverUrl: 'http://provider-two.example',
                username: 'user-two',
                password: 'password-two',
            },
        ]
    );
});

test('ignores generic HTTPS links while keeping explicit HTTPS IPTV URLs', () => {
    const parsed = parseIptvCredentials(
        [
            'YouTube: https://www.youtube.com/channel/example',
            'https://provider.example/player_api.php?username=user&password=pass',
            'https://provider.example user2 pass2',
        ].join('\n')
    );

    assert.equal(parsed.candidates.length, 2);
    assert.equal(parsed.invalidEntries.length, 1);
    assert.equal(parsed.candidates[0].type, 'xtream');
    assert.equal(parsed.candidates[1].type, 'xtream');
});

test('combines Host and Server labeled Xtream blocks', () => {
    const parsed = parseIptvCredentials(
        [
            'Xtream server',
            'Host: http://host-one.example:80',
            'Username: user-one',
            'Password: pass-one',
            'Server: http://host-two.example:8080',
            'User: user-two',
            'Pass: pass-two',
        ].join('\n')
    );

    assert.equal(parsed.invalidEntries.length, 0);
    assert.equal(parsed.candidates.length, 2);
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
                serverUrl: 'http://host-one.example',
                username: 'user-one',
                password: 'pass-one',
            },
            {
                type: 'xtream',
                serverUrl: 'http://host-two.example:8080',
                username: 'user-two',
                password: 'pass-two',
            },
        ]
    );
});

test('does not treat metadata dates and labels as slash credentials', () => {
    const parsed = parseIptvCredentials(
        ['2546 channels', 'US UK', 'Movies special', 'Expiry 22/12/26'].join('\n')
    );

    assert.equal(parsed.candidates.length, 0);
    assert.equal(parsed.invalidEntries.length, 4);
});

test('reports invalid entries and enforces the first 100 unique candidates', () => {
    const entries = Array.from(
        { length: 101 },
        (_, index) =>
            `https://provider.test/player_api.php?username=user${index}&password=pass${index}`
    );
    entries.push('not a source');

    const parsed = parseIptvCredentials(entries.join('\n'));

    assert.equal(parsed.candidates.length, 100);
    assert.equal(parsed.invalidEntries.length, 2);
    assert.match(parsed.invalidEntries[0].reason, /100 unique/);
});
