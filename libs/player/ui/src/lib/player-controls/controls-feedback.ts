import { signal } from '@angular/core';

/**
 * Transient feedback overlay shown when the user adjusts volume/seek/mute via
 * keyboard. Caller calls flash() with an icon + label; auto-clears after the
 * given duration.
 */
export class ControlsFeedback {
    readonly current = signal<{
        icon: string;
        label: string;
        key: number;
    } | null>(null);

    private timer: number | null = null;
    private nextKey = 0;

    flash(icon: string, label: string, durationMs = 700): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.nextKey += 1;
        this.current.set({ icon, label, key: this.nextKey });
        this.timer = window.setTimeout(() => {
            this.current.set(null);
            this.timer = null;
        }, durationMs);
    }

    dispose(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
}
