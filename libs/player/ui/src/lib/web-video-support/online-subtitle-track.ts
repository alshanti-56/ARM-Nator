export const ONLINE_SUBTITLE_TRACK_ID = 'arm-nator-online-subtitle';
const ONLINE_SUBTITLE_ATTRIBUTE = 'data-arm-nator-online-subtitle';

export interface OnlineSubtitleTrack {
    readonly url?: string;
    readonly label?: string;
    readonly language?: string;
}

/**
 * Keeps one user-supplied remote WebVTT track on a web video element.
 * Browser players cannot natively parse SRT/ASS; those formats are reserved
 * for MPV/VLC integration.
 */
export function syncOnlineSubtitleTrack(
    video: HTMLVideoElement,
    subtitle: OnlineSubtitleTrack
): void {
    video
        .querySelectorAll(`track[${ONLINE_SUBTITLE_ATTRIBUTE}]`)
        .forEach((track) => track.remove());

    const url = subtitle.url?.trim();
    if (!url) {
        return;
    }

    const track = document.createElement('track');
    track.id = ONLINE_SUBTITLE_TRACK_ID;
    track.kind = 'subtitles';
    track.src = url;
    track.label = subtitle.label?.trim() || 'Online subtitle';
    track.srclang = subtitle.language?.trim() || 'und';
    track.default = true;
    track.setAttribute(ONLINE_SUBTITLE_ATTRIBUTE, '');
    video.appendChild(track);

    // Applying an online subtitle is an explicit user action. Show it even
    // when the global caption preference is currently off; the shared track
    // controller can still turn it off afterward.
    const textTrack = Array.from(video.textTracks).find(
        (candidate) => candidate.id === ONLINE_SUBTITLE_TRACK_ID
    );
    if (textTrack) {
        textTrack.mode = 'showing';
    }
}
