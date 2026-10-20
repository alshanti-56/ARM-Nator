import assert from "node:assert/strict";
import test from "node:test";
import "@angular/compiler";
import type { AutoPlaybackPreparation, ElectronBridgeApi } from "@arm-nator/shared/interfaces";
import { createFakeShakaEnvironment, flushShakaMicrotasks } from "./shaka-player-test-double";
import { ShakaVideoSession } from "./shaka-video-session";

type TestWindow = { electron?: Partial<ElectronBridgeApi> };

function setTestWindow(value: TestWindow | undefined): () => void {
  const globalObject = globalThis as typeof globalThis & { window?: TestWindow };
  const previous = globalObject.window;
  if (value) globalObject.window = value;
  else delete globalObject.window;
  return () => {
    if (previous) globalObject.window = previous;
    else delete globalObject.window;
  };
}

test("Shaka reuses a prepared DASH session, relays configured license requests, and restores response URIs", async () => {
  const registeredResources: Array<{ sessionId: string; url: string; kind?: string }> = [];
  const registeredLicenses: Array<{ sessionId: string; url: string; headers?: Record<string, string> }> = [];
  let createCalls = 0;
  let releaseCalls = 0;
  const restore = setTestWindow({
    electron: {
      createDashProxySession: async () => {
        createCalls += 1;
        return { id: "unexpected", url: "http://127.0.0.1/dash/unexpected/root" };
      },
      registerDashProxyResource: async (sessionId, url, kind) => {
        registeredResources.push({ sessionId, url, kind });
        return "http://127.0.0.1/dash/prepared-dash/resource-child";
      },
      registerDashProxyLicense: async (sessionId, url, headers) => {
        registeredLicenses.push({ sessionId, url, headers });
        return "http://127.0.0.1/dash/prepared-dash/resource-license";
      },
      releaseDashProxySession: async () => {
        releaseCalls += 1;
      },
    },
  });

  try {
    const environment = createFakeShakaEnvironment();
    const issues: unknown[] = [];
    const session = new ShakaVideoSession({
      player: "artplayer",
      emitPlaybackIssue: (issue) => issues.push(issue),
      loadShaka: environment.loader,
    });
    const preparedProxy: AutoPlaybackPreparation = {
      id: "prepared-dash",
      url: "http://127.0.0.1/dash/prepared-dash/root",
      format: "dash",
      container: "dash",
    };
    const licenseRequestHeaders = { Authorization: "Bearer license-only" };
    session.start(
      {} as HTMLVideoElement,
      "https://provider.test/live/manifest.mpd",
      {
        licenseType: "com.widevine.alpha",
        supported: true,
        licenseServerUrl: "https://license.provider.test/wv",
        licenseRequestHeaders,
      },
      {
        headers: { "User-Agent": "Player/1" },
        requestPolicy: {
          accountRef: "playlist-a",
          loginCookies: true,
          portalCredentials: true,
          licenseProxy: true,
        },
        preparedProxy,
      },
    );
    await flushShakaMicrotasks();

    const player = environment.instances[0];
    assert.ok(player);
    assert.deepEqual(player.loadedUrls, [preparedProxy.url]);
    assert.equal(createCalls, 0);
    assert.deepEqual(registeredLicenses, [{
      sessionId: preparedProxy.id,
      url: "https://license.provider.test/wv",
      headers: licenseRequestHeaders,
    }]);
    const drmConfig = player.configureCalls[0]?.["drm"] as {
      servers: Record<string, string>;
    };
    assert.equal(
      drmConfig.servers["com.widevine.alpha"],
      "http://127.0.0.1/dash/prepared-dash/resource-license",
    );

    const request = {
      uris: ["https://cdn.provider.test/assets/chunk-12.m4s"],
      headers: {},
    };
    await player.requestFilters[0]?.(1, request);
    assert.deepEqual(registeredResources, [{
      sessionId: preparedProxy.id,
      url: "https://cdn.provider.test/assets/chunk-12.m4s",
      kind: "segment",
    }]);
    assert.deepEqual(request.uris, [
      "http://127.0.0.1/dash/prepared-dash/resource-child",
    ]);
    const response = {
      uri: request.uris[0]!,
      headers: {
        "X-Arm-Nator-Upstream-Uri": "https://cdn.provider.test/assets/chunk-12.m4s",
      },
    };
    await player.responseFilters[0]?.(1, response, request);
    assert.equal(response.uri, "https://cdn.provider.test/assets/chunk-12.m4s");

    await session.stopAndWait();
    assert.equal(releaseCalls, 0, "the parent retains ownership of a prepared session");
    assert.deepEqual(issues, []);
  } finally {
    restore();
  }
});

