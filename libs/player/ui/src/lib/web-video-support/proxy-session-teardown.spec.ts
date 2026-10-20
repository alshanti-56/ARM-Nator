import assert from "node:assert/strict";
import test from "node:test";
import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { HlsProxySession } from "./hls-proxy-session";
import { MpegTsProxySession } from "./mpegts-proxy-session";
import { ProgressiveVodProxySession } from "./progressive-vod-proxy-session";

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

test("HLS teardown waits until the proxy release acknowledgement resolves", async () => {
  let release!: () => void;
  const pendingRelease = new Promise<void>((resolve) => (release = resolve));
  let didRelease = false;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createHlsProxySession: async () => ({ id: "hls-1", url: "http://127.0.0.1/hls" }),
      releaseHlsProxySession: async () => {
        await pendingRelease;
        didRelease = true;
      },
    },
  });

  try {
    const session = new HlsProxySession();
    await session.load({ loadSource: () => undefined }, "https://provider/live.m3u8", undefined, () => true);
    const teardown = session.releaseAndWait();
    await Promise.resolve();
    assert.equal(didRelease, false);
    release();
    await teardown;
    assert.equal(didRelease, true);
  } finally {
    restore();
  }
});

test("HLS teardown retains a rejected release for a later retry", async () => {
  let attempts = 0;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createHlsProxySession: async () => ({ id: "hls-retry", url: "http://127.0.0.1/hls" }),
      releaseHlsProxySession: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("HLS release failed");
        }
      },
    },
  });

  try {
    const session = new HlsProxySession();
    await session.load({ loadSource: () => undefined }, "https://provider/live.m3u8", undefined, () => true);
    await assert.rejects(session.releaseAndWait(), /HLS release failed/);
    await session.releaseAndWait();
    assert.equal(attempts, 2);
  } finally {
    restore();
  }
});

test("progressive VOD teardown waits until the proxy release acknowledgement resolves", async () => {
  let release!: () => void;
  const pendingRelease = new Promise<void>((resolve) => (release = resolve));
  let didRelease = false;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createProgressiveVodProxySession: async () => ({ id: "vod-1", url: "http://127.0.0.1/vod" }),
      releaseProgressiveVodProxySession: async () => {
        await pendingRelease;
        didRelease = true;
      },
    },
  });

  try {
    const session = new ProgressiveVodProxySession();
    await session.load({ setSource: () => undefined }, "https://provider/movie.mp4", undefined, () => true);
    const teardown = session.releaseAndWait();
    await Promise.resolve();
    assert.equal(didRelease, false);
    release();
    await teardown;
    assert.equal(didRelease, true);
  } finally {
    restore();
  }
});

test("progressive VOD teardown retains a rejected release for a later retry", async () => {
  let attempts = 0;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createProgressiveVodProxySession: async () => ({ id: "vod-retry", url: "http://127.0.0.1/vod" }),
      releaseProgressiveVodProxySession: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("VOD release failed");
        }
      },
    },
  });

  try {
    const session = new ProgressiveVodProxySession();
    await session.load({ setSource: () => undefined }, "https://provider/movie.mp4", undefined, () => true);
    await assert.rejects(session.releaseAndWait(), /VOD release failed/);
    await session.releaseAndWait();
    assert.equal(attempts, 2);
  } finally {
    restore();
  }
});

test("HLS teardown waits for a late proxy creation and its release", async () => {
  let completeCreation!: (result: { id: string; url: string }) => void;
  let completeRelease!: () => void;
  const creation = new Promise<{ id: string; url: string }>((resolve) => {
    completeCreation = resolve;
  });
  const releaseAck = new Promise<void>((resolve) => {
    completeRelease = resolve;
  });
  const loaded: string[] = [];
  let released = false;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createHlsProxySession: async () => creation,
      releaseHlsProxySession: async () => {
        await releaseAck;
        released = true;
      },
    },
  });

  try {
    const session = new HlsProxySession();
    const loading = session.load(
      { loadSource: (url) => loaded.push(url) },
      "https://provider/live.m3u8",
      undefined,
      () => true,
    );
    let prepared = false;
    const teardown = session.releaseAndWait().then(() => {
      prepared = true;
    });
    completeCreation({ id: "late-hls", url: "http://127.0.0.1/late" });
    await Promise.resolve();
    assert.deepEqual(loaded, []);
    assert.equal(prepared, false);
    completeRelease();
    assert.equal(await loading, false);
    await teardown;
    assert.equal(released, true);
    assert.equal(prepared, true);
  } finally {
    restore();
  }
});

test("MPEG-TS teardown rejects when Electron cannot confirm proxy release", async () => {
  let attempts = 0;
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createMpegTsProxySession: async () => ({ id: "mpegts-1", url: "http://127.0.0.1/ts" }),
      releaseMpegTsProxySession: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("proxy still active");
        }
      },
    },
  });

  try {
    const session = new MpegTsProxySession();
    await session.load("https://provider/live.ts", undefined, () => true);
    await assert.rejects(session.releaseAndWait(), /proxy still active/);
    await session.releaseAndWait();
    assert.equal(attempts, 2);
  } finally {
    restore();
  }
});

test("prepared HLS sources bypass a second proxy and are not released by the player", async () => {
  let createCalls = 0;
  let releaseCalls = 0;
  const loaded: string[] = [];
  const restore = setTestWindow({
    electron: {
      platform: "darwin",
      createHlsProxySession: async () => {
        createCalls += 1;
        return { id: "nested", url: "http://127.0.0.1/nested" };
      },
      releaseHlsProxySession: async () => {
        releaseCalls += 1;
      },
    },
  });

  try {
    const session = new HlsProxySession();
    const prepared = {
      id: "automatic-hls",
      url: "http://127.0.0.1/hls/automatic-hls",
      format: "hls" as const,
    };
    assert.equal(
      await session.load(
        { loadSource: (url) => loaded.push(url) },
        prepared.url,
        { Authorization: "Bearer secret" },
        () => true,
        prepared,
      ),
      true,
    );
    await session.releaseAndWait();
    assert.deepEqual(loaded, [prepared.url]);
    assert.equal(createCalls, 0);
    assert.equal(releaseCalls, 0);
  } finally {
    restore();
  }
});

test("prepared progressive sources bypass the player's proxy ownership", async () => {
  let createCalls = 0;
  let releaseCalls = 0;
  const sources: string[] = [];
  const restore = setTestWindow({
    electron: {
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
    const session = new ProgressiveVodProxySession();
    const prepared = {
      id: "automatic-progressive",
      url: "http://127.0.0.1/media/automatic-progressive",
      format: "progressive" as const,
      container: "mp4" as const,
    };
    assert.equal(
      await session.load(
        { setSource: (url) => sources.push(url) },
        prepared.url,
        { Authorization: "Bearer secret" },
        () => true,
        prepared,
      ),
      true,
    );
    await session.releaseAndWait();
    assert.deepEqual(sources, [prepared.url]);
    assert.equal(createCalls, 0);
    assert.equal(releaseCalls, 0);
  } finally {
    restore();
  }
});
