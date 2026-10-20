import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const electronBinary = require("electron");
const fixtureScript = fileURLToPath(
  new URL("./electron-undici-backpressure.fixture.cjs", import.meta.url),
);
const body = Buffer.alloc(64 * 1024, 0x61);
const childTimeoutMs = 10_000;

test(
  "Electron's provider HTTP client survives socket EOF while a response is backpressured",
  { timeout: 15_000 },
  async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
        );
        socket.write(body);
        socket.end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(electronBinary, [fixtureScript, `http://127.0.0.1:${address.port}/`], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Electron fixture did not exit within ${childTimeoutMs} ms.`));
        }, childTimeoutMs);
        child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, stdout, stderr });
        });
      });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /response body remained intact through socket EOF \(65536 bytes\)/);
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  },
);
