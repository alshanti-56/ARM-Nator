import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MediaCompanionClient,
  MediaCompanionError,
  mediaCompanionCredentials,
} from "./media-companion-client";

const preparationInput = {
  url: "https://provider.example/movie.mp4?token=provider-secret",
  headers: { Referer: "https://provider.example/" },
  isLive: false,
  mode: "remux" as const,
  allowConversion: false,
  startTime: 12,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("pairs ephemeral credentials and requests capabilities with bearer auth", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321/",
    token: "session-secret",
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return jsonResponse({ modes: ["direct", "remux"] });
    },
  });

  assert.deepEqual(await client.getCapabilities(), {
    modes: ["direct", "remux"],
  });
  assert.equal(requestedUrl, "http://127.0.0.1:4321/api/capabilities");
  assert.equal(
    new Headers(requestedInit?.headers).get("Authorization"),
    "Bearer session-secret",
  );

  mediaCompanionCredentials.pair("http://127.0.0.1:4321/", "session-secret");
  assert.deepEqual(mediaCompanionCredentials.get(), {
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
  });
  mediaCompanionCredentials.clear();
  assert.equal(mediaCompanionCredentials.get(), null);
});

test("calls the browser default fetch with its global receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (
    this: typeof globalThis,
    _input: RequestInfo | URL,
  ): Promise<Response> {
    assert.equal(this, globalThis);
    return Promise.resolve(jsonResponse({ modes: ["proxy"] }));
  };
  try {
    const client = new MediaCompanionClient({
      baseUrl: "http://127.0.0.1:4321",
      token: "session-secret",
    });
    assert.deepEqual(await client.getCapabilities(), { modes: ["proxy"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepares a retained session with the requested body and releases it", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return jsonResponse({
        id: "opaque-session-id",
        url: "http://127.0.0.1:4321/api/sessions/opaque-session-id/media",
        format: "progressive",
        container: "mp4",
        processingMode: "remux",
        status: "ready",
        heartbeatIntervalMs: 60_000,
      });
    },
  });

  const prepared = await client.prepare(preparationInput);
  assert.deepEqual(prepared, {
    id: "opaque-session-id",
    url: "http://127.0.0.1:4321/api/sessions/opaque-session-id/media",
    format: "progressive",
    container: "mp4",
    processingMode: "remux",
  });
  assert.equal(requests[0]?.url, "http://127.0.0.1:4321/api/sessions");
  assert.equal(requests[0]?.init?.method, "POST");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("Authorization"),
    "Bearer session-secret",
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), preparationInput);

  await client.release(prepared.id);
  assert.equal(requests.at(-1)?.url, "http://127.0.0.1:4321/api/sessions/opaque-session-id");
  assert.equal(requests.at(-1)?.init?.method, "DELETE");
});

test("cancelling creation releases a session allocated after the abort", async () => {
  const createResponse = deferred<Response>();
  const deleteStarted = deferred<void>();
  const deleteResponse = deferred<Response>();
  const requests: Array<{ url: string; method: string }> = [];
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });
      if (url.endsWith("/api/sessions") && method === "POST") {
        return createResponse.promise;
      }
      if (method === "DELETE") {
        deleteStarted.resolve();
        return deleteResponse.promise;
      }
      return new Response(null, { status: 204 });
    },
  });
  const controller = new AbortController();

  const pending = client.prepare(preparationInput, controller.signal);
  controller.abort();
  const drained = client.drainPending();
  await assert.rejects(pending, { name: "AbortError" });

  createResponse.resolve(
    jsonResponse({
      id: "late-session-id",
      url: "http://127.0.0.1:4321/api/sessions/late-session-id/media",
      format: "progressive",
      status: "ready",
    }),
  );
  await deleteStarted.promise;
  let drainSettled = false;
  void drained.then(() => {
    drainSettled = true;
  });
  await delay(0);
  assert.equal(drainSettled, false);
  deleteResponse.resolve(new Response(null, { status: 204 }));
  await drained;
  assert.equal(drainSettled, true);
  assert.ok(
    requests.some(
      ({ url, method }) =>
        url.endsWith("/api/sessions/late-session-id") && method === "DELETE",
    ),
  );
});

test("does not let the cleanup barrier hide a failed late-session delete", async () => {
  const createResponse = deferred<Response>();
  let deleteCount = 0;
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async (_input, init) => {
      if (init?.method === "POST") return createResponse.promise;
      deleteCount += 1;
      return deleteCount === 1
        ? jsonResponse({ code: "cleanup_failed" }, 503)
        : new Response(null, { status: 204 });
    },
  });
  const controller = new AbortController();
  const pending = client.prepare(preparationInput, controller.signal);

  controller.abort();
  const drained = client.drainPending();
  await assert.rejects(pending, { name: "AbortError" });
  createResponse.resolve(
    jsonResponse({
      id: "late-session-id",
      url: "http://127.0.0.1:4321/api/sessions/late-session-id/media",
      format: "progressive",
    }),
  );

  await assert.rejects(drained, (error: unknown) => {
    assert.ok(error instanceof MediaCompanionError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "cleanup_failed");
    return true;
  });
  await client.drainPending();
  assert.equal(deleteCount, 2);
});

