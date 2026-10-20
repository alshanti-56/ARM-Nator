import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../playback-diagnostics.mjs", import.meta.url);

test("diagnostics export preserves exact replay data and optionally removes it for sharing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arm-nator-diagnostics-cli-"));
  const record = {
    timestamp: "2026-10-12T09:00:00.000Z",
    event: "upstream-response",
    sessionId: "session-1",
    status: 401,
    requestUrl:
      "https://provider.test/live/account-name/account-password/979.m3u8?token=opaque-secret",
    responseUrl: "https://edge.test/opaque-path-secret?token=edge-secret",
    requestHeaders: {
      authorization: "Bearer private-value",
      cookie: "session=secret-cookie",
    },
    error: {
      name: "Error",
      code: "HTTP_401",
      message: "private-error-message",
    },
  };
  try {
    await writeFile(
      join(directory, "playback-diagnostics.1.jsonl"),
      JSON.stringify({ ...record, status: 200 }) + "\n",
    );
    await writeFile(
      join(directory, "playback-diagnostics.jsonl"),
      JSON.stringify(record) + "\n" + "{incomplete",
    );
    const run = (...args) =>
      execFileSync(
        process.execPath,
        [cli.pathname, "--directory", directory, ...args],
        { encoding: "utf8" },
      );
    const full = JSON.parse(run("--json", "--last", "1"));
    assert.equal(full[0].status, 401);
    assert.equal(full[0].requestUrl, record.requestUrl);
    assert.equal(full[0].requestHeaders.cookie, "session=secret-cookie");
    const shared = run("--json", "--redact");
    for (const value of [
      "account-name",
      "account-password",
      "opaque-secret",
      "opaque-path-secret",
      "edge-secret",
      "private-value",
      "secret-cookie",
      "private-error-message",
    ]) {
      assert.ok(!shared.includes(value), `sharing export leaked ${value}`);
    }
    assert.ok(shared.includes("provider.test"));
    assert.deepEqual(
      JSON.parse(run("--json")).map((event) => event.status),
      [200, 401],
    );
    assert.ok(run().includes("401"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
