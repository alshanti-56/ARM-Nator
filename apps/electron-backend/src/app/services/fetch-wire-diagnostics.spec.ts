import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  withFetchDiagnostics,
  type FetchWireEvent,
} from "./fetch-wire-diagnostics";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("retains a provider's custom HTTP reason phrase without reading or changing its body", async () => {
  const server = createServer((_request, response) => {
    response
      .writeHead(509, "Provider quota exceeded")
      .end("provider explanation");
  });
  const url = await listen(server);
  const events: FetchWireEvent[] = [];
  try {
    const response = await withFetchDiagnostics(
      () => fetch(url),
      (event) => events.push(event),
    );
    assert.equal(response.status, 509);
    assert.equal(await response.text(), "provider explanation");
    assert.equal(
      events.find((event) => event.event === "upstream-hop-response")?.details,
      "Provider quota exceeded",
    );
  } finally {
    await close(server);
  }
});

test("captures actual default User-Agent and every redirect status without changing request headers", async () => {
  let observedUserAgent: string | undefined;
  const edge = createServer((request, response) => {
    observedUserAgent = request.headers["user-agent"];
    assert.equal(request.headers.authorization, undefined);
    response
      .writeHead(401, { "set-cookie": ["a=exact-token", "b=other-token"] })
      .end();
  });
  const edgeUrl = await listen(edge);
  const source = createServer((_request, response) => {
    response
      .writeHead(302, { Location: `${edgeUrl}/playlist?token=exact-url-token` })
      .end();
  });
  const sourceUrl = await listen(source);
  const events: FetchWireEvent[] = [];
  try {
    const response = await withFetchDiagnostics(
      () =>
        fetch(sourceUrl, {
          headers: { Authorization: "Bearer exact-auth-token" },
        }),
      (event) => events.push(event),
    );
    await response.text();
    assert.equal(response.status, 401);
    const requests = events.filter(
      (event) => event.event === "upstream-request",
    );
    const responses = events.filter(
      (event) => event.event === "upstream-hop-response",
    );
    assert.deepEqual(
      responses.map((event) => event.status),
      [302, 401],
    );
    assert.equal(requests[1].requestHeaders?.["user-agent"], observedUserAgent);
    assert.equal(observedUserAgent, "node");
    assert.equal(
      requests[0].requestHeaders?.authorization,
      "Bearer exact-auth-token",
    );
    assert.equal(requests[1].requestHeaders?.authorization, undefined);
    assert.ok(requests[1].requestUrl.endsWith("token=exact-url-token"));
    assert.deepEqual(responses[1].responseHeaders?.["set-cookie"], [
      "a=exact-token",
      "b=other-token",
    ]);
  } finally {
    await close(source);
    await close(edge);
  }
});

test("concurrent requests keep their own diagnostic context and unrelated fetches stay unrecorded", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  const url = await listen(server);
  const left: FetchWireEvent[] = [];
  const right: FetchWireEvent[] = [];
  try {
    await Promise.all([
      withFetchDiagnostics(
        () => fetch(`${url}/left`),
        (event) => left.push(event),
      ),
      withFetchDiagnostics(
        () => fetch(`${url}/right`),
        (event) => right.push(event),
      ),
      fetch(`${url}/unrelated`),
    ]);
    assert.ok(left.length >= 2);
    assert.ok(right.length >= 2);
    assert.ok(left.every((event) => event.requestUrl.endsWith("/left")));
    assert.ok(right.every((event) => event.requestUrl.endsWith("/right")));
    const response = await withFetchDiagnostics(
      () => fetch(`${url}/observer-failure`),
      () => {
        throw new Error("observer unavailable");
      },
    );
    assert.equal(await response.text(), "ok");
  } finally {
    await close(server);
  }
});
