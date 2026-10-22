import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
    PlaybackAttemptManager,
    classifyPlaybackFailure,
} from './playback-attempt-manager';

function createHarness(kind: 'live' | 'vod' = 'live') {
    let now = 0;
    const manager = new PlaybackAttemptManager({ now: () => now, random: () => 0.5 });
    manager.startSelection({ selectionId: 'selection-a', kind });
    return { manager, setNow: (value: number) => { now = value; }, advance: (value: number) => { now += value; } };
}

test('uses per-attempt and total recovery deadlines for live and VOD', () => {
    const live = createHarness('live');
    assert.deepEqual(live.manager.startAttempt(), {
        started: true, attemptNumber: 1, attemptDeadlineAtMs: 12_000, deadlineAtMs: 30_000,
        remainingAttemptMs: 12_000, remainingMs: 30_000,
    });

    const vod = createHarness('vod');
    assert.deepEqual(vod.manager.startAttempt(), {
        started: true, attemptNumber: 1, attemptDeadlineAtMs: 20_000, deadlineAtMs: 60_000,
        remainingAttemptMs: 20_000, remainingMs: 60_000,
    });
});

test('allows at most three attempts per episode', () => {
    const { manager } = createHarness();
    for (let attempt = 1; attempt <= 3; attempt++) {
        assert.equal(manager.startAttempt().attemptNumber, attempt);
        const decision = manager.recordFailure({ code: 'network-error' });
        assert.equal(decision.action, attempt < 3 ? 'retry' : 'stop');
    }
    assert.equal(manager.startAttempt().reason, 'attempt-limit');
});

test('classifies account and transport HTTP statuses before diagnostic codes', () => {
    assert.equal(classifyPlaybackFailure({ status: 401, code: 'unsupported-codec' }), 'account');
    assert.equal(classifyPlaybackFailure({ status: 403 }), 'account');
    for (const status of [408, 429, 500, 503]) {
        assert.equal(classifyPlaybackFailure({ status }), 'transport');
    }
    assert.equal(classifyPlaybackFailure({ code: 'unsupported-container' }), 'decoder');
    assert.equal(classifyPlaybackFailure({ code: 'unsupported-codec' }), 'decoder');
    assert.equal(classifyPlaybackFailure({ code: 'media-decode-error' }), 'decoder');
    assert.equal(classifyPlaybackFailure({ code: 'autoplay-blocked' }), 'autoplay');
    assert.equal(classifyPlaybackFailure({ code: 'license-error' }), 'drm');
    assert.equal(classifyPlaybackFailure({ code: 'resource-not-found' }), 'resource');
    assert.equal(classifyPlaybackFailure({ code: 'mystery' }), 'unknown');
    assert.equal(classifyPlaybackFailure({ status: 458, code: 'http-error' }), 'unknown');
    assert.equal(classifyPlaybackFailure({ code: 'provider-rejected' }), 'account');
    assert.equal(classifyPlaybackFailure({ code: 'startup-timeout' }), 'transport');
    assert.equal(classifyPlaybackFailure({ code: 'drm-or-encryption' }), 'drm');
    assert.equal(classifyPlaybackFailure({ code: 'browser-access-error' }), 'resource');
});

test('uses one then three second retry delays with jitter and honors Retry-After', () => {
    const { manager, advance } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).delayMs, 1_000);
    advance(1_000);
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).delayMs, 3_000);

    const retryAfter = createHarness();
    retryAfter.manager.startAttempt();
    retryAfter.manager.recordFailure({ code: 'network-error' });
    retryAfter.advance(1_000);
    retryAfter.manager.startAttempt();
    assert.equal(retryAfter.manager.recordFailure({ status: 429, retryAfterMs: 5_000 }).delayMs, 5_000);
});

test('stops when the next retry would pass the episode deadline', () => {
    const { manager, setNow } = createHarness();
    manager.startAttempt();
    setNow(29_000);
    const decision = manager.recordFailure({ code: 'timeout', retryAfterMs: 2_000 });
    assert.equal(decision.action, 'stop');
    assert.equal(decision.reason, 'episode-deadline');
});

test('offers renewable account recovery once per episode and never retries hard failures', () => {
    const { manager } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ status: 401, renewableLinkSupported: true }).action, 'renew');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ status: 403, renewableLinkSupported: true }).action, 'stop');
    assert.equal(manager.recordFailure({ code: 'autoplay-blocked' }).action, 'stop');
    assert.equal(manager.recordFailure({ code: 'license-error' }).action, 'stop');
});