test("Shaka owns and releases a proxy session for a manually selected MPD", async () => {
  let releaseCalls = 0;
  const restore = setTestWindow({
    electron: {
      createDashProxySession: async (url, headers, policy) => {
        assert.equal(url, "https://provider.test/manual.mpd");
        assert.deepEqual(headers, { Authorization: "Bearer playback" });
        assert.deepEqual(policy, { accountRef: "playlist-manual", portalCredentials: true });
        return { id: "manual-dash", url: "http://127.0.0.1/dash/manual-dash/root" };
      },
      registerDashProxyResource: async (_sessionId, targetUrl) =>
        `http://127.0.0.1/dash/manual-dash/${encodeURIComponent(targetUrl)}`,
      releaseDashProxySession: async (sessionId) => {
        assert.equal(sessionId, "manual-dash");
        releaseCalls += 1;
      },
    },
  });

  try {
    const environment = createFakeShakaEnvironment();
    const session = new ShakaVideoSession({
      player: "html5",
      emitPlaybackIssue: () => undefined,
      loadShaka: environment.loader,
    });
    session.start(
      {} as HTMLVideoElement,
      "https://provider.test/manual.mpd",
      undefined,
      {
        headers: { Authorization: "Bearer playback" },
        requestPolicy: { accountRef: "playlist-manual", portalCredentials: true },
      },
    );
    await flushShakaMicrotasks();
    assert.deepEqual(environment.instances[0]?.loadedUrls, [
      "http://127.0.0.1/dash/manual-dash/root",
    ]);
    await session.stopAndWait();
    assert.equal(releaseCalls, 1);
  } finally {
    restore();
  }
});

test("Shaka can proxy a license while keeping media requests direct", async () => {
  const registeredLicenses: string[] = [];
  let releaseCalls = 0;
  const restore = setTestWindow({
    electron: {
      createDashProxySession: async () => ({
        id: "license-only",
        url: "http://127.0.0.1/dash/license-only/root",
      }),
      registerDashProxyResource: async () => "http://127.0.0.1/dash/media",
      registerDashProxyLicense: async (_sessionId, url) => {
        registeredLicenses.push(url);
        return "http://127.0.0.1/dash/license-only/license";
      },
      releaseDashProxySession: async () => {
        releaseCalls += 1;
      },
    },
  });

  try {
    const environment = createFakeShakaEnvironment();
    const session = new ShakaVideoSession({
      player: "html5",
      emitPlaybackIssue: () => undefined,
      loadShaka: environment.loader,
    });
    const sourceUrl = "https://provider.test/direct.mpd";
    session.start(
      {} as HTMLVideoElement,
      sourceUrl,
      {
        licenseType: "com.widevine.alpha",
        supported: true,
        licenseServerUrl: "https://license.provider.test/wv",
      },
      { direct: true, requestPolicy: { licenseProxy: true } },
    );
    await flushShakaMicrotasks();

    const player = environment.instances[0];
    assert.ok(player);
    assert.deepEqual(player.loadedUrls, [sourceUrl]);
    assert.deepEqual(registeredLicenses, ["https://license.provider.test/wv"]);
    const drmConfig = player.configureCalls[0]?.["drm"] as {
      servers: Record<string, string>;
    };
    assert.equal(
      drmConfig.servers["com.widevine.alpha"],
      "http://127.0.0.1/dash/license-only/license",
    );
    assert.equal(player.requestFilters.length, 0);
    await session.stopAndWait();
    assert.equal(releaseCalls, 1);
  } finally {
    restore();
  }
});

