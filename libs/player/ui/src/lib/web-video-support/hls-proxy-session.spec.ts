import assert from "node:assert/strict";
import test from "node:test";
import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { HlsProxySession } from "./hls-proxy-session";

type Bridge = Pick<
  ElectronBridgeApi,
  "createHlsProxySession" | "releaseHlsProxySession"
>;

function installBridge(bridge: Bridge): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { electron: bridge },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

test("HLS session teardown releases a proxy that finishes creating afterward", async () => {
  const pending = deferred<{ id: string; url: string }>();
  const released: string[] = [];
  const restore = installBridge({
    createHlsProxySession: () => pending.promise,
    releaseHlsProxySession: async (id) => {
      released.push(id);
    },
  });
  try {
    const session = new HlsProxySession();
    const loaded: string[] = [];
    const result = session.load(
      { loadSource: (url) => loaded.push(url) },
      "https://provider.test/live.m3u8",
      {},
      () => true,
    );
    session.release();
    pending.resolve({ id: "stale", url: "http://127.0.0.1/stale" });
    assert.equal(await result, false);
    assert.deepEqual(loaded, []);
    assert.deepEqual(released, ["stale"]);
  } finally {
    restore();
  }
});

test("a late HLS channel response cannot replace the current proxy", async () => {
  const old = deferred<{ id: string; url: string }>();
  const current = deferred<{ id: string; url: string }>();
  const released: string[] = [];
  const restore = installBridge({
    createHlsProxySession: (url) =>
      url.includes("old") ? old.promise : current.promise,
    releaseHlsProxySession: async (id) => {
      released.push(id);
    },
  });
  try {
    const session = new HlsProxySession();
    const loaded: string[] = [];
    const loader = { loadSource: (url: string) => loaded.push(url) };
    const oldResult = session.load(
      loader,
      "https://provider.test/old.m3u8",
      {},
      () => true,
    );
    const currentResult = session.load(
      loader,
      "https://provider.test/current.m3u8",
      {},
      () => true,
    );
    current.resolve({ id: "current", url: "http://127.0.0.1/current" });
    assert.equal(await currentResult, true);
    old.resolve({ id: "old", url: "http://127.0.0.1/old" });
    assert.equal(await oldResult, false);
    assert.deepEqual(loaded, ["http://127.0.0.1/current"]);
    assert.deepEqual(released, ["old"]);
    session.release();
    assert.deepEqual(released, ["old", "current"]);
  } finally {
    restore();
  }
});

test("an Electron proxy failure never loads the provider URL directly", async () => {
  const restore = installBridge({
    createHlsProxySession: async () => {
      throw new Error("proxy unavailable");
    },
    releaseHlsProxySession: async () => undefined,
  });
  try {
    const loaded: string[] = [];
    const result = await new HlsProxySession().load(
      { loadSource: (url) => loaded.push(url) },
      "https://provider.test/live.m3u8",
      {},
      () => true,
    );
    assert.equal(result, false);
    assert.deepEqual(loaded, []);
  } finally {
    restore();
  }
});
