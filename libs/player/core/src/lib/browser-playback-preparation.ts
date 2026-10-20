import type { AutoPlaybackPreparation } from '@arm-nator/shared/interfaces';

/** Hints only: direct browser playback still verifies actual frames and reports decoder failures. */
export function browserPlaybackPreparation(url: string): AutoPlaybackPreparation {
    let path = '';
    try { path = new URL(url).pathname.toLowerCase(); } catch { /* The media element reports invalid URLs. */ }
    const format = /\.m3u8?$/.test(path) ? 'hls' : /\.mpd$/.test(path) ? 'dash' : /\.ts$/.test(path) ? 'mpegts'
        : /\.(mp4|m4v|mov|webm|mkv|mp3|aac|m4a|ogg|wav)$/.test(path) ? 'progressive' : 'unknown';
    const container = /\.mkv$/.test(path) ? 'matroska' : /\.webm$/.test(path) ? 'webm'
        : /\.(mp4|m4v|mov)$/.test(path) ? 'mp4' : undefined;
    return { id: `direct:${crypto.randomUUID()}`, url, format, container, processingMode: 'direct' };
}