test('allows decoder fallback switches while the attempt budget remains', () => {
    const { manager } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'unsupported-codec' }).action, 'switch');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'media-decode-error' }).action, 'switch');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'unsupported-container' }).action, 'stop');
});

test('uses a known source alternative for DNS failure without retrying an unresolved host', () => {
    for (const networkCode of ['ENOTFOUND', 'EAI_NONAME', 'EAI_AGAIN']) {
        const { manager } = createHarness();
        manager.startAttempt();
        assert.equal(manager.recordFailure({ code: 'network-error', networkCode, sourceAlternativeAvailable: true }).action, 'alternate');
        manager.startAttempt();
        assert.equal(manager.recordFailure({ code: 'network-error', networkCode }).action, networkCode === 'EAI_AGAIN' ? 'retry' : 'stop');
    }
});

test('renews a rejected source once, then uses a known alternative within the same budget', () => {
    const { manager } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ status: 401, renewableLinkSupported: true, sourceAlternativeAvailable: true }).action, 'renew');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ status: 401, renewableLinkSupported: true, sourceAlternativeAvailable: true }).action, 'alternate');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ status: 404, sourceAlternativeAvailable: true }).action, 'stop');
});

test('source alternatives never bypass throttling delays, DRM stops, or episode deadlines', () => {
    const throttle = createHarness();
    throttle.manager.startAttempt();
    const retry = throttle.manager.recordFailure({ code: 'provider-rejected', status: 429, retryAfterMs: 5_000, sourceAlternativeAvailable: true });
    assert.equal(retry.action, 'retry');
    assert.equal(retry.delayMs, 5_000);
    const drm = createHarness();
    drm.manager.startAttempt();
    assert.equal(drm.manager.recordFailure({ code: 'license-error', sourceAlternativeAvailable: true }).action, 'stop');
    const deadline = createHarness();
    deadline.manager.startAttempt();
    deadline.setNow(30_000);
    assert.equal(deadline.manager.recordFailure({ status: 404, sourceAlternativeAvailable: true }).action, 'stop');
});

test('requires a prior advancing time sample and presented frame evidence for video', () => {
    const video = createHarness();
    video.manager.startAttempt();
    video.manager.observeProgress({ mediaTimeSeconds: 44, frameReady: true });
    assert.equal(video.manager.isVerified, false);
    video.manager.observeProgress({ mediaTimeSeconds: 45, frameReady: true });
    assert.equal(video.manager.isVerified, true);

    const frozenFrames = createHarness();
    frozenFrames.manager.startAttempt();
    frozenFrames.manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
    frozenFrames.manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 0 });
    assert.equal(frozenFrames.manager.isVerified, false);
    frozenFrames.setNow(12_000);
    assert.equal(frozenFrames.manager.poll().type, 'failure');

    const videoStall = createHarness();
    videoStall.manager.startAttempt();
    videoStall.manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
    videoStall.manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
    assert.equal(videoStall.manager.isVerified, true);
    videoStall.setNow(12_000);
    assert.equal(videoStall.manager.poll().type, 'failure');

    const audio = createHarness();
    audio.manager.startAttempt();
    audio.manager.observeProgress({ mediaTimeSeconds: 0, audioOnly: true });
    assert.equal(audio.manager.isVerified, false);
    audio.manager.observeProgress({ mediaTimeSeconds: 1, audioOnly: true });
    assert.equal(audio.manager.isVerified, true);
    audio.setNow(11_999);
    assert.equal(audio.manager.poll().type, 'none');
});

test('resets the stable window after gaps and observations without verified progress', () => {
    const { manager, setNow } = createHarness();
    manager.startAttempt();
    manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
    manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
    setNow(4_000);
    manager.observeProgress({ mediaTimeSeconds: 2, presentedFrames: 2 });
    setNow(5_000);
    manager.observeProgress({ mediaTimeSeconds: 2, presentedFrames: 2 });
    setNow(35_000);
    manager.observeProgress({ mediaTimeSeconds: 3, presentedFrames: 3 });
    assert.equal(manager.poll().type, 'none');
});

test('paused, seeking, autoplay-blocked, and ended playback do not accrue stalls', () => {
    for (const state of [{ paused: true }, { seeking: true }, { autoplayBlocked: true }, { ended: true }]) {
        const { manager, advance } = createHarness();
        manager.startAttempt();
        manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
        manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
        manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1, ...state });
        advance(60_000);
        assert.equal(manager.poll().type, 'none');
    }
});

