import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { PlaybackDiagnosticHeaders } from "./playback-diagnostics.service";

export interface FetchWireEvent {
  event: "upstream-request" | "upstream-hop-response" | "upstream-hop-error";
  requestUrl: string;
  requestHeaders?: PlaybackDiagnosticHeaders;
  responseHeaders?: PlaybackDiagnosticHeaders;
  status?: number;
  durationMs?: number;
  error?: unknown;
  details?: string;
}

type Observer = (event: FetchWireEvent) => void;
type Request = { origin: string | URL; path: string };
type RequestContext = {
  observer: Observer;
  startedAt: number;
  headers?: PlaybackDiagnosticHeaders;
};
const observers = new AsyncLocalStorage<Observer>();
const requests = new WeakMap<Request, RequestContext>();

function addHeader(
  headers: PlaybackDiagnosticHeaders,
  name: string,
  value: string,
): void {
  const key = name.toLowerCase();
  const previous = headers[key];
  headers[key] =
    previous === undefined
      ? value
      : [...(Array.isArray(previous) ? previous : [previous]), value];
}

function publish(
  request: Request,
  event: Omit<FetchWireEvent, "requestUrl">,
): void {
  const context = requests.get(request);
  if (!context) return;
  context.observer({
    ...event,
    requestUrl: new URL(request.path, request.origin).toString(),
  });
}

// These passive Undici channels expose the actual HTTP headers and redirect
// hops. Subscribers must never throw or modify requests.
channel("undici:request:create").subscribe((message) => {
  try {
    const observer = observers.getStore();
    const { request } = message as { request: Request };
    if (observer)
      requests.set(request, { observer, startedAt: performance.now() });
  } catch {
    /* Diagnostics must not affect the request. */
  }
});

channel("undici:client:sendHeaders").subscribe((message) => {
  try {
    const { request, headers: raw } = message as {
      request: Request;
      headers: string;
    };
    const context = requests.get(request);
    if (!context) return;
    const headers: PlaybackDiagnosticHeaders = {};
    for (const line of raw.split("\r\n").slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0)
        addHeader(
          headers,
          line.slice(0, separator),
          line.slice(separator + 1).trim(),
        );
    }
    context.headers = headers;
    publish(request, { event: "upstream-request", requestHeaders: headers });
  } catch {
    /* Diagnostics must not affect the request. */
  }
});

channel("undici:request:headers").subscribe((message) => {
  try {
    const { request, response } = message as {
      request: Request;
      response: {
        statusCode: number;
        statusText?: string;
        headers: Buffer[] | Record<string, string | string[]>;
      };
    };
    const context = requests.get(request);
    if (!context) return;
    const headers: PlaybackDiagnosticHeaders = {};
    if (Array.isArray(response.headers)) {
      for (let index = 0; index + 1 < response.headers.length; index += 2) {
        addHeader(
          headers,
          response.headers[index].toString(),
          response.headers[index + 1].toString(),
        );
      }
    } else {
      for (const [key, value] of Object.entries(response.headers))
        headers[key.toLowerCase()] = value;
    }
    publish(request, {
      event: "upstream-hop-response",
      requestHeaders: context.headers,
      responseHeaders: headers,
      status: response.statusCode,
      details: response.statusText,
      durationMs: performance.now() - context.startedAt,
    });
  } catch {
    /* Diagnostics must not affect the request. */
  }
});

channel("undici:request:error").subscribe((message) => {
  try {
    const { request, error } = message as { request: Request; error: unknown };
    const context = requests.get(request);
    if (!context) return;
    publish(request, {
      event: "upstream-hop-error",
      requestHeaders: context.headers,
      error,
      durationMs: performance.now() - context.startedAt,
    });
  } catch {
    /* Diagnostics must not affect the request. */
  }
});

export function withFetchDiagnostics<T>(
  operation: () => Promise<T>,
  observer: Observer,
): Promise<T> {
  return observers.run(observer, operation);
}
