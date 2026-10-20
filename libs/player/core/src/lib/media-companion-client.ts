import type { AutoPlaybackPreparation } from "@arm-nator/shared/interfaces";

export interface MediaCompanionCapabilities {
  [key: string]: unknown;
}

export interface MediaCompanionClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Override for focused timeout tests; production defaults to twenty seconds. */
  requestTimeoutMs?: number;
}

export interface MediaCompanionPrepareRequest {
  url: string;
  headers?: Record<string, string>;
  isLive: boolean;
  mode: "proxy" | "remux" | "convert";
  allowConversion: boolean;
  audioOnly?: boolean;
  startTime?: number;
}

interface CompanionSessionResponse {
  id: string;
  url: string;
  format: AutoPlaybackPreparation["format"];
  container?: AutoPlaybackPreparation["container"];
  mimeType?: string;
  videoCodecs?: readonly string[];
  audioCodecs?: readonly string[];
  audioOnly?: boolean;
  encrypted?: boolean;
  processingMode?: AutoPlaybackPreparation["processingMode"];
  heartbeatIntervalMs?: number;
  timelineOffsetSeconds?: number;
  durationSeconds?: number;
}

interface SessionLease {
  preparation?: AutoPlaybackPreparation;
  metadataTimer?: ReturnType<typeof setTimeout>;
  timer: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/** Credentials are intentionally held in process memory only. */
export const mediaCompanionCredentials = (() => {
  let value: { baseUrl: string; token: string } | null = null;

  return {
    pair(baseUrl: string, token: string): void {
      value = { baseUrl: normalizeBaseUrl(baseUrl), token };
    },
    get(): { baseUrl: string; token: string } | null {
      return value ? { ...value } : null;
    },
    clear(): void {
      value = null;
    },
  };
})();

export class MediaCompanionError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
  ) {
    super(message);
    this.name = "MediaCompanionError";
  }
}

