import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackExitCoordinator } from './playback-exit-coordinator';

test('normal quit waits for confirmed progress before releasing native players/database', async () => {
    let complete!: () => void;
    const flush = new Promise<void>(resolve => { complete = resolve; });
    const coordinator = new PlaybackExitCoordinator(() => flush);
    let prevented = 0, resumed = 0;
    assert.equal(coordinator.deferQuit({ preventDefault: () => { prevented++; } }, () => { resumed++; }), true);
    assert.equal(coordinator.deferQuit({ preventDefault: () => { prevented++; } }, () => { resumed++; }), true);
    assert.equal(resumed, 0);
    complete(); await flush; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(resumed, 1);
    assert.equal(coordinator.deferQuit({ preventDefault: () => { prevented++; } }, () => { resumed++; }), false);
    assert.equal(prevented, 2);
});

test('failed or hung persistence does not trap a normal window close', async () => {
    for (const request of [() => Promise.reject(new Error('disk full')), () => new Promise<void>(() => undefined)]) {
        const errors: unknown[] = [];
        const coordinator = new PlaybackExitCoordinator(request, { timeoutMs: 10, onError: error => errors.push(error) });
        let resumed = 0;
        assert.equal(coordinator.deferWindowClose({ preventDefault: () => undefined }, () => { resumed++; }), true);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(resumed, 1);
        assert.equal(errors.length, 1);
        assert.equal(coordinator.deferWindowClose({ preventDefault: () => undefined }, () => { resumed++; }), false);
    }
});
