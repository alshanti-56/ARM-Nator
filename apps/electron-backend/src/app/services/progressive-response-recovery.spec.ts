import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeProgressivePlaybackUrl, recoverProgressiveResponse } from './progressive-response-recovery';

function partial(body: string, start: number, end: number, total: number, fail = false): Response {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(Buffer.from(body));
            } else if (fail) {
                controller.error(new TypeError('terminated'));
            } else controller.close();
        },
    }, { highWaterMark: 0 }), {
        status: 206,
        headers: {
            'content-range': `bytes ${start}-${end}/${total}`,
            'content-length': String(end - start + 1),
            etag: '"same-file"',
        },
    });
}

test('an interrupted movie resumes at the next byte without repeating delivered data', async () => {
    const requests: unknown[] = [];
    const upstream = partial('abc', 10, 15, 100, true);
    Object.defineProperty(upstream, 'url', { value: 'https://media.test/final.mp4' });
    const response = recoverProgressiveResponse(upstream, new AbortController().signal, async (range, validator) => {
        requests.push({ range, validator });
        return partial('def', 13, 15, 100);
    });
    assert.equal(await response.text(), 'abcdef');
    assert.equal(response.url, upstream.url);
    assert.deepEqual(requests, [{ range: 'bytes=13-15', validator: '"same-file"' }]);
});

test('a clean but short body is resumed too', async () => {
    const response = recoverProgressiveResponse(partial('ab', 0, 3, 4), new AbortController().signal,
        async () => partial('cd', 2, 3, 4));
    assert.equal(await response.text(), 'abcd');
});

test('a server that ignores the continuation range cannot splice another file into playback', async () => {
    const response = recoverProgressiveResponse(partial('ab', 0, 3, 4, true), new AbortController().signal,
        async () => new Response('abcd'));
    await assert.rejects(response.text());
});

test('a changed file validator cannot be spliced into playback', async () => {
    const response = recoverProgressiveResponse(partial('ab', 0, 3, 4, true), new AbortController().signal,
        async () => {
            const next = partial('cd', 2, 3, 4);
            next.headers.set('etag', '"different-file"');
            return next;
        });
    await assert.rejects(response.text());
});

test('continuation stops after three replacements even if the provider keeps cutting off', async () => {
    let requests = 0;
    const response = recoverProgressiveResponse(partial('a', 0, 9, 10, true), new AbortController().signal,
        async () => partial('b', ++requests, 9, 10, true));
    await assert.rejects(response.text());
    assert.equal(requests, 3);
});

test('cancelling playback prevents continuation', async () => {
    const controller = new AbortController();
    let requests = 0;
    const response = recoverProgressiveResponse(partial('a', 0, 9, 10, true), controller.signal,
        async () => { requests++; return partial('b', 1, 9, 10); });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await assert.rejects(reader.read());
    assert.equal(requests, 0);
});

test('native playback keeps one response open across successful finite upstream ranges', async () => {
    const requests: string[] = [];
    const response = recoverProgressiveResponse(partial('abcd', 0, 3, 8), new AbortController().signal,
        async (range) => { requests.push(range); return partial('efgh', 4, 7, 8); }, true);
    assert.equal(response.headers.get('content-range'), 'bytes 0-7/8');
    assert.equal(response.headers.get('content-length'), '8');
    assert.equal(await response.text(), 'abcdefgh');
    assert.deepEqual(requests, ['bytes=4-7']);
});

test('continuous native mode applies only to opaque local movie proxy URLs', () => {
    const local = `http://127.0.0.1:1234/media/${'a'.repeat(48)}/${'b'.repeat(32)}`;
    assert.equal(nativeProgressivePlaybackUrl(local), local + '/continuous');
    for (const source of [local + '/continuous', local.replace('/media/', '/hls/'),
        local.replace('127.0.0.1', 'provider.test'), 'https://provider.test/movie.mp4']) {
        assert.equal(nativeProgressivePlaybackUrl(source), source);
    }
});
