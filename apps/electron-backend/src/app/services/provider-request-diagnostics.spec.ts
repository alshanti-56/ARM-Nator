import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PlaybackDiagnosticsStore } from "./playback-diagnostics.service";
import { createProviderDiagnosticsObserver } from "./provider-request-diagnostics";

test("account authentication and connection capacity survive in persistent provider diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-provider-log-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const store = new PlaybackDiagnosticsStore({ filePath });
  try {
    const observer = createProviderDiagnosticsObserver(
      "xtream-api",
      "authenticate",
      "session-1",
      store,
    );
    observer({
      requestUrl:
        "https://provider.test/player_api.php?username=test-user&password=test-password",
      method: "GET",
      requestHeaders: { "User-Agent": "VLC/Test" },
      responseHeaders: { "content-type": "application/json" },
      status: 200,
      durationMs: 10,
      redirectCount: 0,
      responseData: {
        user_info: {
          auth: 1,
          active_cons: "1",
          max_connections: "1",
          username: "test-user",
        },
        available_channels: ["do not log the whole catalog"],
      },
    });
    await store.flush();
    const raw = await readFile(filePath, "utf8");
    const event = JSON.parse(raw.trim());
    assert.equal(event.providerAuth, true);
    assert.equal(event.providerActiveConnections, 1);
    assert.equal(event.providerMaxConnections, 1);
    assert.ok(event.requestUrl.includes("password=test-password"));
    assert.ok(!raw.includes("do not log the whole catalog"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP 200 is not treated as successful authentication without account evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-provider-log-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const store = new PlaybackDiagnosticsStore({ filePath });
  try {
    const observer = createProviderDiagnosticsObserver(
      "xtream-api",
      "get_live_streams",
      undefined,
      store,
    );
    const attempt = {
      requestUrl: "https://provider.test/player_api.php",
      method: "GET",
      requestHeaders: {},
      status: 200,
      durationMs: 5,
      redirectCount: 0,
    };
    observer({ ...attempt, responseData: { user_info: { auth: 0 } } });
    observer({ ...attempt, responseData: [{ stream_id: 1 }] });
    await store.flush();
    const events = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].providerAuth, false);
    assert.equal(events[1].providerAuth, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Stalker HTTP 200 authorization failures remain identifiable separately from handshake success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-provider-log-"));
  const filePath = join(directory, "playback-diagnostics.jsonl");
  const store = new PlaybackDiagnosticsStore({ filePath });
  try {
    const observer = createProviderDiagnosticsObserver(
      "stalker-api",
      "handshake",
      undefined,
      store,
    );
    const attempt = {
      requestUrl: "https://provider.test/portal.php",
      method: "GET",
      requestHeaders: {},
      status: 200,
      durationMs: 5,
      redirectCount: 0,
    };
    observer({ ...attempt, responseData: "Authorization failed." });
    observer({
      ...attempt,
      responseData: { js: { token: "accepted-handshake-token" } },
    });
    await store.flush();
    const events = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events[0].providerAuth, false);
    assert.equal(events[1].providerAuth, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
