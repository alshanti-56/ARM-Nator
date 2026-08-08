import assert from 'node:assert/strict';
import test from 'node:test';
import { hasStartedNativeSession } from './workspace-player-native-session';

test('ignores the native component neutral startup snapshot', () => {
    assert.equal(
        hasStartedNativeSession(
            { engine: 'embedded-mpv', available: false },
            'embedded-mpv'
        ),
        false
    );
});

test('recognizes embedded sessions with status or identity', () => {
    assert.equal(
        hasStartedNativeSession(
            {
                engine: 'embedded-mpv',
                available: true,
                sessionStatus: 'loading',
            },
            'embedded-mpv'
        ),
        true
    );
    assert.equal(
        hasStartedNativeSession(
            {
                engine: 'embedded-mpv',
                available: true,
                sessionId: 'session-1',
            },
            'embedded-mpv'
        ),
        true
    );
});

test('does not confuse KSPlayer Metal with embedded MPV', () => {
    assert.equal(
        hasStartedNativeSession(
            {
                engine: 'ksplayer-metal',
                available: true,
                sessionStatus: 'playing',
            },
            'embedded-mpv'
        ),
        false
    );
});
