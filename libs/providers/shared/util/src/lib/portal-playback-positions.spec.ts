import assert from 'node:assert/strict';
import test from 'node:test';
import { getPortalPlaybackProgressPercent, isPortalPlaybackInProgress, isPortalPlaybackWatched } from './portal-playback-positions';

test('portal watched and resume states use unrounded 95 percent instead of display rounding', () => {
    const position = { contentXtreamId: 7, contentType: 'vod' as const, positionSeconds: 949, durationSeconds: 1000 };
    assert.equal(getPortalPlaybackProgressPercent(position), 95);
    assert.equal(isPortalPlaybackWatched(position), false);
    assert.equal(isPortalPlaybackInProgress(position), true);
    assert.equal(isPortalPlaybackWatched({ ...position, positionSeconds: 950 }), true);
    assert.equal(isPortalPlaybackInProgress({ ...position, positionSeconds: 950 }), false);
    assert.equal(isPortalPlaybackInProgress({ ...position, durationSeconds: undefined }), true);
    assert.equal(isPortalPlaybackWatched({ ...position, durationSeconds: Infinity }), false);
});
