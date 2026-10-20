import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PlaybackDiagnosticsStore,
  getDefaultPlaybackDiagnosticsPath,
} from "./playback-diagnostics.service";

async function withTemporaryDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-playback-diag-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("persists exact playback URLs and headers with owner-only permissions", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "logs", "playback-diagnostics.jsonl");
    const store = new PlaybackDiagnosticsStore({ filePath });
    const sourceUrl =
      "https://provider.example/live.m3u8?username=alice&token=secret";
    const requestUrl = `${sourceUrl}&_arm_nator_refresh=123`;
    const responseUrl =
      "https://edge.example/playlist.m3u8?auth=redirect-secret";
    store.record({
      event: "upstream-response",
      requestId: "request-1",
      sourceUrl,
      requestUrl,
      responseUrl,
      requestHeaders: {
        authorization: "Bearer exact-secret",
        cookie: "session=exact-cookie",
      },
      responseHeaders: { "www-authenticate": 'Basic realm="provider"' },
      status: 401,
      durationMs: 27,
      sessionId: "session-1",
      resourceId: "resource-1",
      phase: "manifest-refresh",
      transport: "electron-main-fetch",
      resourceKind: "hls-manifest",
      activeSessions: 2,
    });

    await store.flush();
    const [line] = (await readFile(filePath, "utf8")).trim().split("\n");
    const record = JSON.parse(line);
    assert.equal(record.sourceUrl, sourceUrl);
    assert.equal(record.requestUrl, requestUrl);
    assert.equal(record.responseUrl, responseUrl);
    assert.deepEqual(record.requestHeaders, {
      authorization: "Bearer exact-secret",
      cookie: "session=exact-cookie",
    });
    assert.deepEqual(record.responseHeaders, {
      "www-authenticate": 'Basic realm="provider"',
    });
    assert.equal(record.status, 401);
    assert.equal(record.requestId, "request-1");
    assert.match(record.timestamp, /^\d{4}-\d\d-\d\dT/);

    const directoryMode = (await stat(join(directory, "logs"))).mode & 0o777;
    const fileMode = (await stat(filePath)).mode & 0o777;
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
  });
});

test("rotates JSONL files within the configured active and archive bounds", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "playback-diagnostics.jsonl");
    const store = new PlaybackDiagnosticsStore({
      filePath,
      maxBytes: 384,
      maxQueuedBytes: 4 * 1024,
    });
    for (let index = 0; index < 12; index += 1) {
      store.record({
        event: "test-event",
        requestId: `request-${index}`,
        sourceUrl: `https://provider.example/live.m3u8?token=${index}`,
      });
    }
    await store.flush();

    const names = (await readdir(directory)).sort();
    assert.deepEqual(names, [
      "playback-diagnostics.1.jsonl",
      "playback-diagnostics.2.jsonl",
      "playback-diagnostics.jsonl",
    ]);
    let totalBytes = 0;
    for (const name of names) {
      const path = join(directory, name);
      const metadata = await stat(path);
      assert.ok(metadata.size <= 384);
      assert.equal(metadata.mode & 0o777, 0o600);
      totalBytes += metadata.size;
    }
    assert.ok(totalBytes <= 384 * 3);
  });
});

test("routes malformed payload fallbacks through the bounded record queue", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "playback-diagnostics.jsonl");
    const store = new PlaybackDiagnosticsStore({
      filePath,
      maxQueuedRecords: 2,
    });
    const malformed = new Proxy(
      { event: "malformed-input" },
      {
        get(target, property, receiver) {
          if (property === "requestId") throw new Error("malformed getter");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      for (let index = 0; index < 40; index += 1) {
        assert.doesNotThrow(() => store.record(malformed as never));
      }
      await store.flush();
      const queuedRecords = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(queuedRecords.length, 2);
      assert.ok(
        queuedRecords.every(
          (record) => record.event === "diagnostic-record-invalid",
        ),
      );
      assert.ok(warnings.some((message) => /write queue full/i.test(message)));

      store.record({ event: "healthy-after-malformed-flood" });
      await store.flush();
      const allRecords = (await readFile(filePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(
        allRecords.some(
          (record) => record.event === "healthy-after-malformed-flood",
        ),
      );
    } finally {
      console.error = originalError;
    }
  });
});

