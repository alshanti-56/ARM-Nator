import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  requestWithValidatedRedirects,
  type ValidatedHttpAttempt,
} from "./validated-axios";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("provider diagnostics distinguish successful account authentication from a rejected media host", async () => {
  const media = createServer((_request, response) =>
    response.writeHead(401).end(),
  );
  const mediaUrl = await listen(media);
  const gateway = createServer((request, response) => {
    if (request.url?.startsWith("/player_api.php")) {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ user_info: { auth: 1, max_connections: "1" } }),
      );
    } else {
      response
        .writeHead(302, {
          Location: `${mediaUrl}/playlist?token=exact-replay-token`,
        })
        .end();
    }
  });
  const gatewayUrl = await listen(gateway);
  const attempts: ValidatedHttpAttempt[] = [];
  try {
    const account = await requestWithValidatedRedirects<{
      user_info: { auth: number };
    }>(
      `${gatewayUrl}/player_api.php?username=replay-user&password=replay-password`,
      { headers: { "User-Agent": "VLC/Test", Cookie: "session=exact-cookie" } },
      { allowPrivateNetworks: true },
      5,
      (attempt) => attempts.push(attempt),
    );
    assert.equal(account.data.user_info.auth, 1);
    await assert.rejects(
      requestWithValidatedRedirects(
        `${gatewayUrl}/live`,
        {},
        { allowPrivateNetworks: true },
        5,
        (attempt) => attempts.push(attempt),
      ),
    );
    assert.deepEqual(
      attempts.map((attempt) => attempt.status),
      [200, 302, 401],
    );
    assert.ok(attempts[0].requestUrl.includes("password=replay-password"));
    assert.equal(attempts[0].requestHeaders.cookie, "session=exact-cookie");
    assert.deepEqual(attempts[0].responseData, {
      user_info: { auth: 1, max_connections: "1" },
    });
    assert.equal(new URL(attempts[2].requestUrl).origin, mediaUrl);
    assert.ok(attempts[2].requestUrl.endsWith("token=exact-replay-token"));
    assert.ok(attempts.every((attempt) => attempt.durationMs >= 0));
  } finally {
    await close(gateway);
    await close(media);
  }
});

test("diagnostic observer failure cannot break successful provider requests", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  const url = await listen(server);
  let called = false;
  try {
    const response = await requestWithValidatedRedirects(
      url,
      {},
      { allowPrivateNetworks: true },
      5,
      () => {
        called = true;
        throw new Error("diagnostics unavailable");
      },
    );
    assert.equal(response.data, "ok");
    assert.equal(called, true);
  } finally {
    await close(server);
  }
});

test("provider diagnostics retain transport errors without replacing the request failure", async () => {
  const server = createServer((_request, response) => response.destroy());
  const url = await listen(server);
  const attempts: ValidatedHttpAttempt[] = [];
  try {
    await assert.rejects(
      requestWithValidatedRedirects(
        url,
        {},
        { allowPrivateNetworks: true },
        5,
        (attempt) => attempts.push(attempt),
      ),
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].requestUrl, `${url}/`);
    assert.ok(attempts[0].error instanceof Error);
    assert.equal(attempts[0].status, undefined);
  } finally {
    await close(server);
  }
});

test("diagnostic metadata extraction failures cannot replace a successful provider response", async () => {
  const response = await requestWithValidatedRedirects(
    "http://127.0.0.1/",
    {
      adapter: async (config) => ({
        status: 200, statusText: "OK", headers: {}, config, data: "ok",
        request: { getHeaders() { throw new Error("header inspection unavailable"); } },
      }),
    },
    { allowPrivateNetworks: true },
    5,
    () => undefined,
  );
  assert.equal(response.data, "ok");
});
