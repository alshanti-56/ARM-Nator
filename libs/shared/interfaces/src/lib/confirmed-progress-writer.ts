export interface ConfirmedProgressSample {
    positionSeconds: number;
    durationSeconds?: number | null;
    status: string;
    seeking?: boolean;
}
export interface ConfirmedProgress {
    successfulAt?: number;
    positionSeconds: number;
    durationSeconds?: number;
    confirmedAt: number;
}
export interface ConfirmedProgressWriterConfig<T> {
    save(identity: T, progress: ConfirmedProgress): Promise<void>;
    onError?(error: unknown): void;
    onConfirmed?(identity: T, progress: ConfirmedProgress): void;
    onSaved?(identity: T, progress: ConfirmedProgress): void;
    now?(): number;
}

/** One confirmed clock, one ordered persistence queue; cleanup never depends on a successful write. */
export class ConfirmedProgressWriter<T> {
    private generation = 0;
    private active: { identity: T; progress: ConfirmedProgress; revision: number } | null = null;
    private identity: T | null = null;
    private revision = 0;
    private queuedRevision = 0;
    private lastSaveAt = -Infinity;
    private lastConfirmedAt = 0;
    private previousStatus = '';
    private wasSeeking = false;
    private advancingSeconds = 0;
    private successfulAt: number | undefined;
    private lastSample: { at: number; position: number; playing: boolean } | null = null;
    private readonly pending = new Map<T, ConfirmedProgress>();
    private draining: Promise<void> | null = null;

    constructor(private readonly config: ConfirmedProgressWriterConfig<T>) {}

    begin(identity: T): number {
        void this.flush();
        this.identity = identity;
        this.active = null;
        this.lastSaveAt = -Infinity;
        this.previousStatus = '';
        this.wasSeeking = false;
        this.advancingSeconds = 0; this.successfulAt = undefined; this.lastSample = null;
        return ++this.generation;
    }

    observe(generation: number, sample: ConfirmedProgressSample): boolean {
        if (generation !== this.generation || this.identity === null) return false;
        if (sample.seeking) { this.wasSeeking = true; this.lastSample = null; return false; }
        if (!['playing', 'paused', 'ended'].includes(sample.status) || !Number.isFinite(sample.positionSeconds) || sample.positionSeconds < 0) { this.lastSample = null; return false; }
        const now = this.config.now?.() ?? Date.now();
        const previous = this.lastSample;
        const wallSeconds = previous ? (now - previous.at) / 1000 : 0;
        const mediaSeconds = previous ? sample.positionSeconds - previous.position : 0;
        if (previous?.playing && sample.status === 'playing' && wallSeconds > 0 && mediaSeconds > 0 && mediaSeconds <= wallSeconds * 1.5 + 0.5)
            this.advancingSeconds += Math.min(wallSeconds, mediaSeconds);
        this.lastSample = { at: now, position: sample.positionSeconds, playing: sample.status === 'playing' };
        const confirmedSuccess = this.successfulAt === undefined && this.advancingSeconds >= 10;
        if (confirmedSuccess) this.successfulAt = now;
        const durationSeconds = Number.isFinite(sample.durationSeconds) && (sample.durationSeconds ?? 0) > 0 ? sample.durationSeconds as number : undefined;
        const changed = confirmedSuccess || !this.active || this.active.progress.positionSeconds !== sample.positionSeconds || this.active.progress.durationSeconds !== durationSeconds;
        if (changed) {
            this.lastConfirmedAt = Math.max(now, this.lastConfirmedAt + 1);
            const progress = { positionSeconds: sample.positionSeconds, durationSeconds, confirmedAt: this.lastConfirmedAt, ...(this.successfulAt !== undefined ? { successfulAt: this.successfulAt } : {}) };
            this.active = { identity: this.identity, progress, revision: ++this.revision };
            this.config.onConfirmed?.(this.identity, progress);
        }
        const force = confirmedSuccess || this.wasSeeking || (sample.status === 'paused' && this.previousStatus !== 'paused') || sample.status === 'ended';
        this.wasSeeking = false;
        this.previousStatus = sample.status;
        if (force || now - this.lastSaveAt >= 15_000) void this.flush();
        return true;
    }

    end(): void {
        void this.flush();
        this.identity = null;
        this.active = null;
        this.generation++;
    }

    flush(): Promise<void> {
        const active = this.active;
        if (active && active.revision !== this.queuedRevision) {
            // Coalesce pending writes for one version. Retention stays bounded if disk IPC hangs.
            if (!this.pending.has(active.identity) && this.pending.size >= 32) {
                this.config.onError?.(new Error('Playback progress queue is full'));
            } else {
                this.pending.set(active.identity, active.progress);
                this.queuedRevision = active.revision;
                this.lastSaveAt = this.config.now?.() ?? Date.now();
                this.startDrain();
            }
        }
        return this.settled();
    }

    settled(): Promise<void> { return this.draining ?? Promise.resolve(); }

    private startDrain(): void {
        if (this.draining) return;
        // Defer to keep the promise installed before a synchronous save rejection.
        this.draining = Promise.resolve().then(async () => {
            while (this.pending.size) {
                const entry = this.pending.entries().next().value;
                if (!entry) break;
                const [identity, progress] = entry;
                this.pending.delete(identity);
                try { await this.config.save(identity, progress); this.config.onSaved?.(identity, progress); }
                catch (error) { this.config.onError?.(error); }
            }
        }).finally(() => {
            this.draining = null;
            if (this.pending.size) this.startDrain();
        });
    }
}
