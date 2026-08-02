import type { PlayerSubtitleSettings } from '@arm-nator/shared/interfaces';

let nextSubtitleStyleId = 0;

function hexToRgb(hex: string): [number, number, number] {
    const normalized = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
    return [
        Number.parseInt(normalized.slice(0, 2), 16) || 0,
        Number.parseInt(normalized.slice(2, 4), 16) || 0,
        Number.parseInt(normalized.slice(4, 6), 16) || 0,
    ];
}

/** Applies shared subtitle styling to browser-backed WebVTT tracks. */
export class WebVideoSubtitleAdjustments {
    private readonly styleId = `arm-nator-subtitles-${nextSubtitleStyleId++}`;
    private readonly style: HTMLStyleElement;
    private readonly cueTimes = new WeakMap<
        TextTrackCue,
        { startTime: number; endTime: number }
    >();
    private readonly trackElements = new Set<HTMLTrackElement>();
    private readonly observer: MutationObserver | null;
    private settings: PlayerSubtitleSettings | null = null;
    private readonly onTrackLoad = (): void => this.applyCueSettings();

    constructor(private readonly video: HTMLVideoElement) {
        const document = video.ownerDocument;
        this.style = document.createElement('style');
        document.head.appendChild(this.style);
        video.dataset.armNatorSubtitleStyle = this.styleId;
        this.attachTracks();
        this.observer = typeof MutationObserver === 'function'
            ? new MutationObserver(() => this.attachTracks())
            : null;
        this.observer?.observe(video, { childList: true });
    }

    apply(settings: PlayerSubtitleSettings): void {
        this.settings = settings;
        const [red, green, blue] = hexToRgb(settings.backgroundColor);
        const opacity = Math.max(0, Math.min(100, settings.backgroundOpacity)) / 100;
        const outline = Math.max(0, Math.min(6, settings.outlineSize));
        const selector = `video[data-arm-nator-subtitle-style="${this.styleId}"]::cue`;
        this.style.textContent = `${selector} {
            color: ${settings.textColor};
            background-color: rgba(${red}, ${green}, ${blue}, ${opacity});
            font-size: ${Math.max(50, Math.min(200, settings.fontSize))}%;
            text-shadow: 0 0 ${Math.max(1, outline)}px #000, 0 0 ${Math.max(1, outline)}px #000;
        }`;

        this.applyCueSettings();
    }

    private attachTracks(): void {
        for (const track of Array.from(this.video.querySelectorAll('track'))) {
            if (!this.trackElements.has(track)) {
                this.trackElements.add(track);
                track.addEventListener('load', this.onTrackLoad);
            }
        }
    }

    private applyCueSettings(): void {
        const settings = this.settings;
        if (!settings) {
            return;
        }
        for (const track of Array.from(this.video.textTracks)) {
            if (!track.cues) {
                continue;
            }
            for (const cue of Array.from(track.cues)) {
                const original = this.cueTimes.get(cue) ?? {
                    startTime: cue.startTime,
                    endTime: cue.endTime,
                };
                this.cueTimes.set(cue, original);
                cue.startTime = original.startTime + settings.delaySeconds;
                cue.endTime = original.endTime + settings.delaySeconds;
                const vttCue = cue as VTTCue;
                if (typeof vttCue.line === 'number') {
                    vttCue.line = Math.max(0, Math.min(100, settings.position));
                }
            }
        }
    }

    destroy(): void {
        this.video.removeAttribute('data-arm-nator-subtitle-style');
        this.observer?.disconnect();
        for (const track of this.trackElements) {
            track.removeEventListener('load', this.onTrackLoad);
        }
        this.style.remove();
    }
}
