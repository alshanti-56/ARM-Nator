/**
 * This module handles all Xtream Codes API related IPC communications
 * between the frontend and the electron backend.
 */

import axios, { AxiosRequestConfig } from 'axios';
import { ipcMain } from 'electron';
import {
    PortalDebugEvent,
    XTREAM_CANCEL_SESSION,
    normalizeXtreamServerUrl,
} from '@arm-nator/shared/interfaces';
import { redactSensitiveData } from '@arm-nator/shared/logging';
import { emitPortalDebugEvent } from './portal-debug.events';
import { UnsafeUrlError } from './url-safety';
import { requestWithValidatedRedirects } from '../util/validated-axios';
import { createProviderDiagnosticsObserver } from '../services/provider-request-diagnostics';
import { playbackAccountProfiles } from '../services/playback-account-profile.service';

// Some Xtream panels sit behind Cloudflare (or similar WAFs) configured to
// challenge generic browser-looking User-Agents while allowlisting known
// IPTV player clients. A VLC-style User-Agent reliably passes those checks.
const XTREAM_CLIENT_USER_AGENT = 'VLC/3.0.18 LibVLC/3.0.18';

interface XtreamRequestError {
    type: 'ERROR';
    status: number;
    message: string;
    name?: 'AbortError';
}

function getXtreamHttpErrorMessage(status: number): string {
    switch (status) {
        case 401:
            return 'Xtream server rejected the credentials';
        case 403:
            return 'Xtream server denied access';
        case 404:
            return 'Xtream API endpoint was not found';
        case 429:
            return 'Xtream server is rate limiting requests';
        default:
            return `Xtream server returned HTTP ${status}`;
    }
}

function xtreamError(
    status: number,
    message: string,
    name?: 'AbortError'
): XtreamRequestError {
    return { type: 'ERROR', status, message, ...(name ? { name } : {}) };
}

function toXtreamRequestError(error: unknown): XtreamRequestError {
    if (axios.isAxiosError(error)) {
        if (error.code === 'ERR_CANCELED') {
            return xtreamError(499, 'Xtream request cancelled', 'AbortError');
        }

        if (error.response) {
            const status = error.response.status;
            return xtreamError(status, getXtreamHttpErrorMessage(status));
        }

        return xtreamError(
            500,
            error.code === 'ECONNABORTED'
                ? 'Xtream server did not respond in time'
                : 'Could not connect to Xtream server'
        );
    }

    if (error instanceof UnsafeUrlError) {
        return xtreamError(error.status, 'Xtream server URL is not allowed');
    }

    if (error && typeof error === 'object' && 'status' in error) {
        const status = (error as { status: unknown }).status;
        if (typeof status === 'number' && status >= 400 && status <= 599) {
            return xtreamError(status, getXtreamHttpErrorMessage(status));
        }
    }

    return xtreamError(500, 'Failed to fetch data from Xtream server');
}

