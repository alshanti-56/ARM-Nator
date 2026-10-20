import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normalizeVideoPlayer, resolveDefaultVideoPlayer, VideoPlayer } from './settings.interface';

test('retains an explicitly selected Auto mode and existing manual preferences', () => {
    assert.equal(normalizeVideoPlayer('auto'), 'auto');
    assert.equal(normalizeVideoPlayer('embedded-mpv'), VideoPlayer.EmbeddedMpv);
    assert.equal(resolveDefaultVideoPlayer({ player: VideoPlayer.ArtPlayer, livePlayer: 'auto' as VideoPlayer, vodPlayer: VideoPlayer.Html5Player }, true), 'auto');
    assert.equal(resolveDefaultVideoPlayer({ player: VideoPlayer.ArtPlayer, livePlayer: 'auto' as VideoPlayer, vodPlayer: VideoPlayer.Html5Player }, false), VideoPlayer.Html5Player);
});
