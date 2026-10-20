import {
  STALKER_SEARCH_PAGE,
  stalkerDiscoveryPage,
  isStalkerAuthFailureResponse,
} from "@arm-nator/shared/interfaces";
import type {
  StalkerSearchRequestPayload,
  StalkerSearchPageResponse,
} from "@arm-nator/shared/interfaces";
import { StalkerRequestCancellation } from "../services/stalker-request-cancellation";
import { STALKER_CANCEL_REQUEST } from "@arm-nator/shared/interfaces";
import type { StalkerRequestPayload } from "@arm-nator/shared/interfaces";
/**
 * This module handles all Stalker portal related IPC communications
 * between the frontend and the electron backend.
 */

import axios, { AxiosRequestConfig } from "axios";
import { ipcMain } from "electron";
import {
  classifyStalkerAuthFailureBody,
  createStalkerAuthFailureMarker,
  PortalDebugEvent,
  STALKER_REQUEST,
  buildStalkerIdentityRequestContext,
  buildStalkerRequestUrl,
} from "@arm-nator/shared/interfaces";
import { redactSensitiveData } from "@arm-nator/shared/logging";
import { rememberStalkerPlaybackContext } from "../services/stalker-playback-context.service";
import { emitPortalDebugEvent } from "./portal-debug.events";
import { assertRemoteUrlAllowed } from "./url-safety";
import { requestWithValidatedRedirects } from "../util/validated-axios";
import { createProviderDiagnosticsObserver } from "../services/provider-request-diagnostics";
import { playbackAccountProfiles } from "../services/playback-account-profile.service";

export default class StalkerEvents {
  static bootstrapStalkerEvents(): Electron.IpcMain {
    return ipcMain;
  }
}

type StalkerResponseData = {
  js?: {
    cmd?: unknown;
  };
  [key: string]: unknown;
};

const stalkerRequests = new StalkerRequestCancellation();
const cancellationOwners = new WeakSet<Electron.WebContents>();
ipcMain.handle(STALKER_CANCEL_REQUEST, (event, requestId: string) => ({
  cancelled: stalkerRequests.cancel(event.sender.id, requestId),
}));

/**
 * Handle Stalker API requests with MAC address cookie and optional Bearer token
 */