export default class XtreamEvents {
    static bootstrapXtreamEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

function formatXtreamError(
    error: unknown,
    requestUrl: string,
    action?: string
) {
    let parsedUrl: URL | null;
    try {
        parsedUrl = new URL(requestUrl);
    } catch {
        parsedUrl = null;
    }
    const base = {
        action,
        host: parsedUrl?.host ?? 'unknown',
        pathname: parsedUrl?.pathname ?? requestUrl,
    };

    if (axios.isAxiosError(error)) {
        return {
            ...base,
            type: 'AxiosError',
            code: error.code,
            status: error.response?.status,
            message: error.message,
            syscall: (error as NodeJS.ErrnoException).syscall,
            hostname: (error as any).hostname,
        };
    }

    if (error && typeof error === 'object') {
        const errObj = error as Record<string, unknown>;
        return {
            ...base,
            type: 'ErrorObject',
            status: errObj.status,
            message: errObj.message,
        };
    }

    return {
        ...base,
        type: 'UnknownError',
        message: String(error),
    };
}

function buildXtreamApiUrl(url: string, params: Record<string, string>): URL {
    const baseUrl = normalizeXtreamServerUrl(url);
    const apiUrl = new URL(`${baseUrl}/player_api.php`);
    Object.entries(params).forEach(([key, value]) => {
        apiUrl.searchParams.append(
            key,
            key === 'username' || key === 'password' ? value.trim() : value
        );
    });

    return apiUrl;
}

/**
 * Handle Xtream Codes API requests
 */
ipcMain.handle(
    'XTREAM_REQUEST',
    async (
        event,
        payload: {
            url: string;
            params: Record<string, string>;
            requestId?: string;
            sessionId?: string;
            suppressErrorLog?: boolean;
            accountRef?: string;
        }
    ) => {
        const startedAt = Date.now();
        let activeRequestKey: string | null = null;
        let requestUrlForLog = payload.url;
        try {
            const { url, params, requestId, sessionId } = payload;

            // Build URL with query parameters
            // Xtream API endpoint is always at /player_api.php
            const apiUrl = buildXtreamApiUrl(url, params);
            requestUrlForLog = apiUrl.toString();

            const controller = new AbortController();
            if (requestId || sessionId) {
                activeRequestKey = requestId ?? crypto.randomUUID();
                activeXtreamRequests.set(activeRequestKey, {
                    controller,
                    sessionId,
                });
            }

            // Configure axios request
            const config: AxiosRequestConfig = {
                method: 'GET',
                url: apiUrl.toString(),
                headers: {
                    'User-Agent': XTREAM_CLIENT_USER_AGENT,
                    Accept: 'application/json',
                },
                timeout: 30000, // 30 seconds timeout for Xtream API
                validateStatus: (status) => status < 500, // Don't throw on 4xx errors
                signal: controller.signal,
            };

            const response = await requestWithValidatedRedirects<unknown>(
                apiUrl.toString(),
                config,
                { allowPrivateNetworks: true },
                5,
                createProviderDiagnosticsObserver('xtream-api', params.action ?? 'authenticate', sessionId)
            );

            const username = params.username;
            const password = params.password;
            const isXtreamLogout = params.action?.toLowerCase() === 'logout';
            if (isXtreamLogout && payload.accountRef && response.status < 400) {
                playbackAccountProfiles.clear(payload.accountRef);
            } else if (
                typeof username === 'string' &&
                typeof password === 'string' &&
                payload.accountRef &&
                response.status < 400
            ) {
                playbackAccountProfiles.replacePortalCredentials(
                    payload.accountRef,
                    { username, password }
                );
                if (!params.action) {
                    const rawSetCookie = response.headers['set-cookie'];
                    const setCookieHeaders = Array.isArray(rawSetCookie)
                        ? rawSetCookie
                        : typeof rawSetCookie === 'string'
                            ? [rawSetCookie]
                            : undefined;
                    const responseUrl = response.request?.res?.responseUrl ?? apiUrl.toString();
                    playbackAccountProfiles.captureLoginCookies(
                        payload.accountRef,
                        responseUrl,
                        setCookieHeaders
                    );
                }
            }

            // Check if response is successful
            if (response.status >= 400) {
                throw {
                    status: response.status,
                };
            }

            if (requestId) {
                const debugEvent: PortalDebugEvent = {
                    requestId,
                    provider: 'xtream',
                    operation: params.action ?? 'unknown',
                    transport: 'electron-main',
                    startedAt: new Date(startedAt).toISOString(),
                    durationMs: Date.now() - startedAt,
                    status: 'success',
                    request: {
                        method: config.method ?? 'GET',
                        url: apiUrl.toString(),
                        headers: config.headers,
                        timeout: config.timeout,
                        params,
                    },
                    response: response.data,
                };
                emitPortalDebugEvent(debugEvent);
            }

            // Xtream API returns JSON data
            return {
                payload: response.data,
                action: params.action,
            };
        } catch (error) {
            const requestId = payload.requestId;
            if (requestId) {
                const apiUrl = (() => {
                    try {
                        return buildXtreamApiUrl(
                            payload.url,
                            payload.params ?? {}
                        ).toString();
                    } catch {
                        return requestUrlForLog;
                    }
                })();

                const debugEvent: PortalDebugEvent = {
                    requestId,
                    provider: 'xtream',
                    operation: payload.params?.action ?? 'unknown',
                    transport: 'electron-main',
                    startedAt: new Date(startedAt).toISOString(),
                    durationMs: Date.now() - startedAt,
                    status: 'error',
                    request: {
                        method: 'GET',
                        url: apiUrl,
                        headers: {
                            'User-Agent': XTREAM_CLIENT_USER_AGENT,
                            Accept: 'application/json',
                        },
                        timeout: 30000,
                        params: payload.params,
                    },
                    error,
                };
                emitPortalDebugEvent(debugEvent);
            }

            if (!payload.suppressErrorLog) {
                console.error(
                    '[XTREAM_REQUEST] Failed',
                    redactSensitiveData(
                        formatXtreamError(
                            error,
                            requestUrlForLog,
                            payload.params?.action
                        )
                    )
                );
            }

            // Electron only serializes a thrown error's message across invoke().
            // Return a structured failure so the renderer keeps its HTTP status.
            return { error: toXtreamRequestError(error) };
        } finally {
            if (activeRequestKey) {
                activeXtreamRequests.delete(activeRequestKey);
            }
        }
    }
);

ipcMain.handle(
    XTREAM_CANCEL_SESSION,
    async (
        _event,
        sessionId: string
    ): Promise<{ success: boolean; cancelled: number }> => {
        if (!sessionId) {
            return { success: false, cancelled: 0 };
        }

        let cancelled = 0;
        for (const activeRequest of activeXtreamRequests.values()) {
            if (activeRequest.sessionId !== sessionId) {
                continue;
            }

            activeRequest.controller.abort();
            cancelled += 1;
        }

        return {
            success: cancelled > 0,
            cancelled,
        };
    }
);
type ActiveXtreamRequest = {
    controller: AbortController;
    sessionId?: string;
};

const activeXtreamRequests = new Map<string, ActiveXtreamRequest>();

ipcMain.handle(
    'XTREAM_PROBE_URL',
    async (
        _event,
        payload: {
            url: string;
            method?: 'GET' | 'HEAD';
        }
    ) => {
        const method = payload.method ?? 'HEAD';
        const config: AxiosRequestConfig = {
            method,
            url: payload.url,
            headers: {
                'User-Agent': XTREAM_CLIENT_USER_AGENT,
                ...(method === 'GET' ? { Range: 'bytes=0-4095' } : {}),
            },
            timeout: 10000,
            responseType: method === 'GET' ? 'stream' : undefined,
            validateStatus: () => true,
        };

        try {
            const response = await requestWithValidatedRedirects(
                payload.url,
                config,
                {
                    allowPrivateNetworkRedirects: false,
                    allowPrivateNetworks: true,
                    pinAllowedPrivateNetworkHosts: true,
                }
            );
            const responseBody = response.data as
                | { destroy?: () => void }
                | undefined;
            responseBody?.destroy?.();
            return {
                status: response.status,
                url: response.config?.url ?? payload.url,
            };
        } catch (error) {
            if (axios.isAxiosError(error) && error.response) {
                return {
                    status: error.response.status,
                    url: payload.url,
                };
            }

            if (error instanceof UnsafeUrlError) {
                return {
                    status: 0,
                    url: payload.url,
                    error: error.message,
                };
            }

            return {
                status: 0,
                url: payload.url,
            };
        }
    }
);
