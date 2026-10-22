import type { AutoPlaybackFormat, VideoPlayer } from '@arm-nator/shared/interfaces';

/** Display-safe selection history: never contains stream paths, queries or credentials. */
export interface AutomaticPlaybackAttempt {
    readonly number: number;
    readonly host: string;
    readonly format: AutoPlaybackFormat;
    readonly engine: VideoPlayer | null;
    readonly outcome: 'preparing' | 'playing' | 'verified' | 'failed' | 'cancelled';
    readonly verified: boolean;
    readonly reason?: string;
}

export interface AutomaticPlaybackActivity {
    readonly status: 'idle' | 'preparing' | 'recovering' | 'playing' | 'verified' | 'stopped' | 'cancelled';
    readonly attempts: readonly AutomaticPlaybackAttempt[];
    readonly stopReason?: string;
}

/** Immutable, bounded and display-safe history for a single viewing selection. */
export class AutomaticPlaybackActivityLog {
    private value: AutomaticPlaybackActivity = { status: 'idle', attempts: [] };
    private nextNumber = 0;
    constructor(private readonly observer?: (activity: AutomaticPlaybackActivity) => void) {}

    reset(): void {
        this.nextNumber = 0;
        this.publish({ status: 'preparing', attempts: [] });
    }
    start(hostUrl: string, format: AutoPlaybackFormat, reason?: string): void {
        let host = 'Unknown host';
        try { host = new URL(hostUrl).host || host; } catch { /* Display no raw input. */ }
        const attempt: AutomaticPlaybackAttempt = {
            number: ++this.nextNumber, host, format, engine: null, outcome: 'preparing', verified: false, reason,
        };
        this.publish({ status: 'preparing', attempts: [...this.value.attempts, attempt].slice(-20) });
    }
    update(update: Partial<Pick<AutomaticPlaybackAttempt, 'format' | 'engine' | 'outcome' | 'verified' | 'reason'>>,
        status: AutomaticPlaybackActivity['status'] = this.value.status): void {
        const attempts = this.value.attempts;
        if (!attempts.length) return;
        const current = attempts[attempts.length - 1];
        if (status === this.value.status && Object.entries(update).every(([key, value]) => current[key as keyof AutomaticPlaybackAttempt] === value)) return;
        this.publish({ status, attempts: [...attempts.slice(0, -1), { ...attempts[attempts.length - 1], ...update }] });
    }
    stop(reason: string): void {
        this.publish({ ...this.value, status: 'stopped', stopReason: reason });
    }
    cancel(): void {
        if (['idle', 'stopped', 'cancelled'].includes(this.value.status)) return;
        const latest = this.value.attempts.at(-1);
        if (latest && !latest.verified && latest.outcome !== 'failed') this.update({ outcome: 'cancelled' }, 'cancelled');
        this.publish({ ...this.value, status: 'cancelled', stopReason: 'Playback stopped or closed.' });
    }
    private publish(value: AutomaticPlaybackActivity): void {
        this.value = value;
        try { this.observer?.(value); } catch { /* History must never interrupt viewing. */ }
    }
}
