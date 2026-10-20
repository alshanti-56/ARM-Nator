import { ChildProcess } from 'child_process';
import { createConnection, Socket } from 'net';

let nextRequestId = 1;

export function sendMpvIpcCommand(
    socketPath: string,
    command: string,
    args: Array<string | number>,
    createSocket: (path: string) => Socket = createConnection,
    timeoutMs = 3000
): Promise<void> {
    return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        const client = createSocket(socketPath);
        let responseBuffer = '';
        let settled = false;

        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            client.destroy();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        const timeout = setTimeout(() => {
            finish(new Error(`Timed out waiting for MPV ${command} acknowledgement`));
        }, timeoutMs);

        client.on('connect', () => {
            client.write(
                JSON.stringify({
                    command: [command, ...args],
                    request_id: requestId,
                }) + '\n'
            );
        });

        client.on('data', (chunk: Buffer | string) => {
            responseBuffer += chunk.toString();
            const lines = responseBuffer.split('\n');
            responseBuffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.trim()) {
                    continue;
                }
                let response: { request_id?: number; error?: string };
                try {
                    response = JSON.parse(line);
                } catch {
                    finish(new Error('MPV returned malformed IPC data'));
                    return;
                }
                if (response.request_id !== requestId) {
                    continue;
                }
                if (response.error !== 'success') {
                    finish(
                        new Error(
                            `MPV ${command} command failed: ${response.error ?? 'missing acknowledgement status'}`
                        )
                    );
                    return;
                }
                finish();
                return;
            }
        });

        client.on('error', (error) => finish(error));
        client.on('end', () => {
            if (!settled) {
                finish(new Error(`MPV closed IPC before acknowledging ${command}`));
            }
        });
    });
}

export async function terminateMpvProcessAndWait(
    process: ChildProcess,
    gracefulTimeoutMs = 2000,
    forcedTimeoutMs = 2000
): Promise<void> {
    if (hasExited(process)) {
        return;
    }

    const gracefulExit = waitForExit(process, gracefulTimeoutMs);
    try {
        process.kill('SIGTERM');
    } catch {
        // A process can exit between the state check and kill(). The exit
        // acknowledgement below is authoritative.
    }
    try {
        await gracefulExit;
        return;
    } catch (error) {
        if (!(error instanceof MpvProcessExitTimeoutError)) {
            throw error;
        }
    }

    if (hasExited(process)) {
        return;
    }
    const forcedExit = waitForExit(process, forcedTimeoutMs);
    try {
        process.kill('SIGKILL');
    } catch {
        // Wait for the exit event before deciding whether the kill failed.
    }
    await forcedExit;
}

export async function closeMpvSessionProcess(options: {
    sessionId: string;
    process: ChildProcess;
    socketPath: string | null;
    isReusableOwner: boolean;
    activeSessionId: string | null;
    stopPlayback: (socketPath: string) => Promise<void>;
    terminate?: (process: ChildProcess) => Promise<void>;
}): Promise<'reusable-stopped' | 'terminated' | 'superseded'> {
    const terminate = options.terminate ?? terminateMpvProcessAndWait;
    if (
        options.isReusableOwner &&
        options.activeSessionId !== options.sessionId
    ) {
        return 'superseded';
    }

    if (options.isReusableOwner && options.socketPath) {
        try {
            await options.stopPlayback(options.socketPath);
            return 'reusable-stopped';
        } catch {
            // The IPC path is no longer trustworthy. Process exit is a valid
            // release only after the bounded signal-and-wait completes.
            await terminate(options.process);
            return 'terminated';
        }
    }

    await terminate(options.process);
    return 'terminated';
}

function hasExited(process: ChildProcess): boolean {
    return process.exitCode !== null || process.signalCode !== null;
}

class MpvProcessExitTimeoutError extends Error {
    constructor(timeoutMs: number) {
        super(`MPV process did not exit within ${timeoutMs} ms`);
    }
}

function waitForExit(process: ChildProcess, timeoutMs: number): Promise<void> {
    if (hasExited(process)) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        const onExit = (): void => {
            clearTimeout(timeout);
            resolve();
        };
        const timeout = setTimeout(() => {
            process.removeListener('exit', onExit);
            reject(new MpvProcessExitTimeoutError(timeoutMs));
        }, timeoutMs);
        process.once('exit', onExit);
        if (hasExited(process)) {
            onExit();
        }
    });
}