test("bounds aggregate queued bytes while still writing later normal records", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "playback-diagnostics.jsonl");
    const store = new PlaybackDiagnosticsStore({
      filePath,
      maxBytes: 64 * 1024,
      maxQueuedRecords: 10,
    });
    const originalError = console.error;
    const warnings: string[] = [];
    console.error = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      for (let index = 0; index < 10; index += 1) {
        store.record({
          event: "large-request",
          requestUrl: "https://provider.example/" + "x".repeat(40 * 1024),
        });
      }
      await store.flush();
      store.record({ event: "healthy-after-byte-backlog" });
      await store.flush();

      const names = (await readdir(directory)).filter((name) =>
        /^playback-diagnostics(?:\.\d+)?\.jsonl$/.test(name),
      );
      const records = (
        await Promise.all(
          names.map(async (name) =>
            (await readFile(join(directory, name), "utf8"))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          ),
        )
      ).flat();
      assert.equal(
        records.filter((record) => record.event === "large-request").length,
        1,
      );
      assert.ok(
        records.some((record) => record.event === "healthy-after-byte-backlog"),
      );
      assert.ok(warnings.some((message) => /write queue full/i.test(message)));
    } finally {
      console.error = originalError;
    }
  });
});

test("honors the E2E data directory for the default diagnostics path", async () => {
  await withTemporaryDirectory(async (directory) => {
    const previous = process.env.ARM_NATOR_E2E_DATA_DIR;
    process.env.ARM_NATOR_E2E_DATA_DIR = directory;
    try {
      assert.equal(
        getDefaultPlaybackDiagnosticsPath(),
        join(directory, "logs", "playback-diagnostics.jsonl"),
      );
    } finally {
      if (previous === undefined) delete process.env.ARM_NATOR_E2E_DATA_DIR;
      else process.env.ARM_NATOR_E2E_DATA_DIR = previous;
    }
  });
});

test("accepts provider and native hook event metadata from shared producers", async () => {
  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, "playback-diagnostics.jsonl");
    const store = new PlaybackDiagnosticsStore({ filePath });
    store.record({
      event: "provider-response",
      transport: "xtream-api",
      phase: "get-live-streams",
      operation: "get_live_streams",
      providerAuth: true,
      providerActiveConnections: 2,
      providerMaxConnections: 5,
      state: "playing",
    });
    await store.flush();
    const record = JSON.parse((await readFile(filePath, "utf8")).trim());
    assert.equal(record.event, "provider-response");
    assert.equal(record.type, undefined);
    assert.equal(record.transport, "xtream-api");
    assert.equal(record.phase, "get-live-streams");
    assert.equal(record.operation, "get_live_streams");
    assert.equal(record.providerAuth, true);
    assert.equal(record.providerActiveConnections, 2);
    assert.equal(record.providerMaxConnections, 5);
    assert.equal(record.state, "playing");
  });
});

test("keeps records valid for malformed inputs and reports a disk failure only once", async () => {
  await withTemporaryDirectory(async (directory) => {
    const validPath = join(directory, "valid.jsonl");
    const validStore = new PlaybackDiagnosticsStore({ filePath: validPath });
    assert.doesNotThrow(() => validStore.record(null as never));
    await validStore.flush();
    const parsed = JSON.parse((await readFile(validPath, "utf8")).trim());
    assert.equal(typeof parsed.timestamp, "string");

    const blockingPath = join(directory, "not-a-directory");
    await writeFile(blockingPath, "block");
    await chmod(blockingPath, 0o600);
    const failedStore = new PlaybackDiagnosticsStore({
      filePath: join(blockingPath, "playback-diagnostics.jsonl"),
    });
    const originalError = console.error;
    const failures: unknown[][] = [];
    console.error = (...values: unknown[]) => failures.push(values);
    try {
      assert.doesNotThrow(() => {
        failedStore.record({ event: "first" });
        failedStore.record({ event: "second" });
      });
      await failedStore.flush();
      assert.equal(failures.length, 1);
      assert.match(String(failures[0]?.[0]), /playback diagnostics/i);
    } finally {
      console.error = originalError;
    }
  });
});
