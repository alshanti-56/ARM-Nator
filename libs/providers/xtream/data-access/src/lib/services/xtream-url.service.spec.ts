import '@angular/compiler';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { SettingsStore } from '@arm-nator/services';
import { XtreamUrlService } from './xtream-url.service';
import type { XtreamCredentials } from './xtream-api.service';

function createUrlService(): XtreamUrlService {
    const injector = createEnvironmentInjector([
        {
            provide: SettingsStore,
            useValue: { streamFormat: () => 'm3u8' },
        },
    ]);
    return runInInjectionContext(injector, () => new XtreamUrlService());
}

test('routes live, VOD, and series playback through the advertised media host', () => {
    const service = createUrlService();
    const credentials: XtreamCredentials = {
        serverUrl: 'https://api.example:8443',
        playbackServerUrl: 'http://100main.cc:80',
        username: 'user name',
        password: 'secret/value',
        allowedOutputFormats: ['m3u8'],
    };

    assert.equal(
        service.constructLiveUrl(credentials, 42),
        'http://100main.cc:80/live/user%20name/secret%2Fvalue/42.m3u8'
    );
    assert.equal(
        service.constructVodUrl(credentials, {
            movie_data: { stream_id: 51, container_extension: 'mp4' },
        } as never),
        'http://100main.cc:80/movie/user%20name/secret%2Fvalue/51.mp4'
    );
    assert.equal(
        service.constructEpisodeUrl(credentials, {
            id: 63,
            container_extension: 'mkv',
        } as never),
        'http://100main.cc:80/series/user%20name/secret%2Fvalue/63.mkv'
    );
    assert.equal(credentials.serverUrl, 'https://api.example:8443');
});

test('falls back to the configured API host when playback metadata is invalid', () => {
    const service = createUrlService();
    const credentials: XtreamCredentials = {
        serverUrl: 'https://api.example:8443',
        playbackServerUrl: 'ftp://invalid.example',
        username: 'user',
        password: 'secret',
    };

    assert.equal(
        service.constructLiveUrl(credentials, 42),
        'https://api.example:8443/live/user/secret/42.m3u8'
    );
});

test('describes a known alternate host and only advertised live formats', () => {
    const service = createUrlService();
    const credentials: XtreamCredentials = {
        serverUrl: 'https://api.example:8443',
        playbackServerUrl: 'http://media.example:8080',
        username: 'user',
        password: 'secret',
        allowedOutputFormats: ['m3u8', 'ts'],
    };
    const playbackUrl = service.constructLiveUrl(credentials, 42);

    const metadata = service.buildPlaybackRecoveryMetadata(
        credentials,
        'playlist-xtream',
        playbackUrl,
        {
            liveStreamId: 42,
            savedHeaders: {
                'User-Agent': 'Custom player',
                Referer: 'https://saved.example/watch',
            },
        }
    );

    assert.equal(metadata.accountRef, 'playlist-xtream');
    assert.equal(metadata.portalCredentialsAvailable, undefined);
    assert.equal(
        metadata.alternateHostUrl,
        'https://api.example:8443/live/user/secret/42.m3u8'
    );
    assert.deepEqual(metadata.formatUrls, {
        hls: playbackUrl,
        mpegts: 'http://media.example:8080/live/user/secret/42.ts',
    });
    assert.deepEqual(metadata.savedHeaders, {
        'User-Agent': 'Custom player',
        Referer: 'https://saved.example/watch',
    });
});

test('does not invent format URLs or alternate hosts without account evidence', () => {
    const service = createUrlService();
    const credentials: XtreamCredentials = {
        serverUrl: 'https://api.example:8443',
        username: 'user',
        password: 'secret',
    };
    const playbackUrl = service.constructLiveUrl(credentials, 42);

    const metadata = service.buildPlaybackRecoveryMetadata(
        credentials,
        'playlist-xtream',
        playbackUrl,
        { liveStreamId: 42 }
    );

    assert.equal(metadata.alternateHostUrl, undefined);
    assert.equal(metadata.formatUrls, undefined);
    assert.equal(metadata.savedHeaders, undefined);
    assert.equal(metadata.defaultHeaders, undefined);
});
