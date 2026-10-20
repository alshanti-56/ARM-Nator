type ContentRange = { start: number; end: number; total: number };
const CONTINUATION_BYTES = 25 * 1024 * 1024;

export function nativeProgressivePlaybackUrl(source: string): string {
    try {
        const url = new URL(source);
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port &&
            /^\/media\/[a-f0-9]{48}\/[a-f0-9]{32}$/.test(url.pathname) && !url.search && !url.hash) {
            url.pathname += '/continuous';
            return url.toString();
        }
    } catch { /* Direct and non-HTTP sources retain their existing handlers. */ }
    return source;
}

function contentRange(response: Response): ContentRange | null {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!match) return null;
    const [start, end, total] = match.slice(1).map(Number);
    return [start, end, total].every(Number.isSafeInteger) && start <= end && end < total
        ? { start, end, total } : null;
}

function encoded(response: Response): boolean {
    const encoding = response.headers.get('content-encoding');
    return !!encoding && encoding !== 'identity';
}

/** Continue interrupted, byte-addressable movie bodies within the same downstream response. */
export function recoverProgressiveResponse(
    upstream: Response,
    signal: AbortSignal,
    requestRange: (range: string, validator?: string) => Promise<Response>,
    continuous = false,
): Response {
    if (!upstream.body || !upstream.ok || encoded(upstream)) return upstream;
    const length = Number(upstream.headers.get('content-length'));
    const range = contentRange(upstream) ?? (
        upstream.status === 200 && Number.isSafeInteger(length) && length > 0
            ? { start: 0, end: length - 1, total: length } : null
    );
    if (!range) return upstream;
    const etag = upstream.headers.get('etag');
    const validatorHeader = etag && !etag.startsWith('W/') ? 'etag' : 'last-modified';
    const validator = upstream.headers.get(validatorHeader) ?? undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = upstream.body.getReader();
    let offset = range.start;
    const finalEnd = continuous ? range.total - 1 : range.end;
    let rangeEnd = range.end;
    let replacements = 0;
    let requestBudget = 3;
    let stopped = false;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const discardReader = async () => {
        const previous = reader;
        reader = null;
        if (!previous) return;
        await previous.cancel().catch(() => undefined);
        previous.releaseLock();
    };
    const stop = () => {
        stopped = true;
        signal.removeEventListener('abort', abort);
    };
    const abort = () => {
        if (stopped) return;
        stop();
        streamController.error(signal.reason ?? new Error('Playback cancelled.'));
        void discardReader();
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
        },
        async pull(controller) {
            try {
                while (!stopped) {
                    signal.throwIfAborted();
                    if (offset > finalEnd) {
                        stop();
                        controller.close();
                        await discardReader();
                        return;
                    }
                    if (reader) {
                        let chunk: ReadableStreamReadResult<Uint8Array> | undefined;
                        try {
                            chunk = await reader.read();
                        } catch {
                            signal.throwIfAborted();
                        }
                        if (stopped) return;
                        if (chunk && !chunk.done) {
                            if (offset + chunk.value.byteLength > rangeEnd + 1) {
                                throw new Error('Movie response exceeded its declared byte range.');
                            }
                            offset += chunk.value.byteLength;
                            controller.enqueue(chunk.value);
                            return;
                        }
                        await discardReader();
                    }
                    if (stopped) return;
                    if (offset > rangeEnd) {
                        // A complete range is ordinary forward reading. Give the
                        // next range one request plus three recovery attempts.
                        replacements = 0;
                        requestBudget = 4;
                        rangeEnd = Math.min(finalEnd, offset + CONTINUATION_BYTES - 1);
                    } else if (continuous) {
                        rangeEnd = Math.min(rangeEnd, offset + CONTINUATION_BYTES - 1);
                    }
                    if (replacements++ >= requestBudget) throw new Error('Movie download remained incomplete after three continuations.');
                    let next: Response;
                    try {
                        next = await requestRange(`bytes=${offset}-${rangeEnd}`, validator);
                    } catch (error) {
                        signal.throwIfAborted();
                        if (replacements >= requestBudget) throw error;
                        continue;
                    }
                    if (stopped || signal.aborted) {
                        await next.body?.cancel().catch(() => undefined);
                        signal.throwIfAborted();
                        return;
                    }
                    const nextRange = contentRange(next);
                    const nextValidator = next.headers.get(validatorHeader);
                    if (next.status !== 206 || !next.body || encoded(next) || !nextRange ||
                        nextRange.start !== offset || nextRange.end !== rangeEnd || nextRange.total !== range.total ||
                        (validator && nextValidator && validator !== nextValidator)) {
                        await next.body?.cancel().catch(() => undefined);
                        throw new Error('Provider did not return the requested continuation of the same movie.');
                    }
                    reader = next.body.getReader();
                }
            } catch (error) {
                if (!stopped) {
                    stop();
                    controller.error(error);
                    await discardReader();
                }
            }
        },
        async cancel() {
            stop();
            await discardReader();
        },
    }, { highWaterMark: 0 });
    const headers = new Headers(upstream.headers);
    if (continuous) {
        headers.set('content-length', String(finalEnd - range.start + 1));
        if (upstream.status === 206 || headers.has('content-range')) {
            headers.set('content-range', `bytes ${range.start}-${finalEnd}/${range.total}`);
        }
    }
    const response = new Response(body, {
        status: upstream.status, statusText: upstream.statusText, headers,
    });
    Object.defineProperty(response, 'url', { value: upstream.url });
    return response;
}
