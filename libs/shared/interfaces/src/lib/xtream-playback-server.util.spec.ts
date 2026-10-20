import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveXtreamPlaybackServerUrl } from './xtream-portal.utils';

test('derives a playback host from authenticated Xtream server metadata', () => {
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: '100main.cc',
                server_protocol: 'http',
                port: '80',
            },
        }),
        'http://100main.cc:80'
    );
});

test('keeps an advertised scheme and explicit port while normalizing API paths', () => {
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: '1' },
            server_info: {
                url: 'https://media.example:8443/player_api.php',
                server_protocol: 'https',
                port: '443',
            },
        }),
        'https://media.example:8443'
    );
});

test('uses the HTTPS port when the account also advertises an HTTP port', () => {
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'secure.example',
                server_protocol: 'https',
                port: '80',
                https_port: '443',
            },
        }),
        'https://secure.example:443'
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'fallback.example',
                server_protocol: 'https',
                port: '1443',
            },
        }),
        'https://fallback.example:1443'
    );
});

test('uses a nondefault HTTPS port and preserves a URL-embedded HTTPS port', () => {
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'secure.example',
                server_protocol: 'https',
                port: '80',
                https_port: '8443',
            },
        }),
        'https://secure.example:8443'
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'https://secure.example:9443/player_api.php',
                server_protocol: 'https',
                port: '80',
                https_port: '8443',
            },
        }),
        'https://secure.example:9443'
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'https://secure.example',
                port: '80',
                https_port: '9443',
            },
        }),
        'https://secure.example:9443'
    );
});

test('rejects unauthenticated, missing, or unsafe server metadata', () => {
    const serverInfo = {
        url: 'media.example',
        server_protocol: 'https',
        port: '443',
    };

    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 0 },
            server_info: serverInfo,
        }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({ user_info: { auth: 1 } }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: { ...serverInfo, url: 'user:secret@media.example' },
        }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: { ...serverInfo, server_protocol: 'ftp' },
        }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: { ...serverInfo, port: '70000' },
        }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: { malformed: true },
                server_protocol: 'https',
                port: '443',
            },
        }),
        undefined
    );
    assert.equal(
        deriveXtreamPlaybackServerUrl({
            user_info: { auth: 1 },
            server_info: {
                url: 'media.example',
                server_protocol: { malformed: true },
                port: '443',
            },
        }),
        undefined
    );
});
