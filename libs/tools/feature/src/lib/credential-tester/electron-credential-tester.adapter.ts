import { Injectable } from '@angular/core';
import type {
    CredentialTestBatchOptions,
    CredentialTestInput,
    CredentialTestProgress,
    CredentialTester,
} from '@arm-nator/tools/core';

type CredentialTesterBridge = Pick<
    Window['electron'],
    | 'cancelCredentialTestBatch'
    | 'onCredentialTestProgress'
    | 'startCredentialTestBatch'
>;

function isTerminal(progress: CredentialTestProgress): boolean {
    return (
        progress.lifecycleStatus === 'completed' ||
        progress.lifecycleStatus === 'cancelled' ||
        progress.lifecycleStatus === 'error'
    );
}

@Injectable({ providedIn: 'root' })
export class ElectronCredentialTesterAdapter implements CredentialTester {
    private readonly activeBatches = new Set<string>();
    private readonly listeners = new Map<
        string,
        Set<(progress: CredentialTestProgress) => void>
    >();
    private readonly latest = new Map<string, CredentialTestProgress>();
    private preloadUnsubscribe: (() => void) | undefined;
    private startsInFlight = 0;

    async start(
        inputs: readonly CredentialTestInput[],
        options: CredentialTestBatchOptions
    ): Promise<string> {
        const bridge = this.bridge();
        this.ensureProgressListener(bridge);
        this.startsInFlight += 1;
        try {
            const batchId = await bridge.startCredentialTestBatch({
                inputs,
                options,
            });
            if (!isTerminal(this.latest.get(batchId) ?? this.queuedProgress(batchId))) {
                this.activeBatches.add(batchId);
            }
            return batchId;
        } finally {
            this.startsInFlight -= 1;
            this.releaseProgressListenerIfIdle();
        }
    }

    async cancel(batchId: string): Promise<void> {
        await this.bridge().cancelCredentialTestBatch(batchId);
    }

    subscribe(
        batchId: string,
        listener: (progress: CredentialTestProgress) => void
    ): () => void {
        this.ensureProgressListener(this.bridge());
        const batchListeners = this.listeners.get(batchId) ?? new Set();
        batchListeners.add(listener);
        this.listeners.set(batchId, batchListeners);
        const latest = this.latest.get(batchId);
        if (latest) {
            listener(latest);
        }

        return () => {
            const current = this.listeners.get(batchId);
            current?.delete(listener);
            if (current?.size === 0) {
                this.listeners.delete(batchId);
            }
            this.releaseProgressListenerIfIdle();
        };
    }

    private bridge(): CredentialTesterBridge {
        const bridge = typeof window === 'undefined' ? undefined : window.electron;
        if (
            !bridge ||
            typeof bridge.startCredentialTestBatch !== 'function' ||
            typeof bridge.cancelCredentialTestBatch !== 'function' ||
            typeof bridge.onCredentialTestProgress !== 'function'
        ) {
            throw new Error('Credential testing requires the Arm-Nator desktop runtime.');
        }
        return bridge;
    }

    private ensureProgressListener(bridge: CredentialTesterBridge): void {
        if (this.preloadUnsubscribe) {
            return;
        }
        this.preloadUnsubscribe = bridge.onCredentialTestProgress((progress) => {
            this.latest.set(progress.batchId, progress);
            for (const listener of this.listeners.get(progress.batchId) ?? []) {
                listener(progress);
            }
            if (isTerminal(progress)) {
                this.activeBatches.delete(progress.batchId);
                this.releaseProgressListenerIfIdle();
            }
        });
    }

    private releaseProgressListenerIfIdle(): void {
        if (
            this.startsInFlight !== 0 ||
            this.activeBatches.size !== 0 ||
            this.listeners.size !== 0
        ) {
            return;
        }
        this.preloadUnsubscribe?.();
        this.preloadUnsubscribe = undefined;
    }

    private queuedProgress(batchId: string): CredentialTestProgress {
        return {
            batchId,
            total: 0,
            completed: 0,
            lifecycleStatus: 'queued',
            current: [],
        };
    }
}
