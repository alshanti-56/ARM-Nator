import { isPlaybackShortcutBlocked } from '../player-controls/playback-shortcut-focus';

export interface EmbeddedMpvShortcutHandlers {
    isAvailable: () => boolean;
    canTogglePaused?: () => boolean;
    canSeek?: () => boolean;
    canAdjustVolume?: () => boolean;
    canToggleFullscreen?: () => boolean;
    /**
     * While true, arrow keys stop seeking/adjusting volume — an open dock
     * chip panel owns them for chip navigation instead.
     */
    arrowKeysBlocked?: () => boolean;
    onEscape: () => void;
    togglePaused: () => void;
    toggleFullscreen: () => void;
    seekBy: (deltaSeconds: number) => void;
    adjustVolume: (delta: number) => void;
    toggleMute: () => void;
}

export class EmbeddedMpvShortcuts {
    private handlers: EmbeddedMpvShortcutHandlers | null = null;
    private readonly listener = (event: KeyboardEvent) => this.handle(event);

    attach(handlers: EmbeddedMpvShortcutHandlers): void {
        this.handlers = handlers;
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.listener);
        }
    }

    detach(): void {
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.listener);
        }
        this.handlers = null;
    }

    private handle(event: KeyboardEvent): void {
        const handlers = this.handlers;
        if (!handlers || isPlaybackShortcutBlocked(event) || !handlers.isAvailable()) {
            return;
        }

        if (event.key === 'Escape') {
            handlers.onEscape();
            return;
        }

        const arrowsBlocked = handlers.arrowKeysBlocked?.() === true;

        switch (event.key) {
            case ' ':
            case 'k':
            case 'K':
                if (handlers.canTogglePaused?.() === false) return;
                event.preventDefault();
                handlers.togglePaused();
                return;
            case 'f':
            case 'F':
                if (handlers.canToggleFullscreen?.() === false) return;
                event.preventDefault();
                handlers.toggleFullscreen();
                return;
            case 'ArrowLeft':
                if (arrowsBlocked || handlers.canSeek?.() === false) {
                    return;
                }
                event.preventDefault();
                handlers.seekBy(-5);
                return;
            case 'ArrowRight':
                if (arrowsBlocked || handlers.canSeek?.() === false) {
                    return;
                }
                event.preventDefault();
                handlers.seekBy(5);
                return;
            case 'ArrowUp':
                if (arrowsBlocked || handlers.canAdjustVolume?.() === false) {
                    return;
                }
                event.preventDefault();
                handlers.adjustVolume(0.05);
                return;
            case 'ArrowDown':
                if (arrowsBlocked || handlers.canAdjustVolume?.() === false) {
                    return;
                }
                event.preventDefault();
                handlers.adjustVolume(-0.05);
                return;
            case 'm':
            case 'M':
                if (handlers.canAdjustVolume?.() === false) return;
                event.preventDefault();
                handlers.toggleMute();
                return;
        }
    }

}