test('closes a stable episode after 30 seconds but keeps the selection rolling budget', () => {
    const { manager, setNow } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
    manager.startAttempt();
    manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
    manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
    for (let second = 3; second <= 30; second += 3) {
        setNow(second * 1_000);
        manager.observeProgress({ mediaTimeSeconds: second + 1, presentedFrames: second + 1 });
    }
    assert.deepEqual(manager.poll(), { type: 'episode-closed', stableForMs: 30_000 });
    assert.equal(manager.startAttempt().attemptNumber, 1);
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 4);
});

test('caps automatic retries and replacements at six in ten minutes per selection', () => {
    const { manager, setNow } = createHarness();
    const stabilize = (base: number) => {
        setNow(base);
        manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
        setNow(base + 1_000);
        manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
        for (let second = 4; second <= 31; second += 3) {
            setNow(base + second * 1_000);
            manager.observeProgress({ mediaTimeSeconds: second, presentedFrames: second });
        }
        assert.equal(manager.poll().type, 'episode-closed');
    };

    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).action, 'retry');
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).action, 'retry');
    manager.startAttempt();
    stabilize(0);

    for (const base of [31_000, 62_000]) {
        assert.equal(manager.recordFailure({ code: 'network-error' }).action, 'retry');
        manager.startAttempt();
        assert.equal(manager.recordFailure({ code: 'network-error' }).action, 'retry');
        manager.startAttempt();
        stabilize(base);
    }

    const seventh = manager.recordFailure({ code: 'network-error' });
    assert.equal(seventh.action, 'stop');
    assert.equal(seventh.reason, 'rolling-limit');
    assert.equal(seventh.rollingRemaining, 0);
});

test('expires rolling automatic replacements after ten minutes in the same selection', () => {
    const { manager, setNow } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
    manager.startAttempt();
    setNow(0);
    manager.observeProgress({ mediaTimeSeconds: 0, presentedFrames: 0 });
    setNow(1_000);
    manager.observeProgress({ mediaTimeSeconds: 1, presentedFrames: 1 });
    for (let second = 4; second <= 31; second += 3) {
        setNow(second * 1_000);
        manager.observeProgress({ mediaTimeSeconds: second, presentedFrames: second });
    }
    assert.equal(manager.poll().type, 'episode-closed');
    setNow(600_001);
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
});

test('Retry and a new manual selection reset selection budgets', () => {
    const { manager } = createHarness();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
    manager.retrySelection();
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
    manager.startSelection({ selectionId: 'selection-b', kind: 'live' });
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error' }).rollingRemaining, 5);
});

test('temporary DNS errors retry with backoff within the same three-attempt budget', () => {
    const { manager } = createHarness();
    manager.startAttempt();
    const first = manager.recordFailure({ code: 'network-error', networkCode: 'EAI_AGAIN' });
    assert.equal(first.action, 'retry');
    assert.equal(first.delayMs, 1000);
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error', networkCode: 'EAI_AGAIN' }).delayMs, 3000);
    manager.startAttempt();
    assert.equal(manager.recordFailure({ code: 'network-error', networkCode: 'EAI_AGAIN' }).reason, 'attempt-limit');
});

test('a configured source fallback uses the same budget and never overrides throttling, decoder, autoplay or DRM policy', () => {
    for (const failure of [{ code: 'startup-timeout' }, { code: 'network-error' }, { code: 'html-response', status: 200 }, { code: 'http-error', status: 503 }]) {
        const { manager } = createHarness();
        manager.startAttempt();
        const decision = manager.recordFailure({ ...failure, configuredSourceFallbackAvailable: true });
        assert.equal(decision.action, 'alternate');
        assert.equal(decision.reason, 'configured-source-fallback');
        manager.startAttempt();
        manager.recordFailure({ code: 'network-error' });
        manager.startAttempt();
        assert.equal(manager.recordFailure({ ...failure, configuredSourceFallbackAvailable: true }).reason, 'attempt-limit');
    }
    for (const failure of [{ code: 'http-error', status: 429 }, { code: 'media-decode-error' }, { code: 'autoplay-blocked' }, { code: 'drm-error' }]) {
        const { manager } = createHarness();
        manager.startAttempt();
        assert.notEqual(manager.recordFailure({ ...failure, configuredSourceFallbackAvailable: true }).action, 'alternate');
    }
});