test("Shaka keeps the current media buffer after a provider 403 when recovery owns the handoff", async () => {
  const restore = setTestWindow({ electron: {} });
  try {
    const environment = createFakeShakaEnvironment();
    const issues: Array<{ network?: { status: number | null; resourceKind: string } }> = [];
    const session = new ShakaVideoSession({
      player: "artplayer",
      emitPlaybackIssue: (issue) => issues.push(issue),
      loadShaka: environment.loader,
    });
    session.start(
      {} as HTMLVideoElement,
      "https://provider.test/live/manifest.mpd",
      undefined,
      { direct: true, providerRecovery: true },
    );
    await flushShakaMicrotasks();
    const player = environment.instances[0];
    assert.ok(player);
    player.dispatch("error", {
      severity: 2,
      category: 4,
      code: 1001,
      data: [
        "https://provider.test/live/manifest.mpd",
        403,
        "",
        {
          "x-arm-nator-request-id": "media-request-403",
          "x-arm-nator-resource-kind": "manifest",
        },
        0,
      ],
    });
    assert.equal(session.getPlayer(), player);
    assert.equal(player.destroyCount, 0);
    assert.deepEqual(issues[0]?.network, {
      status: 403,
      resourceKind: "manifest",
      requestId: "media-request-403",
    });
    await session.stopAndWait();
    assert.equal(player.destroyCount, 1);
  } finally {
    restore();
  }
});

test("Shaka retains ownership and retries a failed DASH session release", async () => {
  let releaseCalls = 0;
  const restore = setTestWindow({
    electron: {
      createDashProxySession: async () => ({
        id: "release-retry",
        url: "http://127.0.0.1/dash/release-retry/root",
      }),
      registerDashProxyResource: async () => "http://127.0.0.1/dash/resource",
      releaseDashProxySession: async () => {
        releaseCalls += 1;
        if (releaseCalls === 1) throw new Error("temporary IPC failure");
      },
    },
  });

  try {
    const environment = createFakeShakaEnvironment();
    const session = new ShakaVideoSession({
      player: "html5",
      emitPlaybackIssue: () => undefined,
      loadShaka: environment.loader,
    });
    session.start({} as HTMLVideoElement, "https://provider.test/manual.mpd");
    await flushShakaMicrotasks();

    await assert.rejects(session.destroyAndWait(), /temporary IPC failure/);
    const player = environment.instances[0];
    assert.ok(player);
    await session.destroyAndWait();
    assert.equal(releaseCalls, 2);
    assert.equal(player.destroyCount, 1);
  } finally {
    restore();
  }
});

test("Shaka does not retain playback for a license 403 during media recovery", async () => {
  const restore = setTestWindow({ electron: {} });
  try {
    const environment = createFakeShakaEnvironment();
    const issues: Array<{ network?: { status: number | null; resourceKind: string } }> = [];
    const session = new ShakaVideoSession({
      player: "artplayer",
      emitPlaybackIssue: (issue) => issues.push(issue),
      loadShaka: environment.loader,
    });
    session.start(
      {} as HTMLVideoElement,
      "https://provider.test/live/manifest.mpd",
      {
        licenseType: "com.widevine.alpha",
        supported: true,
        licenseServerUrl: "https://license.provider.test/wv",
      },
      { direct: true, providerRecovery: true },
    );
    await flushShakaMicrotasks();
    const player = environment.instances[0];
    assert.ok(player);
    player.dispatch("error", {
      severity: 2,
      category: 4,
      code: 1001,
      data: [
        "https://license.provider.test/wv",
        403,
        "",
        { "x-arm-nator-resource-kind": "license" },
        2,
      ],
    });

    assert.equal(session.getPlayer(), null);
    await session.stopAndWait();
    assert.equal(player.destroyCount, 1);
    assert.equal(issues[0]?.network?.resourceKind, "license");
  } finally {
    restore();
  }
});
