import assert from 'node:assert/strict';
import test from 'node:test';
import { originalProviderPlayback } from './original-provider-playback';

test('manual recovery preserves the provider request and VOD position without retaining a released proxy', () => {
    const source = {
        streamUrl: 'http://127.0.0.1/proxy/movie.mp4', originalStreamUrl: 'https://provider/movie?token=exact',
        preparedProxy: { id: 'owned', url: 'http://127.0.0.1/proxy/movie.mp4', format: 'progressive' as const },
        title: 'Movie', isLive: false, headers: { Authorization: 'exact' }, startTime: 10,
    };
    const original = originalProviderPlayback(source, 125);
    assert.equal(original.streamUrl, 'https://provider/movie?token=exact');
    assert.equal(original.startTime, 125);
    assert.equal(original.preparedProxy, undefined);
    assert.equal(original.originalStreamUrl, undefined);
    assert.deepEqual(original.headers, source.headers);
    assert.equal(source.preparedProxy.id, 'owned');
});

test('live switching never adds a VOD resume offset', () => {
    assert.equal(originalProviderPlayback({ streamUrl: 'https://provider/live', title: 'Live', isLive: true }, 60).startTime, undefined);
});
