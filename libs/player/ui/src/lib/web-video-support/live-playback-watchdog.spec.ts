import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { WebVideoControlsAdapter } from '../player-controls/web-video-controls.adapter';
import { LivePlaybackRecovery } from './live-playback-recovery';
import { LivePlaybackWatchdog } from './live-playback-watchdog';

class FakeVideo extends EventTarget {
    currentTime = 0;
    paused = false;
    ended = false;
    readyState = 4;
}

function startWatchdog(
    video: FakeVideo,
    onNoProgress: () => void,
): LivePlaybackWatchdog {
    const watchdog = new LivePlaybackWatchdog();
    watchdog.start(video as unknown as HTMLVideoElement, {
        isLive: () => true,
        onNoProgress,
    });
    return watchdog;
}

function createControlsHarness(): {
    dom: JSDOM;
    adapter: WebVideoControlsAdapter;
    video: HTMLVideoElement;
    setPaused: (paused: boolean) => void;
} {
    const dom = new JSDOM('<!doctype html><video></video>');
    const video = dom.window.document.querySelector(
        'video',
    ) as unknown as HTMLVideoElement;
    let paused = true;
    Object.defineProperty(video, 'paused', { get: () => paused });
    Object.defineProperty(video, 'ended', { get: () => false });
    Object.defineProperty(video, 'readyState', { get: () => 4 });
    video.play = () => {
        paused = false;
        return Promise.resolve();
    };
    video.pause = () => {
        paused = true;
    };
    const adapter = new WebVideoControlsAdapter();
    adapter.attach(video);
    return { dom, adapter, video, setPaused: (value) => (paused = value) };
}

test('does not reconnect after a plain user pause', async () => {
    const video = new FakeVideo();
    let reconnects = 0;
    const watchdog = startWatchdog(video, () => {
        reconnects += 1;
    });

    watchdog.notifyPlaybackIntent('pause');
    video.paused = true;
    video.dispatchEvent(new Event('pause'));
    await new Promise((resolve) => setTimeout(resolve, 4_250));

    assert.equal(reconnects, 0);
    watchdog.destroy();
});

test('shared controls cancel recovery and clear the user-pause latch', async () => {
    const { dom, adapter, setPaused } = createControlsHarness();
    const video = new FakeVideo();
    let reconnects = 0;
    let noProgressSignals = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            reconnects += 1;
        },
    });
    const watchdog = new LivePlaybackWatchdog();
    const intents: string[] = [];
    watchdog.start(video as unknown as HTMLVideoElement, {
        isLive: () => true,
        onNoProgress: (reason) => {
            noProgressSignals += 1;
            recovery.request(reason);
        },
        onUserPause: () => recovery.reset(),
    });
    const unregister = adapter.registerPlaybackIntentListener((intent) => {
        intents.push(intent);
        watchdog.notifyPlaybackIntent(intent);
        if (intent === 'pause') {
            recovery.reset();
        }
    });

    try {
        recovery.request('scheduled recovery');
        setPaused(false);
        adapter.commands.togglePlay();
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.equal(reconnects, 0);
        assert.deepEqual(intents, ['pause']);
        adapter.commands.togglePlay();
        assert.deepEqual(intents, ['pause', 'play']);
        video.ended = true;
        video.dispatchEvent(new Event('ended'));
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.equal(noProgressSignals, 1);
        assert.equal(reconnects, 1);
    } finally {
        unregister();
        watchdog.destroy();
        recovery.destroy();
        adapter.detach();
        dom.window.close();
    }
});

test('shared playback intent listeners can be unregistered', () => {
    const { dom, adapter, setPaused } = createControlsHarness();
    const intents: string[] = [];
    const unregister = adapter.registerPlaybackIntentListener((intent) => {
        intents.push(intent);
    });

    setPaused(false);
    adapter.commands.togglePlay();
    unregister();
    setPaused(true);
    adapter.commands.togglePlay();

    assert.deepEqual(intents, ['pause']);
    adapter.detach();
    dom.window.close();
});

test('fatal recovery is not canceled while buffered media is still playing', async () => {
    let reconnects = 0;
    const recovery = new LivePlaybackRecovery({
        isLive: () => true,
        restart: () => {
            reconnects += 1;
        },
    });

    try {
        recovery.request('fatal HLS error', { cancelOnPlaying: false });
        recovery.markPlaying();
        await new Promise((resolve) => setTimeout(resolve, 350));

        assert.equal(reconnects, 1);
    } finally {
        recovery.destroy();
    }
});

test('reconnects when waiting is followed by a paused live video', async () => {
    const video = new FakeVideo();
    let reconnects = 0;
    const watchdog = startWatchdog(video, () => {
        reconnects += 1;
    });

    try {
        video.paused = true;
        video.dispatchEvent(new Event('waiting'));
        await new Promise((resolve) => setTimeout(resolve, 4_600));

        assert.equal(reconnects, 1);
    } finally {
        watchdog.destroy();
    }
});

test('reconnects when stalled is followed by a paused live video', async () => {
    const video = new FakeVideo();
    let reconnects = 0;
    const watchdog = startWatchdog(video, () => {
        reconnects += 1;
    });

    try {
        video.paused = true;
        video.dispatchEvent(new Event('stalled'));
        await new Promise((resolve) => setTimeout(resolve, 4_600));

        assert.equal(reconnects, 1);
    } finally {
        watchdog.destroy();
    }
});

test('reconnects immediately when a live video ends', () => {
    const video = new FakeVideo();
    let reconnects = 0;
    const watchdog = startWatchdog(video, () => {
        reconnects += 1;
    });

    video.ended = true;
    video.dispatchEvent(new Event('ended'));

    assert.equal(reconnects, 1);
    watchdog.destroy();
});
