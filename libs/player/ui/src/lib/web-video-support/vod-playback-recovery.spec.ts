import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VodPlaybackRecovery } from './vod-playback-recovery';
import { VodSeekController } from './vod-seek-controller';

test('VOD recovery is single-flight and ends at its bounded deadline', async () => {
  let retries = 0;
  const exhausted: string[] = [];
  const recovery = new VodPlaybackRecovery({
    retry: () => {
      retries += 1;
      recovery.request('asset', 'still unavailable');
    },
    getRecoveryBudgetMs: () => 350,
    onExhausted: ({ reason }) => exhausted.push(reason),
  });

  try {
    assert.equal(recovery.request('asset', 'manifest failed'), true);
    assert.equal(recovery.request('asset', 'duplicate error'), false);
    await new Promise((resolve) => setTimeout(resolve, 450));

    assert.ok(retries >= 1);
    assert.deepEqual(exhausted, ['still unavailable']);
    assert.equal(recovery.state, 'failed');
  } finally {
    recovery.destroy();
  }
});

test('VOD progress cancels a pending asset retry', async () => {
  let retries = 0;
  const recovery = new VodPlaybackRecovery({
    retry: () => {
      retries += 1;
    },
    onExhausted: () => undefined,
  });

  try {
    recovery.request('asset', 'temporary segment error');
    recovery.markProgress();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(retries, 0);
    assert.equal(retries, 0);
  } finally {
    recovery.destroy();
  }
});

test('VOD seek controller clamps resume targets and ignores stale generations', () => {
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    duration: 120,
    seekable: { length: 1, start: () => 0, end: () => 120 },
  }) as unknown as HTMLVideoElement;
  let requestedStart = 180;
  const controller = new VodSeekController({
    video,
    getStartTime: () => requestedStart,
    getDuration: () => video.duration,
    isVod: () => true,
    seek: (seconds) => {
      video.currentTime = seconds;
      video.dispatchEvent(new Event('seeked'));
    },
  });

  controller.attach();
  controller.requestStartTime();
  assert.equal(video.currentTime, 120);
  assert.equal(controller.state, 'completed');

  requestedStart = 40;
  controller.requestStartTime();
  assert.equal(video.currentTime, 40);
  assert.equal(controller.state, 'completed');
  controller.destroy();
});
