import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isVideoStalled,
    mapVideoStatus,
} from './web-video-controls.media-helpers';

function fakeVideo(overrides: Record<string, unknown> = {}) {
    return {
        paused: false,
        ended: false,
        readyState: 2,
        networkState: 1,
        currentTime: 10,
        buffered: {
            length: 1,
            start: () => 0,
            end: () => 30,
        },
        ...overrides,
    } as HTMLVideoElement;
}

test('does not call a buffered progressive VOD loading during a readyState downgrade', () => {
    const video = fakeVideo({ readyState: 1 });

    assert.equal(isVideoStalled(video), false);
    assert.equal(mapVideoStatus(video), 'playing');
});

test('calls a playing VOD stalled when the contiguous buffer is exhausted', () => {
    const video = fakeVideo({
        buffered: {
            length: 1,
            start: () => 0,
            end: () => 10.1,
        },
    });

    assert.equal(isVideoStalled(video), true);
    assert.equal(mapVideoStatus(video), 'loading');
});
