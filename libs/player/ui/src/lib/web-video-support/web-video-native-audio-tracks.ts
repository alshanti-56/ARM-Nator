import type { PlayerTrack } from '../player-controls/player-controls.model';

const NATIVE_AUDIO_TRACK_EVENTS = ['addtrack', 'removetrack', 'change'] as const;

interface NativeAudioTrack {
    enabled: boolean;
    id?: string;
    label?: string;
    language?: string;
}

interface NativeAudioTrackList extends EventTarget {
    readonly length: number;
    readonly [index: number]: NativeAudioTrack | undefined;
}

type VideoWithAudioTracks = HTMLVideoElement & {
    readonly audioTracks?: NativeAudioTrackList;
};

/**
 * Optional bridge for the browser's native AudioTrackList API.
 *
 * Chromium does not expose this API for every container/build. Returning an
 * empty list is intentional in that case so callers keep their manual MPV
 * fallback instead of presenting controls that cannot work.
 */
export class WebVideoNativeAudioTracks {
    private trackList: NativeAudioTrackList | null = null;
    private refreshListener: EventListener | null = null;
    private active = false;

    constructor(
        private readonly video: HTMLVideoElement,
        private readonly refresh: () => void
    ) {}

    bind(): void {
        this.clear();
        this.active = true;
        const trackList = (this.video as VideoWithAudioTracks).audioTracks;
        if (!trackList) {
            return;
        }

        this.trackList = trackList;
        if (typeof trackList.addEventListener === 'function') {
            const refresh: EventListener = () => this.refresh();
            this.refreshListener = refresh;
            for (const event of NATIVE_AUDIO_TRACK_EVENTS) {
                trackList.addEventListener(event, refresh);
            }
        }
        this.refresh();
    }

    clear(): void {
        if (
            this.trackList &&
            this.refreshListener &&
            typeof this.trackList.removeEventListener === 'function'
        ) {
            for (const event of NATIVE_AUDIO_TRACK_EVENTS) {
                this.trackList.removeEventListener(
                    event,
                    this.refreshListener
                );
            }
        }
        this.trackList = null;
        this.refreshListener = null;
        this.active = false;
    }

    getAudioTracks(): PlayerTrack[] {
        return this.readTracks().map((track, index) => ({
            id: index,
            label:
                track.label ||
                track.language ||
                track.id ||
                `Audio ${index + 1}`,
            selected: track.enabled,
        }));
    }

    setAudioTrack(id: number): void {
        if (!Number.isInteger(id)) {
            return;
        }

        const tracks = this.readTracks();
        if (id < 0 || id >= tracks.length) {
            return;
        }
        for (let index = 0; index < tracks.length; index += 1) {
            tracks[index].enabled = index === id;
        }
        this.refresh();
    }

    private readTracks(): NativeAudioTrack[] {
        if (!this.active) {
            return [];
        }

        const result: NativeAudioTrack[] = [];
        try {
            const trackList =
                this.trackList ??
                (this.video as VideoWithAudioTracks).audioTracks ??
                null;
            if (!trackList) {
                return [];
            }
            for (let index = 0; index < trackList.length; index += 1) {
                const track = trackList[index];
                if (track) {
                    result.push(track);
                }
            }
        } catch {
            return [];
        }
        return result;
    }
}
