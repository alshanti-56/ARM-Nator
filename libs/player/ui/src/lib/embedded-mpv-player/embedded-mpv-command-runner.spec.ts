import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { signal } from '@angular/core';
import { EmbeddedMpvCommandRunner } from './embedded-mpv-command-runner';

const session = {
    id: 'session-1',
    backend: 'ksplayer-metal' as const,
    title: 'Fixture',
    streamUrl: 'https://example.invalid/video',
    status: 'playing' as const,
    positionSeconds: 10,
    durationSeconds: 100,
    volume: 0.5,
    audioTracks: [],
    selectedAudioTrackId: null,
    subtitleTracks: [],
    selectedSubtitleTrackId: null,
    playbackSpeed: 1,
    aspectOverride: 'no',
    picture: {
        brightness: 0,
        contrast: 0,
        blackLevel: 0,
        saturation: 0,
        gamma: 0,
    },
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
};

function installBridge(bridge: Record<string, unknown>): void {
    (globalThis as typeof globalThis & { window: { electron: unknown } }).window = {
        electron: bridge,
    };
}

test('dispatches transport commands to KSPlayer Metal only', async () => {
    const calls: string[] = [];
    const updated = (name: string) => {
        calls.push(name);
        return Promise.resolve({
            ...session,
            updatedAt: new Date().toISOString(),
        });
    };
    installBridge({
        setKsPlayerMetalPaused: () => updated('ks-pause'),
        seekKsPlayerMetal: () => updated('ks-seek'),
        setKsPlayerMetalVolume: () => updated('ks-volume'),
        setEmbeddedMpvPaused: () => updated('embedded-pause'),
        seekEmbeddedMpv: () => updated('embedded-seek'),
        setEmbeddedMpvVolume: () => updated('embedded-volume'),
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({ pause: true, seek: true, volume: true }),
    });

    await runner.togglePaused();
    await runner.seekBy(5);
    await runner.applyVolume(0.75);

    assert.deepEqual(calls, ['ks-pause', 'ks-seek', 'ks-volume']);
});

test('unsupported KSPlayer Metal controls are strict no-ops', async () => {
    const calls: string[] = [];
    installBridge({
        setKsPlayerMetalPaused: () => {
            calls.push('pause');
            return Promise.resolve(session);
        },
        seekKsPlayerMetal: () => {
            calls.push('seek');
            return Promise.resolve(session);
        },
        setKsPlayerMetalVolume: () => {
            calls.push('volume');
            return Promise.resolve(session);
        },
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({ pause: false, seek: false, volume: false }),
    });

    await runner.togglePaused();
    await runner.seekBy(5);
    await runner.applyVolume(0.75);

    assert.deepEqual(calls, []);
});

test('dispatches playback speed to KSPlayer Metal when advertised', async () => {
    const calls: number[] = [];
    installBridge({
        setKsPlayerMetalSpeed: (sessionId: string, speed: number) => {
            assert.equal(sessionId, 'session-1');
            calls.push(speed);
            return Promise.resolve({
                ...session,
                playbackSpeed: speed,
            });
        },
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({
            pause: true,
            seek: true,
            volume: true,
            playbackSpeed: true,
        }),
    });

    await runner.setSpeed(1.25);

    assert.deepEqual(calls, [1.25]);
});

test('dispatches MPV-compatible aspect presets to KSPlayer Metal when advertised', async () => {
    const calls: string[] = [];
    installBridge({
        setKsPlayerMetalAspect: (sessionId: string, aspect: string) => {
            assert.equal(sessionId, 'session-1');
            calls.push(aspect);
            return Promise.resolve({ ...session, aspectOverride: aspect });
        },
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({ aspectOverride: true }),
    });

    await runner.setAspect('2.35:1');
    assert.deepEqual(calls, ['2.35:1']);
});

test('dispatches audio track selection to KSPlayer Metal when advertised', async () => {
    const calls: number[] = [];
    installBridge({
        setKsPlayerMetalAudioTrack: (sessionId: string, trackId: number) => {
            assert.equal(sessionId, 'session-1');
            calls.push(trackId);
            return Promise.resolve(session);
        },
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({
            pause: true,
            seek: true,
            volume: true,
            audioTracks: true,
        }),
    });

    await runner.setAudioTrack(3);

    assert.deepEqual(calls, [3]);
});

test('dispatches picture settings to KSPlayer Metal only when advertised', async () => {
    const calls: unknown[] = [];
    installBridge({
        setKsPlayerMetalPicture: (sessionId: string, picture: unknown) => {
            assert.equal(sessionId, 'session-1');
            calls.push(picture);
            return Promise.resolve({ ...session, picture });
        },
    });
    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('ksplayer-metal'),
        sessionId: signal('session-1'),
        session: signal(session),
        supportedControls: signal({
            pause: true,
            seek: true,
            volume: true,
            pictureAdjustments: true,
        }),
    });
    const picture = { brightness: 15, contrast: 0, blackLevel: 0, saturation: 0, gamma: 0 };

    await runner.setPicture(picture);
    assert.deepEqual(calls, [picture]);
});

test('embedded backend keeps dispatching to legacy MPV methods', async () => {
    const calls: string[] = [];
    const updated = (name: string) => {
        calls.push(name);
        return Promise.resolve({
            ...session,
            backend: 'embedded-mpv' as const,
            updatedAt: new Date().toISOString(),
        });
    };
    installBridge({
        setEmbeddedMpvPaused: () => updated('embedded-pause'),
        seekEmbeddedMpv: () => updated('embedded-seek'),
        setEmbeddedMpvVolume: () => updated('embedded-volume'),
        setKsPlayerMetalPaused: () => updated('ks-pause'),
        seekKsPlayerMetal: () => updated('ks-seek'),
        setKsPlayerMetalVolume: () => updated('ks-volume'),
    });

    const runner = new EmbeddedMpvCommandRunner({
        backend: signal('embedded-mpv'),
        sessionId: signal('session-1'),
        session: signal({ ...session, backend: 'embedded-mpv' }),
        supportedControls: signal(null),
    });

    await runner.togglePaused();
    await runner.seekBy(5);
    await runner.applyVolume(0.75);

    assert.deepEqual(calls, [
        'embedded-pause',
        'embedded-seek',
        'embedded-volume',
    ]);
});
