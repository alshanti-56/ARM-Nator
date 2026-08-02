import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { app, ipcMain, type WebContents } from 'electron';
import { Worker } from 'node:worker_threads';
import type {
    CredentialTestProgress,
} from '@arm-nator/shared/interfaces';
import { resolveWorkerRuntimeBootstrap } from '../workers/worker-runtime-paths';
import {
    isCredentialTesterWorkerStartRequest,
    type CredentialTesterWorkerOutgoingMessage,
} from '../workers/credential-tester.worker.types';
import { CredentialTesterBatchLifecycle } from './credential-tester.lifecycle';

type TerminalReason = 'cancelled' | 'completed' | 'error';

const CREDENTIAL_TESTER_IPC = {
    cancel: 'IPTV_CREDENTIAL_TEST_CANCEL',
    progress: 'IPTV_CREDENTIAL_TEST_PROGRESS',
    start: 'IPTV_CREDENTIAL_TEST_START',
} as const;

type ActiveCredentialTestBatch = {
    readonly batchId: string;
    readonly lifecycle: CredentialTesterBatchLifecycle;
    readonly sender: WebContents;
    readonly senderId: number;
    readonly worker: Worker;
    cleanupPromise?: Promise<void>;
    onSenderDestroyed: () => void;
};

const activeBatches = new Map<string, ActiveCredentialTestBatch>();
const activeBatchBySender = new Map<number, string>();

function resolveCredentialTesterWorker(): Worker {
    const bootstrap = resolveWorkerRuntimeBootstrap({
        isPackaged: app.isPackaged,
        workerFilename: 'credential-tester.worker.js',
        developmentWorkerDir: __dirname + '/workers',
        resourcesPath: (process as NodeJS.Process & { resourcesPath?: string })
            .resourcesPath,
        appPath: app.getAppPath(),
    });

    return new Worker(pathToFileURL(bootstrap.workerPath), {
        workerData: {
            nativeModuleSearchPaths: bootstrap.nativeModuleSearchPaths,
        },
    });
}

function emitProgress(sender: WebContents, progress: CredentialTestProgress): void {
    if (sender.isDestroyed()) {
        return;
    }
    sender.send(CREDENTIAL_TESTER_IPC.progress, progress);
}

function cleanUp(active: ActiveCredentialTestBatch): Promise<void> {
    active.cleanupPromise ??= (async () => {
        if (activeBatches.get(active.batchId) === active) {
            activeBatches.delete(active.batchId);
        }
        if (activeBatchBySender.get(active.senderId) === active.batchId) {
            activeBatchBySender.delete(active.senderId);
        }
        active.sender.removeListener('destroyed', active.onSenderDestroyed);
        active.worker.removeAllListeners();
        await active.worker.terminate().catch(() => undefined);
    })();
    return active.cleanupPromise;
}

function finalizeBatch(
    active: ActiveCredentialTestBatch,
    reason: TerminalReason
): Promise<void> {
    const terminal = active.lifecycle.finish(reason);
    if (terminal) {
        emitProgress(active.sender, terminal);
    }
    return cleanUp(active);
}

function isWorkerMessage(value: unknown): value is CredentialTesterWorkerOutgoingMessage {
    return Boolean(value) && typeof value === 'object' && 'type' in value;
}

function handleWorkerMessage(
    active: ActiveCredentialTestBatch,
    message: unknown
): void {
    if (!isWorkerMessage(message) || active.lifecycle.isTerminal) {
        return;
    }

    if (message.type === 'ready') {
        return;
    }
    if (message.batchId !== active.batchId) {
        return;
    }
    if (message.type === 'item-started') {
        if (typeof message.id !== 'string' || typeof message.startedAt !== 'number') {
            return;
        }
        const progress = active.lifecycle.markTesting(message.id, message.startedAt);
        if (progress) {
            emitProgress(active.sender, progress);
        }
        return;
    }
    if (message.type === 'item-result') {
        if (!message.result || typeof message.result !== 'object') {
            return;
        }
        const progress = active.lifecycle.recordResult(message.result);
        if (progress) {
            emitProgress(active.sender, progress);
        }
        return;
    }
    if (message.type === 'complete') {
        void finalizeBatch(active, 'completed');
        return;
    }
    if (message.type === 'fatal') {
        void finalizeBatch(active, 'error');
    }
}

function getOwnedBatch(sender: WebContents, batchId: unknown): ActiveCredentialTestBatch {
    if (typeof batchId !== 'string') {
        throw new Error('Credential test batch was not found.');
    }
    const active = activeBatches.get(batchId);
    if (!active || active.senderId !== sender.id) {
        throw new Error('Credential test batch was not found.');
    }
    return active;
}

ipcMain.handle(CREDENTIAL_TESTER_IPC.start, async (event, request) => {
    if (!isCredentialTesterWorkerStartRequest(request)) {
        throw new Error('Invalid credential test batch request.');
    }
    if (activeBatchBySender.has(event.sender.id)) {
        throw new Error('A credential test batch is already running.');
    }

    let worker: Worker;
    try {
        worker = resolveCredentialTesterWorker();
    } catch {
        throw new Error('Credential test worker is unavailable.');
    }

    const batchId = randomUUID();
    const lifecycle = new CredentialTesterBatchLifecycle(batchId, request.inputs);
    const active: ActiveCredentialTestBatch = {
        batchId,
        lifecycle,
        sender: event.sender,
        senderId: event.sender.id,
        worker,
        onSenderDestroyed: () => {
            void finalizeBatch(active, 'cancelled');
        },
    };

    activeBatches.set(batchId, active);
    activeBatchBySender.set(event.sender.id, batchId);
    event.sender.once('destroyed', active.onSenderDestroyed);
    worker.on('message', (message: unknown) => handleWorkerMessage(active, message));
    worker.once('error', () => {
        void finalizeBatch(active, 'error');
    });
    worker.once('exit', () => {
        if (!active.lifecycle.isTerminal) {
            void finalizeBatch(active, 'error');
        }
    });

    emitProgress(event.sender, lifecycle.snapshot());
    try {
        worker.postMessage({ type: 'start', batchId, request });
    } catch {
        await finalizeBatch(active, 'error');
        throw new Error('Credential test worker could not start.');
    }
    return batchId;
});

ipcMain.handle(CREDENTIAL_TESTER_IPC.cancel, async (event, batchId) => {
    const active = getOwnedBatch(event.sender, batchId);
    try {
        active.worker.postMessage({ type: 'cancel', batchId: active.batchId });
    } catch {
        // Worker termination in finalizeBatch remains authoritative.
    }
    await finalizeBatch(active, 'cancelled');
});

export async function shutdownCredentialTesterBatches(): Promise<void> {
    await Promise.all(
        [...activeBatches.values()].map((active) => finalizeBatch(active, 'cancelled'))
    );
}

export default class CredentialTesterEvents {
    static bootstrapCredentialTesterEvents(): Electron.IpcMain {
        return ipcMain;
    }
}