test("release waits for an in-flight heartbeat and stops future heartbeats", async () => {
  const heartbeatStarted = deferred<void>();
  const finishHeartbeat = deferred<Response>();
  let heartbeatCount = 0;
  let deleteStarted = false;
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        return jsonResponse({
          id: "heartbeat-session-id",
          url: "http://127.0.0.1:4321/api/sessions/heartbeat-session-id/media",
          format: "progressive",
          status: "ready",
        heartbeatIntervalMs: 1000,
        });
      }
      if (url.endsWith("/heartbeat")) {
        heartbeatCount += 1;
        heartbeatStarted.resolve();
        return finishHeartbeat.promise;
      }
      if (init?.method === "DELETE") {
        deleteStarted = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    },
  });

  const prepared = await client.prepare(preparationInput);
  await heartbeatStarted.promise;
  const releasing = client.release(prepared.id);
  await delay(0);
  assert.equal(deleteStarted, false);

  finishHeartbeat.resolve(new Response(null, { status: 204 }));
  await releasing;
  assert.equal(deleteStarted, true);
  await delay(8);
  assert.equal(heartbeatCount, 1);
});

test("reports companion HTTP status without echoing tokens or provider URLs", async () => {
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async () =>
      jsonResponse(
        {
          code: "unauthorized",
          message: "session-secret https://provider.example/movie?token=provider-secret",
        },
        401,
      ),
  });

  await assert.rejects(client.getCapabilities(), (error: unknown) => {
    assert.ok(error instanceof MediaCompanionError);
    assert.equal(error.status, 401);
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes("session-secret"));
    assert.ok(!error.message.includes("provider-secret"));
    return true;
  });
});

test("uses the REST session status path and treats an expired delete as released", async () => {
  const urls: string[] = [];
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    fetch: async (input) => {
      urls.push(String(input));
      if (String(input).endsWith("/opaque-id")) {
        return jsonResponse({ status: "ready" });
      }
      return jsonResponse({ code: "session_not_found" }, 404);
    },
  });

  assert.deepEqual(await client.status("opaque-id"), { status: "ready" });
  await client.release("expired-id");
  assert.ok(urls.includes("http://127.0.0.1:4321/api/sessions/opaque-id"));
  assert.ok(urls.includes("http://127.0.0.1:4321/api/sessions/expired-id"));
});

test("bounds requests, rejects redirects, and preserves only a safe server error code", async () => {
  let requestInit: RequestInit | undefined;
  const client = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    requestTimeoutMs: 15,
    fetch: async (_input, init) => {
      requestInit = init;
      return jsonResponse(
        { code: "conversion_disabled", message: "session-secret" },
        422,
      );
    },
  });

  await assert.rejects(client.getCapabilities(), (error: unknown) => {
    assert.ok(error instanceof MediaCompanionError);
    assert.equal(error.code, "conversion_disabled");
    assert.ok(!error.message.includes("session-secret"));
    return true;
  });
  assert.equal(requestInit?.redirect, "error");
  assert.ok(requestInit?.signal);

  const hangingClient = new MediaCompanionClient({
    baseUrl: "http://127.0.0.1:4321",
    token: "session-secret",
    requestTimeoutMs: 15,
    fetch: () => new Promise<Response>(() => undefined),
  });
  await assert.rejects(hangingClient.getCapabilities(), {
    name: "MediaCompanionError",
    code: "timeout",
  });
});

test("rejects insecure remote endpoints and media URLs containing another origin or credentials", async () => {
  assert.throws(
    () => new MediaCompanionClient({ baseUrl: "http://companion.example", token: "t" }),
    { code: "invalid_base_url" },
  );

  const requests: Array<{ url: string; method: string }> = [];
  const client = new MediaCompanionClient({
    baseUrl: "https://companion.example",
    token: "session-secret",
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return jsonResponse({
          id: "safe-id",
          url: "https://provider.example/movie?token=provider-secret",
          format: "progressive",
        });
    },
  });
  await assert.rejects(client.prepare(preparationInput), {
    code: "invalid_response",
  });
  assert.ok(
    requests.some(
      ({ url, method }) => url.endsWith("/api/sessions/safe-id") && method === "DELETE",
    ),
  );
});
