import { isPlaybackShortcutBlocked } from './playback-shortcut-focus';

export interface ControlsShortcutHandlers {
    isAvailable: () => boolean;
    canHandleEscape?: () => boolean;
    canTogglePaused: () => boolean;
    canSeek: () => boolean;
    canAdjustVolume: () => boolean;
    canToggleFullscreen: () => boolean;
    onEscape: () => void;
    togglePaused: () => void;
    toggleFullscreen: () => void;
    seekBy: (deltaSeconds: number) => void;
    adjustVolume: (delta: number) => void;
    toggleMute: () => void;
}

export class ControlsShortcuts {
    private static readonly instances = new Set<ControlsShortcuts>();
    private static active: ControlsShortcuts | null = null;

    private handlers: ControlsShortcutHandlers | null = null;
    private readonly listener = (event: KeyboardEvent) => this.handle(event);

    attach(handlers: ControlsShortcutHandlers): void {
        this.handlers = handlers;
        ControlsShortcuts.instances.add(this);
        ControlsShortcuts.active ??= this;
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.listener);
        }
    }

    activate(): void {
        if (this.handlers) {
            ControlsShortcuts.active = this;
        }
    }

    detach(): void {
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.listener);
        }
        this.handlers = null;
        ControlsShortcuts.instances.delete(this);
        if (ControlsShortcuts.active === this) {
            ControlsShortcuts.active = ControlsShortcuts.lastAttachedInstance();
        }
    }

    private handle(event: KeyboardEvent): void {
        const handlers = this.handlers;
        if (!handlers || isPlaybackShortcutBlocked(event) || ControlsShortcuts.resolvePlaybackOwner(event.key === 'Escape') !== this) {
            return;
        }

        if (event.key === 'Escape') {
            handlers.onEscape();
            return;
        }

        switch (event.key) {
            case ' ':
            case 'k':
            case 'K':
                if (!handlers.canTogglePaused()) {
                    return;
                }
                event.preventDefault();
                handlers.togglePaused();
                return;
            case 'f':
            case 'F':
                if (!handlers.canToggleFullscreen()) {
                    return;
                }
                event.preventDefault();
                handlers.toggleFullscreen();
                return;
            case 'ArrowLeft':
                if (!handlers.canSeek()) {
                    return;
                }
                event.preventDefault();
                handlers.seekBy(-5);
                return;
            case 'ArrowRight':
                if (!handlers.canSeek()) {
                    return;
                }
                event.preventDefault();
                handlers.seekBy(5);
                return;
            case 'ArrowUp':
                if (!handlers.canAdjustVolume()) {
                    return;
                }
                event.preventDefault();
                handlers.adjustVolume(0.05);
                return;
            case 'ArrowDown':
                if (!handlers.canAdjustVolume()) {
                    return;
                }
                event.preventDefault();
                handlers.adjustVolume(-0.05);
                return;
            case 'm':
            case 'M':
                if (!handlers.canAdjustVolume()) {
                    return;
                }
                event.preventDefault();
                handlers.toggleMute();
                return;
        }
    }

    private static resolvePlaybackOwner(forEscape = false): ControlsShortcuts | null {
        const available = (instance: ControlsShortcuts): boolean => Boolean(instance.handlers && (instance.handlers.isAvailable() || (forEscape && instance.handlers.canHandleEscape?.())));
        if (this.active && available(this.active)) {
            return this.active;
        }

        let fallback: ControlsShortcuts | null = null;
        for (const instance of this.instances) {
            if (available(instance)) {
                fallback = instance;
            }
        }
        this.active = fallback;
        return fallback;
    }

    private static lastAttachedInstance(): ControlsShortcuts | null {
        let last: ControlsShortcuts | null = null;
        for (const instance of this.instances) {
            last = instance;
        }
        return last;
    }
}
