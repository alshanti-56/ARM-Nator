import assert from "node:assert/strict";
import test from "node:test";
import "@angular/compiler";
import Hls from "hls.js";
import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { ArtPlayer2Component } from "../art-player2/art-player2.component";
import { HlsProxySession } from "../web-video-support/hls-proxy-session";
import { HtmlVideoLiveController } from "./html-video-live-controller";
import type { HtmlVideoLiveControllerConfig } from "./html-video-live-controller";

type TestWindow = { electron?: Partial<ElectronBridgeApi> };

function installWindow(value: TestWindow): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

function mockHls(events: string[]): () => void {
  const originalAttachMedia = Hls.prototype.attachMedia;
  const originalDestroy = Hls.prototype.destroy;
  Hls.prototype.attachMedia = function (media) {
    void media;
    events.push("attach");
  };
  Hls.prototype.destroy = function () {
    events.push("destroy");
  };
  return () => {
    Hls.prototype.attachMedia = originalAttachMedia;
    Hls.prototype.destroy = originalDestroy;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("HTML HLS proxy failure clears controls and destroys HLS before reporting", async () => {
  const events: string[] = [];
  const restoreWindow = installWindow({
    electron: {
      createHlsProxySession: async () => {
        throw new Error("proxy unavailable");
      },
      releaseHlsProxySession: async () => undefined,
    },
  });
  const restoreHls = mockHls(events);
  const config = {
    getVideo: () => ({}) as HTMLVideoElement,
    getSourceUrl: () => "https://provider.test/live.m3u8",
    isLive: () => true,
    getSourceKind: () => "hls" as const,
    restartMpegTs: () => undefined,
    bindControlsSource: () => events.push("bind"),
    clearControlsSource: () => events.push("clear-controls"),
    play: () => undefined,
    emitPlaybackIssue: () => events.push("issue"),
  } as unknown as HtmlVideoLiveControllerConfig;
  const controller = new HtmlVideoLiveController(config);

  try {
    controller.openHls("https://provider.test/live.m3u8");
    await flushPromises();

    assert.deepEqual(
      events.filter((event) => event !== "bind"),
      ["attach", "clear-controls", "destroy", "issue"],
    );
  } finally {
    controller.destroy();
    restoreHls();
    restoreWindow();
  }
});

test("ArtPlayer2 destroys its current HLS instance before reporting proxy failure", async () => {
  const events: string[] = [];
  const restoreWindow = installWindow({
    electron: {
      createHlsProxySession: async () => {
        throw new Error("proxy unavailable");
      },
      releaseHlsProxySession: async () => undefined,
    },
  });
  const restoreHls = mockHls(events);
  const previousSupported = Hls.isSupported;
  Hls.isSupported = () => true;
  const art = { notice: { show: "" } } as never;
  const component = Object.assign(
    Object.create(ArtPlayer2Component.prototype),
    {
      destroyed: false,
      player: art,
      hls: null,
      hlsArt: null,
      hlsSourceGeneration: 0,
      sourceGeneration: 1,
      hlsProxySession: new HlsProxySession(),
      isLive: () => false,
      channel: () => ({ http: { headers: {} } }),
      requestHeaders: () => ({}),
      playbackIssue: {
        emit: () => {
          events.push("issue");
        },
      },
    },
  ) as ArtPlayer2Component;

  try {
    (
      component as unknown as {
        startHls(video: HTMLVideoElement, url: string, art: never): void;
      }
    ).startHls({} as HTMLVideoElement, "https://provider.test/live.m3u8", art);
    await flushPromises();

    assert.deepEqual([...events], ["attach", "destroy", "issue"]);
    assert.equal((component as unknown as { hls: Hls | null }).hls, null);
    assert.equal((art as { hls?: Hls }).hls, undefined);
  } finally {
    (component as unknown as { destroyHls(): void }).destroyHls();
    Hls.isSupported = previousSupported;
    restoreHls();
    restoreWindow();
  }
});

test("a late ArtPlayer2 HLS failure leaves the replacement playback attached", async () => {
  const oldRequest = deferred<{ id: string; url: string }>();
  const oldCreateStarted = deferred<void>();
  const released: string[] = [];
  const events: string[] = [];
  const restoreWindow = installWindow({
    electron: {
      createHlsProxySession: (url) => {
        if (url.includes("old")) {
          oldCreateStarted.resolve();
          return oldRequest.promise;
        }
        return Promise.resolve({ id: "current", url: "http://127.0.0.1/current" });
      },
      releaseHlsProxySession: async (id) => {
        released.push(id);
      },
    },
  });
  const restoreHls = mockHls(events);
  const previousSupported = Hls.isSupported;
  const originalLoadSource = Hls.prototype.loadSource;
  Hls.isSupported = () => true;
  Hls.prototype.loadSource = function (source) {
    void source;
  };
  const oldArt = { notice: { show: "" } } as never;
  const currentArt = { notice: { show: "" } } as never;
  const issues: unknown[] = [];
  const component = Object.assign(
    Object.create(ArtPlayer2Component.prototype),
    {
      destroyed: false,
      player: oldArt,
      hls: null,
      hlsArt: null,
      hlsSourceGeneration: 0,
      sourceGeneration: 1,
      hlsProxySession: new HlsProxySession(),
      channel: () => ({ http: { headers: {} } }),
      requestHeaders: () => ({}),
      playbackIssue: { emit: (issue: unknown) => issues.push(issue) },
    },
  ) as ArtPlayer2Component;

  try {
    const startHls = (art: never, url: string) =>
      (
        component as unknown as {
          startHls(video: HTMLVideoElement, url: string, art: never): void;
        }
      ).startHls({} as HTMLVideoElement, url, art);
    startHls(oldArt, "https://provider.test/old.m3u8");
    await oldCreateStarted.promise;
    (component as unknown as { player: unknown }).player = currentArt;
    (component as unknown as { sourceGeneration: number }).sourceGeneration++;
    startHls(currentArt, "https://provider.test/current.m3u8");
    await flushPromises();

    const currentHls = (component as unknown as { hls: Hls }).hls;
    oldRequest.reject(new Error("old proxy failed"));
    await flushPromises();

    assert.equal(issues.length, 0);
    assert.equal((component as unknown as { hls: Hls }).hls, currentHls);
    assert.equal((currentArt as { hls?: Hls }).hls, currentHls);
    assert.deepEqual(released, []);
  } finally {
    (component as unknown as { destroyHls(): void }).destroyHls();
    Hls.isSupported = previousSupported;
    Hls.prototype.loadSource = originalLoadSource;
    restoreHls();
    restoreWindow();
  }
});