const handleStalkerRequest = async (
  event: Electron.IpcMainInvokeEvent,
  payload: StalkerRequestPayload,
) => {
  const lease = stalkerRequests.begin(event.sender.id, payload.requestId);
  if (!cancellationOwners.has(event.sender)) {
    cancellationOwners.add(event.sender);
    const ownerId = event.sender.id;
    event.sender.once("destroyed", () => stalkerRequests.cancelOwner(ownerId));
  }
  const startedAt = Date.now();
  let debugRequest: Record<string, unknown> | undefined;
  try {
    const { url, macAddress, params, token, serialNumber, requestId } = payload;
    const { requestParams, headers, effectiveSerialNumber } =
      buildStalkerIdentityRequestContext({
        macAddress,
        params,
        token,
        serialNumber,
      });

    // SSRF/LFI guard: block non-http(s)/credentialed portal URLs.
    // Private/LAN targets remain allowed (users run local Stalker servers).
    await assertRemoteUrlAllowed(url, { allowPrivateNetworks: true });

    const fullUrl = buildStalkerRequestUrl(url, requestParams);

    // Determine timeout based on action type
    // create_link requests can take longer as server generates stream URL
    const isCreateLink = requestParams.action === "create_link";
    const defaultTimeout = isCreateLink ? 30000 : 15000;
    const requestTimeout =
      typeof payload.timeoutMs === "number" &&
      Number.isFinite(payload.timeoutMs)
        ? Math.max(1, Math.min(defaultTimeout, payload.timeoutMs))
        : defaultTimeout;

    // Configure axios request
    const config: AxiosRequestConfig = {
      method: "GET",
      signal: lease.signal,
      url: fullUrl,
      headers,
      timeout: requestTimeout,
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
    };
    debugRequest = {
      method: config.method ?? "GET",
      url: fullUrl,
      headers,
      timeout: requestTimeout,
      params: requestParams,
    };

    const response = await requestWithValidatedRedirects<StalkerResponseData>(
      fullUrl,
      config,
      { allowPrivateNetworks: true },
      5,
      createProviderDiagnosticsObserver(
        "stalker-api",
        String(params.action ?? "unknown"),
      ),
    );

    const isPortalLogin = requestParams.action === "do_auth";

    // Check if response is successful
    if (response.status >= 400) {
      console.error(
        "[StalkerEvents] HTTP Error:",
        response.status,
        response.statusText,
      );
      // The numeric code must live in the MESSAGE: ipcRenderer
      // strips custom properties from rejected values, and the
      // renderer's endpoint discovery needs to tell a 404 (probe
      // next candidate) from a network failure (stop probing).
      const httpError = new Error(
        `HTTP Error ${response.status}: ${response.statusText}`,
      ) as Error & { status: number };
      httpError.status = response.status;
      throw httpError;
    }

    // The portal answers auth failures with HTTP 200 and a plain
    // text/html body ("Authorization failed.", "Access denied.",
    // "Unauthorized request."). Classify them here so the renderer
    // receives a structured marker instead of pattern-matching raw
    // response text.
    const authFailureBody = classifyStalkerAuthFailureBody(response.data);
    const isPortalLogout = requestParams.action === "do_logout";
    if (isPortalLogout && !authFailureBody && payload.accountRef) {
      playbackAccountProfiles.clear(payload.accountRef);
    }
    if (!isPortalLogout && !authFailureBody && payload.accountRef) {
      const portalOrigin = new URL(url).origin;
      playbackAccountProfiles.replacePortalHeaders(payload.accountRef, {
        ...headers,
        Origin: portalOrigin,
        Referer: portalOrigin,
      });
    }
    if (isPortalLogin && !authFailureBody && payload.accountRef) {
      const rawSetCookie = response.headers["set-cookie"];
      const setCookieHeaders = Array.isArray(rawSetCookie)
        ? rawSetCookie
        : typeof rawSetCookie === "string"
          ? [rawSetCookie]
          : undefined;
      const responseUrl = response.request?.res?.responseUrl ?? fullUrl;
      playbackAccountProfiles.captureLoginCookies(
        payload.accountRef,
        responseUrl,
        setCookieHeaders,
      );
    }
    const responseData = authFailureBody
      ? createStalkerAuthFailureMarker(authFailureBody)
      : response.data;

    // Return the response data
    if (
      params.action === "create_link" &&
      response.data?.js?.cmd &&
      typeof response.data.js.cmd === "string"
    ) {
      rememberStalkerPlaybackContext({
        streamUrl: response.data.js.cmd,
        portalUrl: url,
        macAddress,
        serialNumber: effectiveSerialNumber,
        token,
      });
    }

    if (requestId) {
      const debugEvent: PortalDebugEvent = {
        requestId,
        provider: "stalker",
        operation: String(params.action ?? "unknown"),
        transport: "electron-main",
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status: "success",
        request: debugRequest,
        response: responseData,
      };
      emitPortalDebugEvent(debugEvent);
    }

    return responseData;
  } catch (error) {
    if (payload.requestId) {
      const debugEvent: PortalDebugEvent = {
        requestId: payload.requestId,
        provider: "stalker",
        operation: String(payload.params?.action ?? "unknown"),
        transport: "electron-main",
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        status: "error",
        request: debugRequest ?? {
          method: "GET",
          url: payload.url,
          params: payload.params,
        },
        error,
      };
      emitPortalDebugEvent(debugEvent);
    }

    console.error("[StalkerEvents] Request error:", redactSensitiveData(error));

    // Format error response
    if (axios.isAxiosError(error) && error.response) {
      // A real HTTP response (5xx lands here via validateStatus).
      // Same parseable message shape as the 4xx branch: only the
      // message crosses ipcRenderer.invoke, and the renderer's
      // endpoint discovery must tell "this endpoint answered 5xx —
      // try the next candidate" from a host-level failure.
      const httpError = new Error(
        `HTTP Error ${error.response.status}: ${error.response.statusText ?? ""}`,
      ) as Error & { status: number };
      httpError.status = error.response.status;
      throw httpError;
    } else if (axios.isAxiosError(error)) {
      // A real Error, not a plain object: Electron serializes
      // handler rejections via toString(), so a plain object
      // reaches the renderer as "[object Object]" and its
      // timeout-vs-connection classification is lost — discovery
      // would stop probing as if the whole host were unreachable.
      throw new Error(
        error.message || "Failed to fetch data from Stalker portal",
        { cause: error },
      );
    } else if (error && typeof error === "object" && "message" in error) {
      throw error;
    } else {
      throw {
        type: "ERROR",
        message: "An unknown error occurred",
        status: 500,
      };
    }
  } finally {
    lease.release();
  }
};

ipcMain.handle(STALKER_REQUEST, handleStalkerRequest);
ipcMain.handle(
  STALKER_SEARCH_PAGE,
  async (
    event,
    payload: StalkerSearchRequestPayload,
  ): Promise<StalkerSearchPageResponse> => {
    const context = payload.discovery;
    if (
      !context ||
      context.playlistId !== payload.accountRef ||
      typeof context.providerName !== "string" ||
      !["movie", "series", "live"].includes(context.page?.contentType) ||
      !Number.isSafeInteger(context.page.page) ||
      context.page.page < 1 ||
      payload.params.action !== "get_ordered_list"
    )
      throw new Error("Invalid portal search request");
    const response = await handleStalkerRequest(event, payload);
    if (isStalkerAuthFailureResponse(response))
      return response as StalkerSearchPageResponse;
    return stalkerDiscoveryPage(
      response,
      context.playlistId,
      context.providerName,
      context.page,
    );
  },
);
