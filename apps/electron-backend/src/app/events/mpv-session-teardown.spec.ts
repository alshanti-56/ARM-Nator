import { EventEmitter } from 'node:events';
import { ChildProcess } from 'node:child_process';
import { Socket } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeMpvSessionProcess,
    sendMpvIpcCommand,
    terminateMpvProcessAndWait,
} from './mpv-session-teardown';

class FakeSocket extends EventEmitter {
    written = '';
    destroyed = false;

    write(value: string): boolean {
        this.written += value;
        return true;
    }

    destroy(): this {
        this.destroyed = true;
        return this;
    }
}

class FakeChildProcess extends EventEmitter {
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    signals: NodeJS.Signals[] = [];
    exitOnSignal: NodeJS.Signals | null = 'SIGTERM';

    kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
        this.signals.push(signal);
        if (this.exitOnSignal === signal) {
            setImmediate(() => {
                this.signalCode = signal;
                this.emit('exit', null, signal);
            });
        }
        return true;
    }
}

test('MPV IPC close resolves only after matching successful command acknowledgement', async () => {
    const socket = new FakeSocket();
    let settled = false;
    const command = sendMpvIpcCommand(
        '/tmp/mpv-test.sock',
        'stop',
        [],
        () => socket as unknown as Socket,
        1000
    ).then(() => {
        settled = true;
    });

    socket.emit('connect');
    const request = JSON.parse(socket.written.trim());
    assert.deepEqual(request.command, ['stop']);
    assert.equal(typeof request.request_id, 'number');
    assert.equal(settled, false, 'connect is not an MPV command acknowledgement');

    socket.emit(
        'data',
        Buffer.from(
            `${JSON.stringify({ request_id: request.request_id + 1, error: 'success' })}\n` +
                `${JSON.stringify({ request_id: request.request_id, error: 'success' })}\n`
        )
    );
    await command;
    assert.equal(socket.destroyed, true);
});

test('MPV IPC close rejects a negative acknowledgement', async () => {
    const socket = new FakeSocket();
    const command = sendMpvIpcCommand(
        '/tmp/mpv-test.sock',
        'stop',
        [],
        () => socket as unknown as Socket,
        1000
    );
    socket.emit('connect');
    const request = JSON.parse(socket.written.trim());
    socket.emit(
        'data',
        Buffer.from(
            `${JSON.stringify({ request_id: request.request_id, error: 'property unavailable' })}\n`
        )
    );
    await assert.rejects(command, /MPV stop command failed/);
});

test('MPV process teardown waits for graceful exit and escalates only after timeout', async () => {
    const process = new FakeChildProcess();
    await terminateMpvProcessAndWait(
        process as unknown as ChildProcess,
        100,
        100
    );
    assert.deepEqual(process.signals, ['SIGTERM']);
    assert.equal(process.signalCode, 'SIGTERM');

    const escalated = new FakeChildProcess();
    escalated.exitOnSignal = 'SIGKILL';
    await terminateMpvProcessAndWait(
        escalated as unknown as ChildProcess,
        5,
        100
    );
    assert.deepEqual(escalated.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(escalated.signalCode, 'SIGKILL');
});

test('MPV process teardown fails when the process does not exit after SIGKILL', async () => {
    const process = new FakeChildProcess();
    process.exitOnSignal = null;
    await assert.rejects(
        terminateMpvProcessAndWait(
            process as unknown as ChildProcess,
            5,
            5
        ),
        /MPV process did not exit within 5 ms/
    );
    assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
});

test('reusable MPV close stops current media and keeps the process alive', async () => {
    const process = new FakeChildProcess();
    let stoppedSocket: string | null = null;
    const outcome = await closeMpvSessionProcess({
        sessionId: 'current',
        process: process as unknown as ChildProcess,
        socketPath: '/tmp/reusable.sock',
        isReusableOwner: true,
        activeSessionId: 'current',
        stopPlayback: async (socketPath) => {
            stoppedSocket = socketPath;
        },
    });

    assert.equal(outcome, 'reusable-stopped');
    assert.equal(stoppedSocket, '/tmp/reusable.sock');
    assert.deepEqual(process.signals, []);
});

test('stale reusable MPV close cannot stop a newer stream', async () => {
    const process = new FakeChildProcess();
    let stopCalls = 0;
    let terminateCalls = 0;
    const outcome = await closeMpvSessionProcess({
        sessionId: 'old',
        process: process as unknown as ChildProcess,
        socketPath: '/tmp/reusable.sock',
        isReusableOwner: true,
        activeSessionId: 'new',
        stopPlayback: async () => {
            stopCalls += 1;
        },
        terminate: async () => {
            terminateCalls += 1;
        },
    });

    assert.equal(outcome, 'superseded');
    assert.equal(stopCalls, 0);
    assert.equal(terminateCalls, 0);
});

test('reusable MPV close terminates and waits when stop is not acknowledged', async () => {
    const process = new FakeChildProcess();
    const outcome = await closeMpvSessionProcess({
        sessionId: 'current',
        process: process as unknown as ChildProcess,
        socketPath: '/tmp/reusable.sock',
        isReusableOwner: true,
        activeSessionId: 'current',
        stopPlayback: async () => {
            throw new Error('socket closed before acknowledgement');
        },
    });

    assert.equal(outcome, 'terminated');
    assert.deepEqual(process.signals, ['SIGTERM']);
    assert.equal(process.signalCode, 'SIGTERM');
});

test('non-reusable MPV close waits for process exit after termination', async () => {
    const process = new FakeChildProcess();
    const outcome = await closeMpvSessionProcess({
        sessionId: 'current',
        process: process as unknown as ChildProcess,
        socketPath: '/tmp/non-reusable.sock',
        isReusableOwner: false,
        activeSessionId: 'current',
        stopPlayback: async () => {
            assert.fail('non-reusable close must terminate the process');
        },
    });

    assert.equal(outcome, 'terminated');
    assert.deepEqual(process.signals, ['SIGTERM']);
    assert.equal(process.signalCode, 'SIGTERM');
});
