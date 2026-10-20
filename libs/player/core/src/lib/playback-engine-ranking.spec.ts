import { strict as assert } from 'node:assert';
import test from 'node:test';
import { VideoPlayer } from '@arm-nator/shared/interfaces';
import { rankAutomaticPlaybackEngines } from './automatic-playback-plan';

test('desktop compatibility first uses available native engines before browser playback', () => {
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'hls' }, { embeddedMpv: true, ksPlayer: true }),
    [VideoPlayer.EmbeddedMpv, VideoPlayer.KsPlayer, VideoPlayer.ArtPlayer]);
});
test('browser excludes known unsupported codecs and honors native HLS capability', () => {
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'hls' }, { embeddedMpv: false, ksPlayer: false, nativeHls: true }), [VideoPlayer.Html5Player, VideoPlayer.ArtPlayer]);
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'progressive', container: 'mp4', videoCodecs: ['hev1'] }, { embeddedMpv: false, ksPlayer: false, browserCodecs: { hev1: false } }), []);
});
test('unknown browser streams get a bounded real attempt rather than an extension guess rejection', () => {
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'unknown' }, { embeddedMpv: false, ksPlayer: false }), [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player]);
});
test('remembered engine is promoted only while still compatible and available', () => {
  const support = { embeddedMpv: true, ksPlayer: false };
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'progressive', container: 'mp4' }, support, VideoPlayer.Html5Player), [VideoPlayer.Html5Player, VideoPlayer.EmbeddedMpv]);
  assert.deepEqual(rankAutomaticPlaybackEngines({ format: 'hls' }, support, VideoPlayer.KsPlayer), [VideoPlayer.EmbeddedMpv, VideoPlayer.ArtPlayer]);
});
