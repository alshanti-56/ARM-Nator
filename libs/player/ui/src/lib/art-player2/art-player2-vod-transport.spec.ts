import assert from "node:assert/strict";
import test from "node:test";
import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { ArtPlayer2VodTransport } from "./art-player2-vod-transport";

type TestWindow = { electron?: Partial<ElectronBridgeApi> };

function setTestWindow(value: TestWindow): () => void {
  const globalObject = globalThis as typeof globalThis & { window?: TestWindow };
  const previous = globalObject.window;
  globalObject.window = value;
  return () => {
    if (previous) {
      globalObject.window = previous;
    } else {
      delete globalObject.window;
    }
  };
}

test("transport teardown waits for inspection and prevents a stale proxy start", async () => {
  let finishInspection!: (value: {
    status: number;
    headers: Record<string, string>;
    redirectChain: [];
    requestedUrl: string;
    finalUrl: string;
    elapsedMs: number;
  }) => void;
  const inspection = new Promise<{
    status: number;
    headers: Record<string, string>;
    redirectChain: [];
    requestedUrl: string;
    finalUrl: string;
    elapsedMs: number;
  }>((resolve) => {
    finishInspection = resolve;
  });
  let proxyCreates = 0;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      inspectPlaybackUrl: async () => inspection,
      createProgressiveVodProxySession: async () => {
        proxyCreates += 1;
        return { id: "stale-vod", url: "http://127.0.0.1/vod" };
      },
      releaseProgressiveVodProxySession: async () => undefined,
    },
  });

  try {
    const transport = new ArtPlayer2VodTransport();
    const prepared = transport.prepare(
      "https://provider.test/movie.bin",
      {},
      () => true,
    );
    let teardownComplete = false;
    const teardown = transport.releaseAndWait().then(() => {
      teardownComplete = true;
    });
    finishInspection({
      requestedUrl: "https://provider.test/movie.bin",
      finalUrl: "https://provider.test/movie.bin",
      status: 200,
      headers: {},
      redirectChain: [],
      elapsedMs: 5,
    });

    const source = await prepared;
    await teardown;
    assert.equal(source.mode, "direct");
    assert.equal(proxyCreates, 0);
    assert.equal(teardownComplete, true);
  } finally {
    restore();
  }
});

test("transport retains a rejected proxy release for a later retry", async () => {
  let releaseAttempts = 0;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createProgressiveVodProxySession: async () => ({
        id: "art2-vod",
        url: "http://127.0.0.1/vod",
      }),
      releaseProgressiveVodProxySession: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) {
          throw new Error("ArtPlayer2 release failed");
        }
      },
    },
  });

  try {
    const transport = new ArtPlayer2VodTransport();
    await transport.fallbackToProxy(
      "https://provider.test/movie.bin",
      {},
      () => true,
    );
    await assert.rejects(transport.releaseAndWait(), /ArtPlayer2 release failed/);
    await transport.releaseAndWait();
    assert.equal(releaseAttempts, 2);
  } finally {
    restore();
  }
});

test("prepared progressive transport skips inspection and keeps release ownership upstream", async () => {
  let inspectCalls = 0;
  let createCalls = 0;
  let releaseCalls = 0;
  const restore = setTestWindow({
    electron: {
      inspectPlaybackUrl: async () => {
        inspectCalls += 1;
        throw new Error("must not inspect prepared media");
      },
      createProgressiveVodProxySession: async () => {
        createCalls += 1;
        return { id: "nested", url: "http://127.0.0.1/nested" };
      },
      releaseProgressiveVodProxySession: async () => {
        releaseCalls += 1;
      },
    },
  });

  try {
    const transport = new ArtPlayer2VodTransport();
    const prepared = {
      id: "automatic-progressive",
      url: "http://127.0.0.1/media/automatic-progressive",
      format: "progressive" as const,
      container: "mp4" as const,
    };
    assert.deepEqual(
      await transport.prepare(
        "https://provider.test/movie.mp4",
        {},
        () => true,
        prepared,
      ),
      { mode: "prepared", url: prepared.url },
    );
    await transport.releaseAndWait();
    assert.equal(inspectCalls, 0);
    assert.equal(createCalls, 0);
    assert.equal(releaseCalls, 0);
  } finally {
    restore();
  }
});

test('explicit direct recovery skips both inspection and proxy creation', async () => {
  let requests = 0;
  const restore = setTestWindow({ electron: { inspectPlaybackUrl: async () => { requests++; throw new Error('must not inspect'); }, createProgressiveVodProxySession: async () => { requests++; return { id: 'unexpected', url: 'http://localhost/media' }; } } });
  try {
    const transport = new ArtPlayer2VodTransport();
    assert.deepEqual(await transport.prepare('https://media.example/movie', {}, () => true, undefined, true), { mode: 'direct', url: 'https://media.example/movie' });
    assert.equal(requests, 0); await transport.releaseAndWait();
  } finally { restore(); }
});
