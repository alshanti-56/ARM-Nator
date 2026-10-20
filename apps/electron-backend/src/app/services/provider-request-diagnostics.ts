import type { ValidatedHttpObserver } from "../util/validated-axios";
import { isStalkerAuthFailureResponse } from "@arm-nator/shared/interfaces";
import {
  playbackDiagnostics,
  type PlaybackDiagnosticsStore,
  type PlaybackDiagnosticHeaders,
} from "./playback-diagnostics.service";

function headersForDiagnostics(
  headers?: Record<string, unknown>,
): PlaybackDiagnosticHeaders | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => [
        name,
        Array.isArray(value) ? value.map(String) : String(value),
      ]),
  );
}

function connectionCount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

export function createProviderDiagnosticsObserver(
  transport: "xtream-api" | "stalker-api",
  operation: string,
  sessionId?: string,
  store: Pick<PlaybackDiagnosticsStore, "record"> = playbackDiagnostics,
): ValidatedHttpObserver {
  return (attempt) => {
    const data = attempt.responseData;
    const userInfo =
      data && typeof data === "object" && "user_info" in data
        ? data.user_info
        : undefined;
    const account =
      userInfo && typeof userInfo === "object"
        ? (userInfo as Record<string, unknown>)
        : undefined;
    const auth = account?.auth;
    let providerAuth =
      auth === 1 || auth === "1" || auth === true
        ? true
        : auth === 0 || auth === "0" || auth === false
          ? false
          : undefined;
    if (transport === "stalker-api") {
      if (isStalkerAuthFailureResponse(data)) {
        providerAuth = false;
      } else if (
        operation === "handshake" &&
        data &&
        typeof data === "object" &&
        "js" in data
      ) {
        const js = data.js;
        if (
          js &&
          typeof js === "object" &&
          "token" in js &&
          typeof js.token === "string" &&
          js.token.trim()
        ) {
          providerAuth = true;
        }
      }
    }
    store.record({
      event: attempt.error ? "provider-error" : "provider-response",
      transport,
      operation,
      sessionId,
      requestUrl: attempt.requestUrl,
      responseUrl:
        attempt.status === undefined ? undefined : attempt.requestUrl,
      requestHeaders: headersForDiagnostics(attempt.requestHeaders),
      responseHeaders: headersForDiagnostics(attempt.responseHeaders),
      status: attempt.status,
      durationMs: attempt.durationMs,
      phase:
        attempt.redirectCount === 0
          ? "initial"
          : `redirect-${attempt.redirectCount}`,
      error: attempt.error,
      providerAuth,
      providerActiveConnections: connectionCount(account?.active_cons),
      providerMaxConnections: connectionCount(account?.max_connections),
    });
  };
}
