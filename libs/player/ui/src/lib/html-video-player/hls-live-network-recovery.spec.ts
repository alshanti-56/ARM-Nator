import assert from 'node:assert/strict';
import { test } from 'node:test';
import '@angular/compiler';
import Hls, { ErrorDetails, ErrorTypes, type ErrorData } from 'hls.js';
import type { WebVideoControlsAdapter } from '../player-controls';
import { HtmlVideoLiveController } from './html-video-live-controller';

class Video extends EventTarget {
    currentTime = 0;
    paused = false;
    ended = false;
    error = null;
    buffered = { length: 0, start: () => 0, end: () => 20 };
    play() {
        return Promise.resolve();
    }
}

for (const player of ['ArtPlayer', 'HTML5'] as const) {
    for (const buffered of [false, true]) {
      for (const providerRecovery of [false, true]) {
        test(`${player} delays network recovery with provider recovery ${providerRecovery} and ${buffered ? 'buffered media retained' : 'an empty buffer'}`, async (context) => {
            context.mock.timers.enable({
                apis: ['Date', 'setTimeout'],
                now: 1000,
            });
            const oldWindow = Object.getOwnPropertyDescriptor(
                globalThis,
                'window'
            );
            const oldSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
            Object.defineProperty(globalThis, 'self', {
                configurable: true,
                value: globalThis,
            });
            const { ArtPlayerSourceSession } =
                await import('../art-player/art-player-source-session');
            const supported = Hls.isSupported;
            const attach = Hls.prototype.attachMedia;
            const load = Hls.prototype.loadSource;
            const start = Hls.prototype.startLoad;
            const destroy = Hls.prototype.destroy;
            const instances: Hls[] = [];
            let uncoordinatedLoads = 0;
            // HLS's browser transport and MSE attachment are external boundaries.
            // Keep the real controller, HLS error events and recovery scheduler.
            Hls.isSupported = () => true;
            Hls.prototype.attachMedia = function () {
                instances.push(this);
            };
            Hls.prototype.loadSource = () => undefined;
            Hls.prototype.startLoad = () => {
                uncoordinatedLoads += 1;
            };
            Hls.prototype.destroy = () => undefined;
            Object.defineProperty(globalThis, 'window', {
                configurable: true,
                value: {
                    electron: {
                        createHlsProxySession: async () => ({
                            id: 'local',
                            url: 'http://127.0.0.1/manifest.m3u8',
                        }),
                        releaseHlsProxySession: async () => undefined,
                    },
                },
            });
            const video = new Video() as unknown as HTMLVideoElement;
            (video.buffered as unknown as { length: number }).length = buffered
                ? 1
                : 0;
            const source = 'https://provider.test/live.m3u8';
            const controller =
                player === 'ArtPlayer'
                    ? new ArtPlayerSourceSession({
                          controlsAdapter: {
                              registerPlaybackIntentListener: () => () =>
                                  undefined,
                          } as unknown as WebVideoControlsAdapter,
                          isLive: () => true,
                          providerRecovery: () => providerRecovery,
                          showCaptions: () => false,
                          emitPlaybackIssue: () => undefined,
                      })
                    : new HtmlVideoLiveController({
                          getVideo: () => video,
                          getSourceUrl: () => source,
                          getSourceKind: () => 'hls',
                          isLive: () => true,
                          providerRecovery: () => providerRecovery,
                          restartMpegTs: () => undefined,
                          bindControlsSource: () => undefined,
                          clearControlsSource: () => undefined,
                          play: () => undefined,
                          emitPlaybackIssue: () => undefined,
                      });
            try {
                if (controller instanceof ArtPlayerSourceSession)
                    controller.customType.m3u8(video, source, {} as never);
                else controller.openHls(source);
                await new Promise<void>((resolve) => setImmediate(resolve));
                assert.equal(instances.length, 1);
                instances[0].trigger(Hls.Events.ERROR, {
                    fatal: true,
                    type: ErrorTypes.NETWORK_ERROR,
                    details: ErrorDetails.MANIFEST_LOAD_ERROR,
                    error: new Error('manifest request returned 401'),
                    response: { code: 401, text: 'Unauthorized', url: source },
                } as ErrorData);
                assert.equal(
                    uncoordinatedLoads,
                    0,
                    'a fatal error must not immediately restart the transport outside backoff'
                );
                context.mock.timers.tick(249);
                assert.equal(instances.length, 1);
                context.mock.timers.tick(1);
                await new Promise<void>((resolve) => setImmediate(resolve));
                if (providerRecovery) {
                    assert.equal(instances.length, 1, 'provider resolution keeps buffered engine mounted');
                    assert.equal(uncoordinatedLoads, 0, 'same-source recovery yields ownership to provider resolver');
                } else if (buffered) {
                    assert.equal(
                        instances.length,
                        1,
                        'recovery must retain the engine containing playable media'
                    );
                    assert.equal(
                        uncoordinatedLoads,
                        1,
                        'the scheduled retry resumes loading into the existing buffer'
                    );
                } else {
                    assert.equal(
                        instances.length,
                        2,
                        'the recovery scheduler reopens the source after its delay'
                    );
                }
            } finally {
                controller.destroy();
                Hls.isSupported = supported;
                Hls.prototype.attachMedia = attach;
                Hls.prototype.loadSource = load;
                Hls.prototype.startLoad = start;
                Hls.prototype.destroy = destroy;
                if (oldWindow)
                    Object.defineProperty(globalThis, 'window', oldWindow);
                else Reflect.deleteProperty(globalThis, 'window');
                if (oldSelf) Object.defineProperty(globalThis, 'self', oldSelf);
                else Reflect.deleteProperty(globalThis, 'self');
            }
        });
    }
}

}