/** Control-plane client for an optional, separately paired media companion. */
export class MediaCompanionClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly leases = new Map<string, SessionLease>();
  private readonly releases = new Map<string, Promise<void>>();
  private readonly pendingWork = new Set<Promise<void>>();
  private readonly pendingReleaseIds = new Set<string>();

  constructor(options: MediaCompanionClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs);
  }

  async getCapabilities(signal?: AbortSignal): Promise<MediaCompanionCapabilities> {
    const response = await this.request("/api/capabilities", { signal });
    const body: unknown = await this.readJson(response);
    if (!isRecord(body)) {
      throw new MediaCompanionError(
        "Media companion returned an invalid capabilities response",
        response.status,
        "invalid_response",
      );
    }
    return body;
  }

  async prepare(
    input: MediaCompanionPrepareRequest,
    signal?: AbortSignal,
  ): Promise<AutoPlaybackPreparation> {
    if (signal?.aborted) {
      throw abortError();
    }

    // Do not pass the caller signal to session creation. If the caller stops
    // waiting while the server allocates, we still need the response ID so the
    // orphaned lease can be explicitly deleted.
    const allocation = this.allocateSession(input);
    if (!signal) {
      return (await allocation).preparation;
    }

    let removeAbortListener: (() => void) | undefined;
    let cleanupQueued = false;
    const queueLateCleanup = () => {
      if (cleanupQueued) {
        return;
      }
      cleanupQueued = true;
      this.trackPending(
        allocation.then(({ preparation }) => {
          this.pendingReleaseIds.add(preparation.id);
          return this.release(preparation.id);
        }),
      );
    };
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        queueLateCleanup();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });

    try {
      const { preparation } = await Promise.race([allocation, aborted]);
      if (signal.aborted) {
        queueLateCleanup();
        throw abortError();
      }
      return preparation;
    } catch (error) {
      if (signal.aborted) {
        queueLateCleanup();
        throw abortError();
      }
      throw error;
    } finally {
      removeAbortListener?.();
    }
  }

  /** Waits for aborted creates and their late-session deletes to settle. */
  async drainPending(): Promise<void> {
    let firstFailure: unknown;
    while (this.pendingWork.size > 0) {
      const work = [...this.pendingWork];
      const results = await Promise.allSettled(work);
      for (const result of results) {
        if (result.status === "rejected" && firstFailure === undefined) {
          firstFailure = result.reason;
        }
      }
    }
    if (firstFailure !== undefined) {
      throw firstFailure;
    }

    if (this.pendingReleaseIds.size > 0) {
      const retries = [...this.pendingReleaseIds].map((id) => {
        const retry = this.release(id);
        this.trackPending(retry);
        return retry;
      });
      const results = await Promise.allSettled(retries);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        throw failure.reason;
      }
    }
  }

  async heartbeat(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (lease?.inFlight) {
      return lease.inFlight;
    }
    const request = this.request(
      `/api/sessions/${encodeURIComponent(id)}/heartbeat`,
      { method: "POST" },
    ).then(async response => {
      if (response.status === 204) return;
      try { this.updateMetadata(id, await response.json()); } catch { /* A heartbeat can be empty. */ }
    });
    if (lease) {
      lease.inFlight = request;
      try {
        await request;
      } finally {
        if (lease.inFlight === request) {
          lease.inFlight = undefined;
        }
      }
      return;
    }
    await request;
  }

  async status(id: string): Promise<unknown> {
    const response = await this.request(
      `/api/sessions/${encodeURIComponent(id)}`,
    );
    const body = await this.readJson(response);
    this.updateMetadata(id, body);
    return body;
  }

  private updateMetadata(id: string, value: unknown): void {
    const preparation = this.leases.get(id)?.preparation;
    if (!preparation || !isRecord(value)) return;
    for (const key of ['durationSeconds', 'timelineOffsetSeconds'] as const) {
      const number = value[key];
      if (typeof number === 'number' && Number.isFinite(number) && number >= 0) preparation[key] = number;
    }
    if (typeof value['audioOnly'] === 'boolean') preparation.audioOnly = value['audioOnly'];
  }

  async release(id: string): Promise<void> {
    const existing = this.releases.get(id);
    if (existing) {
      return existing;
    }

    const lease = this.leases.get(id);
    if (lease) {
      clearInterval(lease.timer);
      clearTimeout(lease.metadataTimer);
    }

    const release = (async () => {
      if (lease?.inFlight) {
        await lease.inFlight.catch(() => undefined);
      }
      await this.request(
        `/api/sessions/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        { allowNotFound: true },
      );
      this.leases.delete(id);
      this.pendingReleaseIds.delete(id);
    })();
    this.releases.set(id, release);
    try {
      await release;
    } finally {
      if (this.releases.get(id) === release) {
        this.releases.delete(id);
      }
    }
  }

  private async allocateSession(
    input: MediaCompanionPrepareRequest,
  ): Promise<{ preparation: AutoPlaybackPreparation }> {
    const response = await this.request("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const payload: unknown = await this.readJson(response);
    if (
      !isRecord(payload) ||
      typeof payload["id"] !== "string" ||
      !payload["id"]
    ) {
      throw new MediaCompanionError(
        "Media companion returned an invalid session response",
        response.status,
        "invalid_response",
      );
    }
    const sessionId = payload["id"] as string;

    const interval = normalizeHeartbeatInterval(
      typeof payload["heartbeatIntervalMs"] === "number"
        ? payload["heartbeatIntervalMs"]
        : undefined,
    );
    const timer = setInterval(() => {
      void this.heartbeat(sessionId).catch(() => undefined);
    }, interval);
    this.leases.set(sessionId, { timer });

    if (!isSessionResponse(payload)) {
      await this.release(sessionId);
      throw new MediaCompanionError(
        "Media companion returned an invalid session response",
        response.status,
        "invalid_response",
      );
    }

    let mediaUrl: string;
    try {
      mediaUrl = this.normalizeMediaUrl(payload.url);
    } catch (error) {
      await this.release(sessionId);
      throw error;
    }

    const preparation: AutoPlaybackPreparation = {
      id: payload.id,
      url: mediaUrl,
      format: payload.format,
      ...(payload.container ? { container: payload.container } : {}),
      ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
      ...(typeof payload.timelineOffsetSeconds === 'number' ? { timelineOffsetSeconds: payload.timelineOffsetSeconds } : {}),
      ...(typeof payload.durationSeconds === 'number' ? { durationSeconds: payload.durationSeconds } : {}),
      ...(payload.videoCodecs ? { videoCodecs: payload.videoCodecs } : {}),
      ...(payload.audioCodecs ? { audioCodecs: payload.audioCodecs } : {}),
      ...(payload.audioOnly !== undefined
        ? { audioOnly: payload.audioOnly }
        : {}),
      ...(payload.encrypted !== undefined
        ? { encrypted: payload.encrypted }
        : {}),
      ...(payload.processingMode
        ? { processingMode: payload.processingMode }
        : {}),
    };

    const lease = this.leases.get(sessionId)!;
    lease.preparation = preparation;
    if (input.mode !== 'proxy') lease.metadataTimer = setTimeout(() => {
      void this.status(sessionId).catch(() => undefined);
    }, 1000);
    return { preparation };
  }

  private trackPending(work: Promise<void>): void {
    this.pendingWork.add(work);
    void work.finally(() => this.pendingWork.delete(work)).catch(() => undefined);
    void work.catch(() => undefined);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: { allowNotFound?: boolean } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const timeoutController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let removeCallerAbort: (() => void) | undefined;
    const timeoutError = () =>
      new MediaCompanionError(
        "Media companion request timed out",
        null,
        "timeout",
      );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timeoutController.abort();
        reject(timeoutError());
      }, this.requestTimeoutMs);
    });

    if (init.signal?.aborted) {
      clearTimeout(timeoutHandle);
      throw abortError();
    }
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : timeoutController.signal;
    const callerAbortPromise = init.signal
      ? new Promise<never>((_, reject) => {
          const onAbort = () => reject(abortError());
          init.signal?.addEventListener("abort", onAbort, { once: true });
          removeCallerAbort = () =>
            init.signal?.removeEventListener("abort", onAbort);
        })
      : new Promise<never>(() => undefined);

    try {
      const response = await Promise.race([
        this.fetcher(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          redirect: "error",
          signal,
        }),
        timeoutPromise,
        callerAbortPromise,
      ]);

      if (!response.ok && !(options.allowNotFound && response.status === 404)) {
        const code =
          (await Promise.race([
            safeErrorCode(response),
            timeoutPromise,
            callerAbortPromise,
          ])) ?? "http_error";
        throw new MediaCompanionError(
          `Media companion request failed (HTTP ${response.status}${code === "http_error" ? "" : `, ${code}`})`,
          response.status,
          code,
        );
      }
      return response;
    } catch (error) {
      if (init.signal?.aborted) {
        throw abortError();
      }
      if (timeoutController.signal.aborted) {
        throw timeoutError();
      }
      if (error instanceof MediaCompanionError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new MediaCompanionError(
          "Media companion rejected a redirected request",
          null,
          "redirect_rejected",
        );
      }
      throw new MediaCompanionError(
        "Media companion request failed",
        null,
        "network_error",
      );
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      removeCallerAbort?.();
    }
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      const text = await readResponseText(
        response,
        1_048_576,
        this.requestTimeoutMs,
      );
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof MediaCompanionError) {
        throw error;
      }
      throw new MediaCompanionError(
        "Media companion returned an invalid response",
        response.status,
        "invalid_response",
      );
    }
  }

  private normalizeMediaUrl(value: string): string {
    try {
      const mediaUrl = new URL(value, `${this.baseUrl}/`);
      const companionUrl = new URL(this.baseUrl);
      if (
        mediaUrl.origin !== companionUrl.origin ||
        mediaUrl.username ||
        mediaUrl.password
      ) {
        throw new Error("origin mismatch");
      }
      return mediaUrl.toString();
    } catch {
      throw new MediaCompanionError(
        "Media companion returned an invalid media URL",
        null,
        "invalid_response",
      );
    }
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback =
      hostname === "localhost" ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      (parsed.protocol === "http:" && !isLoopback) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("invalid");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new MediaCompanionError(
      "Enter a valid media companion HTTP or HTTPS address",
      null,
      "invalid_base_url",
    );
  }
}

function normalizeHeartbeatInterval(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1000) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS;
  }
  return Math.min(value, 5 * 60_000);
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0
    ? Math.min(value, 60_000)
    : 20_000;
}

async function safeErrorCode(response: Response): Promise<string | null> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 4096) {
    return null;
  }
  try {
    const text = await readResponseText(response, 4096, 20_000);
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || typeof body["code"] !== "string") {
      return null;
    }
    return /^[A-Za-z0-9_.-]{1,64}$/.test(body["code"])
      ? body["code"]
      : null;
  } catch {
    return null;
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new MediaCompanionError(
      "Media companion response exceeded the size limit",
      response.status,
      "response_too_large",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }

  const read = async (): Promise<string> => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done || !value) {
          break;
        }
        if (totalBytes + value.byteLength > maxBytes) {
          await reader.cancel();
          throw new MediaCompanionError(
            "Media companion response exceeded the size limit",
            response.status,
            "response_too_large",
          );
        }
        chunks.push(value);
        totalBytes += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      void reader.cancel();
      reject(
        new MediaCompanionError(
          "Media companion response timed out",
          null,
          "timeout",
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(), timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionResponse(value: unknown): value is CompanionSessionResponse {
  if (!isRecord(value)) {
    return false;
  }
  const required =
    typeof value["id"] === "string" &&
    value["id"].length > 0 &&
    typeof value["url"] === "string" &&
    value["url"].length > 0 &&
    ["hls", "mpegts", "progressive", "dash", "unknown"].includes(
      String(value["format"]),
    );
  if (!required) {
    return false;
  }

  return (
    isOptionalEnum(value, "container", [
      "mp4",
      "webm",
      "matroska",
      "mpegts",
      "hls",
      "dash",
    ]) &&
    isOptionalString(value, "mimeType") &&
    isOptionalStringArray(value, "videoCodecs") &&
    isOptionalStringArray(value, "audioCodecs") &&
    isOptionalBoolean(value, "audioOnly") &&
    isOptionalBoolean(value, "encrypted") &&
    isOptionalEnum(value, "processingMode", [
      "direct",
      "proxy",
      "remux",
      "convert",
    ]) &&
    isOptionalNumber(value, "heartbeatIntervalMs")
  );
}

function isOptionalEnum(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): boolean {
  return value[key] === undefined ||
    (typeof value[key] === "string" && allowed.includes(value[key] as string));
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || typeof value[key] === "string";
}

function isOptionalStringArray(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return (
    value[key] === undefined ||
    (Array.isArray(value[key]) &&
      value[key].every((entry: unknown) => typeof entry === "string"))
  );
}

function isOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return value[key] === undefined || typeof value[key] === "boolean";
}

function isOptionalNumber(value: Record<string, unknown>, key: string): boolean {
  return (
    value[key] === undefined ||
    (typeof value[key] === "number" && Number.isFinite(value[key]))
  );
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
