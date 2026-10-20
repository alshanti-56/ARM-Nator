import type { AutoPlaybackPreparationResult, PlaybackRequestPolicy } from '@arm-nator/shared/interfaces';

export interface AutomaticPreparationOptions {
    processingMode?: 'direct' | 'proxy' | 'remux' | 'convert';
    startTime?: number;
    audioOnly?: boolean;
}
export interface AutomaticPlaybackSessionDependencies {
    prepare(url: string, headers: Record<string, string>, isLive: boolean, attemptId: string, policy?: PlaybackRequestPolicy, options?: AutomaticPreparationOptions): Promise<AutoPlaybackPreparationResult>;
    cancel(attemptId: string): Promise<void>;
    release(sessionId: string): Promise<void>;
    registerTeardown(dispose: () => Promise<void>): () => void;
}

/** Owns the retained first response, including a result that arrives after close. */
export class AutomaticPlaybackSession {
    private readonly attemptId = crypto.randomUUID();
    private pending: Promise<AutoPlaybackPreparationResult> | null = null;
    private disposed = false;
    private disposal: Promise<void> | null = null;
    private unregister: (() => void) | null = null;

    constructor(private readonly dependencies: AutomaticPlaybackSessionDependencies) {}

    async prepare(url: string, headers: Record<string, string>, isLive: boolean, policy?: PlaybackRequestPolicy, options?: AutomaticPreparationOptions): Promise<AutoPlaybackPreparationResult> {
        if (this.disposed || this.pending) throw new Error('Playback preparation is no longer available.');
        this.unregister = this.dependencies.registerTeardown(() => this.dispose());
        this.pending = this.dependencies.prepare(url, headers, isLive, this.attemptId, policy, options);
        const result = await this.pending;
        return this.disposed
            ? { ok: false, error: { code: 'cancelled', status: null, message: 'Playback preparation was cancelled.' } }
            : result;
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal;
        this.disposed = true;
        this.disposal = this.releaseOwnedResponse().then(() => {
            this.unregister?.();
            this.unregister = null;
        }).catch((error: unknown) => {
            this.disposal = null;
            throw error;
        });
        return this.disposal;
    }

    private async releaseOwnedResponse(): Promise<void> {
        const errors: unknown[] = [];
        try { await this.dependencies.cancel(this.attemptId); }
        catch (error) { errors.push(error); }
        const result = await this.pending?.catch(() => undefined);
        if (result?.ok) {
            try { await this.dependencies.release(result.session.id); }
            catch (error) { errors.push(error); }
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
            const details = errors.map(error => error instanceof Error ? error.message : String(error)).join('; ');
            throw new AggregateError(errors, `Playback release failed: ${details}`);
        }
    }
}
