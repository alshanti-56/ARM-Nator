import { parentPort } from 'node:worker_threads';
import { requestWithValidatedRedirects } from '../util/validated-axios';
import type { CredentialTestBatchStartRequest } from '@arm-nator/shared/interfaces';
import {
    runCredentialTestBatch,
    type CredentialTestRequest,
} from './credential-tester.worker-core';
import {
    CredentialTesterWorkerIncomingMessage,
    CredentialTesterWorkerOutgoingMessage,
    isCredentialTesterWorkerStartRequest,
} from './credential-tester.worker.types';

if (!parentPort) {
    throw new Error('Credential tester worker must be started with a parent port');
}

let activeBatch:
    | {
          batchId: string;
          controller: AbortController;
      }
    | undefined;

function postMessage(message: CredentialTesterWorkerOutgoingMessage): void {
    parentPort?.postMessage(message);
}

const request: CredentialTestRequest = async (url, config) =>
    requestWithValidatedRedirects(url, config, { allowPrivateNetworks: true });

async function execute(
    batchId: string,
    requestPayload: CredentialTestBatchStartRequest,
    controller: AbortController
): Promise<void> {
    await runCredentialTestBatch(
        requestPayload.inputs,
        requestPayload.options,
        controller.signal,
        {
            onItemStarted: (id, startedAt) => {
                postMessage({ type: 'item-started', batchId, id, startedAt });
            },
            onItemResult: (result) => {
                postMessage({ type: 'item-result', batchId, result });
            },
        },
        { request }
    );
    postMessage({ type: 'complete', batchId });
}

function isIncomingMessage(value: unknown): value is CredentialTesterWorkerIncomingMessage {
    return (
        Boolean(value) &&
        typeof value === 'object' &&
        'type' in value &&
        ((value as { type?: unknown }).type === 'cancel' ||
            (value as { type?: unknown }).type === 'start')
    );
}

parentPort.on('message', (message: unknown) => {
    if (!isIncomingMessage(message)) {
        return;
    }
    if (message.type === 'cancel') {
        if (activeBatch?.batchId === message.batchId) {
            activeBatch.controller.abort();
        }
        return;
    }

    if (
        activeBatch ||
        typeof message.batchId !== 'string' ||
        !isCredentialTesterWorkerStartRequest(message.request)
    ) {
        return;
    }

    const controller = new AbortController();
    activeBatch = { batchId: message.batchId, controller };
    void execute(message.batchId, message.request, controller)
        .catch(() => {
            postMessage({ type: 'fatal', batchId: message.batchId });
        })
        .finally(() => {
            activeBatch = undefined;
        });
});

postMessage({ type: 'ready' });
