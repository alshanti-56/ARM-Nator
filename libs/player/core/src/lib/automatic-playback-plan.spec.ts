import { strict as assert } from 'node:assert';
import test from 'node:test';
import { VideoPlayer } from '@arm-nator/shared/interfaces';
import { selectAutomaticPlaybackEngine, shouldUseAutomaticNativeFallback } from './automatic-playback-plan';

test('selects browser playback for HLS and TS when native runtimes are unavailable', () => {
    for (const format of ['hls', 'mpegts'] as const) {
        const plan = selectAutomaticPlaybackEngine({ format }, { embeddedMpv: false, ksPlayer: false });
        assert.equal(plan.engine, VideoPlayer.ArtPlayer);
        assert.ok(plan.reason);
    }
});

test('selects bundled native playback for Matroska without launching an external application', () => {
    assert.equal(selectAutomaticPlaybackEngine({ format: 'progressive', container: 'matroska' }, { embeddedMpv: true, ksPlayer: true }).engine, VideoPlayer.EmbeddedMpv);
    assert.equal(selectAutomaticPlaybackEngine({ format: 'progressive', container: 'matroska' }, { embeddedMpv: false, ksPlayer: true }).engine, VideoPlayer.KsPlayer);
    assert.equal(selectAutomaticPlaybackEngine({ format: 'progressive', container: 'matroska' }, { embeddedMpv: false, ksPlayer: false }).engine, null);
});

test('selects HTML video for inspected MP4 and WebM and native for unknown media', () => {
    for (const container of ['mp4', 'webm'] as const) {
        assert.equal(selectAutomaticPlaybackEngine({ format: 'progressive', container }, { embeddedMpv: false, ksPlayer: false }).engine, VideoPlayer.Html5Player);
    }
    assert.equal(selectAutomaticPlaybackEngine({ format: 'unknown' }, { embeddedMpv: true, ksPlayer: false }).engine, VideoPlayer.EmbeddedMpv);
    assert.equal(selectAutomaticPlaybackEngine({ format: 'dash' }, { embeddedMpv: false, ksPlayer: false }).engine, VideoPlayer.ArtPlayer);
});

test('only permits one native fallback for browser decoder/container failures', () => {
    for (const code of ['unsupported-container', 'unsupported-codec', 'media-decode-error']) {
        assert.equal(shouldUseAutomaticNativeFallback(code, false, true), true);
        assert.equal(shouldUseAutomaticNativeFallback(code, true, true), false);
        assert.equal(shouldUseAutomaticNativeFallback(code, false, false), false);
    }
    for (const code of ['network-error', 'provider-rejected', 'browser-access-error', 'drm-or-encryption', 'unknown-playback-error']) {
        assert.equal(shouldUseAutomaticNativeFallback(code, false, true), false);
    }
});
