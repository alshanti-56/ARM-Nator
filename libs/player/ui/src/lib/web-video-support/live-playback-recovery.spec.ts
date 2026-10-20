import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LivePlaybackRecovery } from './live-playback-recovery';

test('an exhausted retry window waits before reopening a persistently rejected stream', (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let restarts = 0;
    let exhausted = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            restarts += 1;
        },
        getRecoveryBudgetMs: () => 1000,
        onExhausted: () => {
            exhausted += 1;
        },
    });
    try {
        recovery.request('manifest rejected');
        context.mock.timers.tick(250);
        recovery.request('manifest still rejected');
        context.mock.timers.tick(500);
        recovery.request('manifest still rejected');
        context.mock.timers.tick(250);
        assert.equal(restarts, 2);
        assert.equal(exhausted, 1);

        assert.equal(
            recovery.request('watchdog still reports no progress'),
            true
        );
        context.mock.timers.tick(250);
        assert.equal(
            restarts,
            2,
            'an exhausted window cannot immediately reopen the stream'
        );
        context.mock.timers.tick(29_749);
        assert.equal(
            restarts,
            2,
            'a new window must not immediately repeat the failed requests'
        );
        assert.equal(exhausted, 1);
        assert.equal(recovery.request('duplicate watchdog signal'), false);
        context.mock.timers.tick(1);
        context.mock.timers.tick(250);
        assert.equal(restarts, 3, 'automatic recovery resumes after cooldown');
    } finally {
        recovery.destroy();
    }
});

test('stable resumed playback clears an earlier cooldown for a later independent failure', (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let restarts = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            restarts += 1;
        },
        getRecoveryBudgetMs: () => 1000,
    });
    try {
        recovery.request('failed startup');
        context.mock.timers.tick(1000);
        recovery.request('provider unavailable');
        recovery.markPlaying();
        context.mock.timers.tick(15_000);
        recovery.request('a later failure after stable playback');
        context.mock.timers.tick(250);
        assert.equal(restarts, 1);
    } finally {
        recovery.destroy();
    }
});

test('a fatal failure keeps recovery pending when a cooldown started from the watchdog', (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let restarts = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            restarts += 1;
        },
        getRecoveryBudgetMs: () => 1000,
    });
    try {
        recovery.request('failed startup');
        context.mock.timers.tick(1000);
        recovery.request('watchdog detects no progress');
        recovery.request('fatal network failure', { cancelOnPlaying: false });
        context.mock.timers.tick(30_000);
        recovery.markPlaying();
        context.mock.timers.tick(250);
        assert.equal(
            restarts,
            1,
            'buffered playback cannot cancel a fatal reconnect after cooldown'
        );
    } finally {
        recovery.destroy();
    }
});

test('explicit reset cancels cooldown and permits an immediate new playback attempt', (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let restarts = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            restarts += 1;
        },
        getRecoveryBudgetMs: () => 1000,
    });
    try {
        recovery.request('failed startup');
        context.mock.timers.tick(1000);
        recovery.request('waiting for provider');
        recovery.reset();
        recovery.request('user retries');
        context.mock.timers.tick(250);
        assert.equal(restarts, 1);
        context.mock.timers.tick(30_000);
        assert.equal(
            restarts,
            1,
            'the canceled cooldown cannot reopen the old attempt'
        );
    } finally {
        recovery.destroy();
    }
});

test('destroy cancels an exhausted window queued for later recovery', (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let restarts = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            restarts += 1;
        },
        getRecoveryBudgetMs: () => 1000,
    });
    recovery.request('failed startup');
    context.mock.timers.tick(1000);
    recovery.request('provider still unavailable');
    recovery.destroy();
    context.mock.timers.tick(60_000);
    assert.equal(restarts, 0);
});
