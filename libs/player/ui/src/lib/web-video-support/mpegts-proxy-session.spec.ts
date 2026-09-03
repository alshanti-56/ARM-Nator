import assert from "node:assert/strict";
import test from "node:test";
import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { MpegTsProxySession } from "./mpegts-proxy-session";

type TestWindow = { electron?: Partial<ElectronBridgeApi> };

function setTestWindow(value: TestWindow | undefined): TestWindow | undefined {
  const globalObject = globalThis as typeof globalThis & {
    window?: TestWindow;
  };
  const previous = globalObject.window;
  if (value) {
    globalObject.window = value;
  } else {
    delete globalObject.window;
  }
  return previous;
}

function restoreTestWindow(previous: TestWindow | undefined): void {
  const globalObject = globalThis as typeof globalThis & {
    window?: TestWindow;
  };
  if (previous) {
    globalObject.window = previous;
  } else {
    delete globalObject.window;
  }
}

test("MPEG-TS proxy falls back cleanly without a browser global", async () => {
  const previous = setTestWindow(undefined);
  try {
    const session = new MpegTsProxySession();
    assert.equal(
      await session.load(
        "http://provider.example/live.ts",
        undefined,
        () => true,
      ),
      "http://provider.example/live.ts",
    );
  } finally {
    restoreTestWindow(previous);
  }
});

test("MPEG-TS proxy releases a stale session instead of mounting it", async () => {
  const released: string[] = [];
  const previous = setTestWindow({
    electron: {
      createMpegTsProxySession: async () => ({
        id: "stale-session",
        url: "http://127.0.0.1:1234/stream/stale",
      }),
      releaseMpegTsProxySession: async (id) => {
        released.push(id);
      },
    },
  });
  try {
    const session = new MpegTsProxySession();
    const sourceUrl = "http://provider.example/live.ts";
    assert.equal(
      await session.load(sourceUrl, undefined, () => false),
      sourceUrl,
    );
    assert.deepEqual(released, ["stale-session"]);
    assert.equal(session.currentUrl, null);
  } finally {
    restoreTestWindow(previous);
  }
});

test("MPEG-TS proxy surfaces Electron session creation failures", async () => {
  const previous = setTestWindow({
    electron: {
      createMpegTsProxySession: async () => {
        throw new Error("proxy unavailable");
      },
    },
  });
  try {
    const session = new MpegTsProxySession();
    await assert.rejects(
      session.load(
        "http://provider.example/live.ts",
        { Authorization: "Bearer secret" },
        () => true,
      ),
      /proxy unavailable/,
    );
    assert.equal(session.currentUrl, null);
  } finally {
    restoreTestWindow(previous);
  }
});
