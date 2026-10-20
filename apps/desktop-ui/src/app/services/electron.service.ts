import type { StalkerSearchRequestPayload } from '@arm-nator/shared/interfaces';
import type { StalkerRequestPayload } from '@arm-nator/shared/interfaces';
/* eslint-disable max-lines */
import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DataService } from '@arm-nator/services';
import {
    ERROR,
    normalizeHost,
    PlayerContentInfo,
    STALKER_REQUEST,
    XTREAM_REQUEST,
    XTREAM_RESPONSE,
    XtreamCodeActions,
} from '@arm-nator/shared/interfaces';
import { AppConfig } from '../../environments/environment';
import {
    createLogger,
    createPortalDebugRequestContext,
    logPortalDebugEvent,
} from '@arm-nator/providers/shared/util';

interface PlayerLaunchPayload {
    readonly headers?: Record<string, string>;
    readonly origin?: string;
    readonly referer?: string;
    readonly startTime?: number;
    readonly thumbnail?: string;
    readonly title?: string;
    readonly url: string;
    readonly ['user-agent']?: string;
    readonly contentInfo?: PlayerContentInfo;
    readonly subtitleUrl?: string;
}

interface ErrorStatus {
    readonly message?: string;
    readonly status?: number;
}

@Injectable({
    providedIn: 'root',
})
export class ElectronService extends DataService {
    private eventListeners: { [key: string]: () => void } = {};
    private messageListeners = new Map<string, EventListener>();
    private readonly snackBar = inject(MatSnackBar);
    private readonly logger = createLogger('ElectronService');
    private readonly silentXtreamActions = new Set<string>([
        XtreamCodeActions.GetAccountInfo,
        XtreamCodeActions.GetLiveCategories,
        XtreamCodeActions.GetVodCategories,
        XtreamCodeActions.GetSeriesCategories,
    ]);

    constructor() {
        super();
        this.setupPlayerErrorListener();
        this.setupPortalDebugListener();
    }

    private setupPlayerErrorListener() {
        // Listen for player errors from the backend
        if (window.electron?.onPlayerError) {
            window.electron.onPlayerError(
                (data: {
                    player: string;
                    error: string;
                    originalError: string;
                }) => {
                    this.logger.error(
                        `${data.player} Error:`,
                        data.originalError
                    );
                    this.snackBar.open(
                        `${data.player} Error: ${data.error}`,
                        'Close',
                        {
                            duration: 7000,
                            panelClass: ['error-snackbar'],
                        }
                    );
                }
            );
        }
    }

    private setupPortalDebugListener() {
        const onPortalDebugEvent = window.electron?.onPortalDebugEvent;

        if (AppConfig.production || !onPortalDebugEvent) {
            return;
        }

        onPortalDebugEvent((event) => {
            logPortalDebugEvent(
                event as Parameters<typeof logPortalDebugEvent>[0]
            );
        });
    }

    getAppVersion(): string {
        return AppConfig.version;
    }

    async sendIpcEvent<T = unknown>(
        type: string,
        payload?: unknown
    ): Promise<T> {
        if (type === XTREAM_REQUEST) {
            return (await this.forwardXtreamRequest(
                payload as {
                    url: string;
                    params: Record<string, string>;
                    accountRef?: string;
                }
            )) as T;
        }

        if (type === STALKER_REQUEST) {
            return (await window.electron.stalkerRequest(
                payload as StalkerRequestPayload
            )) as T;
        }

        if (type === 'STALKER_SEARCH_PAGE') return await window.electron.stalkerSearchPage(payload as StalkerSearchRequestPayload) as T;
        if (type === 'STALKER_CANCEL_REQUEST') return await window.electron.stalkerCancelRequest(String(payload)) as T;

        if (type === 'OPEN_MPV_PLAYER') {
            const data = payload as PlayerLaunchPayload;
            try {
                return (await window.electron.openInMpv(
                    data.url,
                    data.title ?? '',
                    data.thumbnail ?? '',
                    data['user-agent'],
                    data.referer ?? undefined,
                    data.origin ?? undefined,
                    data.contentInfo,
                    data.startTime,
                    data.headers ?? undefined,
                    data.subtitleUrl
                )) as T;
            } catch (error: unknown) {
                const errorMessage =
                    this.getErrorDetails(error)?.message ?? String(error);
                this.snackBar.open(
                    `Error launching MPV: ${errorMessage}`,
                    'Close',
                    {
                        duration: 5000,
                    }
                );
                this.logger.error('MPV launch error:', error);
                throw error;
            }
        }

        if (type === 'OPEN_VLC_PLAYER') {
            const data = payload as PlayerLaunchPayload;
            try {
                return (await window.electron.openInVlc(
                    data.url,
                    data.title ?? '',
                    data.thumbnail ?? '',
                    data['user-agent'],
                    data.referer ?? undefined,
                    data.origin ?? undefined,
                    data.contentInfo,
                    data.startTime,
                    data.headers ?? undefined,
                    data.subtitleUrl
                )) as T;
            } catch (error: unknown) {
                const errorMessage =
                    this.getErrorDetails(error)?.message ?? String(error);
                this.snackBar.open(
                    `Error launching VLC: ${errorMessage}`,
                    'Close',
                    {
                        duration: 5000,
                    }
                );
                this.logger.error('VLC launch error:', error);
                throw error;
            }
        }

        this.logger.debug('Unknown IPC event type:', type);
        return undefined as T;
    }

    /* private getErrorMessageByStatusCode(status: number) {
        let message = 'Something went wrong';
        switch (status) {
            case 0:
                message = 'The backend is not reachable';
                break;
            case 413:
                message =
                    'This file is too big. Use standalone or self-hosted version of the app.';
                break;
            default:
                break;
        }
        return message;
    } */

    private async forwardXtreamRequest(payload: {
        url: string;
        params: Record<string, string>;
        requestId?: string;
        sessionId?: string;
        suppressErrorLog?: boolean;
        accountRef?: string;
    }) {
        const context = createPortalDebugRequestContext({
            provider: 'xtream',
            operation: payload.params?.action ?? 'unknown',
            transport: 'electron-renderer',
            request: payload,
        });

        try {
            // Use Electron IPC to make the Xtream request
            const response = await window.electron.xtreamRequest({
                ...payload,
                requestId: context.requestId,
            });

            if ('error' in response) {
                throw response.error;
            }

            const result = {
                type: XTREAM_RESPONSE,
                payload: response.payload,
                action: response.action,
            };
            window.postMessage(result);
            return result;
        } catch (error: unknown) {
            const action = payload.params?.action;
            const isSilentAction =
                payload.suppressErrorLog === true ||
                (action ? this.silentXtreamActions.has(action) : false);
            const normalizedMessage = this.getReadableXtreamErrorMessage(error);
            const errorInfo = this.getErrorDetails(error);
            const isCancelled = errorInfo?.status === 499;

            // Log error to console
            if (isSilentAction || isCancelled) {
                this.logger.debug(
                    `Background Xtream action failed (${action ?? 'unknown'}):`,
                    normalizedMessage
                );
            } else {
                this.logger.error('Xtream request error:', normalizedMessage);
            }

            // Only show snackbar for user-triggered Xtream requests
            if (!isSilentAction && !isCancelled) {
                const requestContext = this.getXtreamRequestContext(payload);
                const statusSuffix = errorInfo?.status
                    ? ` (HTTP ${errorInfo.status})`
                    : '';
                this.snackBar.open(
                    `Xtream request failed · ${requestContext}${statusSuffix}: ${normalizedMessage}`,
                    'Close',
                    {
                        duration: 5000,
                    }
                );
            }

            return {
                type: ERROR,
                status: errorInfo?.status ?? 500,
                message: normalizedMessage,
            };
        }
    }

    private getXtreamRequestContext(payload: {
        url: string;
        params: Record<string, string>;
    }): string {
        const host = this.getXtreamRequestHost(payload.url);
        const action = payload.params?.action;
        const actionLabels: Record<string, string> = {
            [XtreamCodeActions.GetAccountInfo]: 'account status',
            [XtreamCodeActions.GetLiveStreams]: 'live catalog',
            [XtreamCodeActions.GetLiveCategories]: 'live categories',
            [XtreamCodeActions.GetSeries]: 'series catalog',
            [XtreamCodeActions.GetSeriesCategories]: 'series categories',
            [XtreamCodeActions.GetSeriesInfo]: 'series metadata',
            [XtreamCodeActions.GetVodStreams]: 'movie catalog',
            [XtreamCodeActions.GetVodCategories]: 'movie categories',
            [XtreamCodeActions.GetVodInfo]: 'movie metadata',
        };
        const requestLabel = action
            ? `${actionLabels[action] ?? action}`
            : 'account/status fallback';
        const itemId = payload.params?.vod_id ?? payload.params?.series_id;

        return `${host} · ${requestLabel}${itemId ? ` #${itemId}` : ''}`;
    }

    private getXtreamRequestHost(url: string): string {
        try {
            const parsed = new URL(url.includes('://') ? url : `http://${url}`);
            return normalizeHost(parsed.host);
        } catch {
            return normalizeHost(url).replace(/^https?:\/\//, '') || 'unknown server';
        }
    }

    private getReadableXtreamErrorMessage(error: unknown): string {
        const fallback = 'Failed to connect to Xtream server';
        if (!error) {
            return fallback;
        }

        const maybeError = error as {
            message?: unknown;
            statusText?: unknown;
            status?: unknown;
            error?: unknown;
        };

        if (typeof maybeError.message === 'string') {
            if (maybeError.message.includes('[object Object]')) {
                if (typeof maybeError.error === 'string') {
                    return maybeError.error;
                }
                if (
                    maybeError.error &&
                    typeof maybeError.error === 'object' &&
                    'message' in
                        (maybeError.error as Record<string, unknown>) &&
                    typeof (maybeError.error as Record<string, unknown>)
                        .message === 'string'
                ) {
                    return (maybeError.error as Record<string, string>).message;
                }
                return fallback;
            }
            return maybeError.message;
        }

        if (typeof maybeError.statusText === 'string') {
            return maybeError.statusText;
        }

        if (typeof error === 'string') {
            return error;
        }

        return fallback;
    }

    private getErrorDetails(error: unknown): ErrorStatus | null {
        if (error && typeof error === 'object') {
            return error as ErrorStatus;
        }
        return null;
    }

    removeAllListeners(type: string): void {
        if (type === 'all') {
            // Unsubscribe from all event listeners
            Object.values(this.eventListeners).forEach((unsubscribe) =>
                unsubscribe()
            );
            this.eventListeners = {};
            // Remove all tracked window message listeners
            this.messageListeners.forEach((listener) =>
                window.removeEventListener('message', listener)
            );
            this.messageListeners.clear();
            return;
        }

        if (this.eventListeners[type]) {
            // Unsubscribe from a specific event
            this.eventListeners[type]();
            delete this.eventListeners[type];
        }

        // Remove the window message listener registered for this command
        const messageListener = this.messageListeners.get(type);
        if (messageListener) {
            window.removeEventListener('message', messageListener);
            this.messageListeners.delete(type);
        }
    }

    listenOn(command: string, callback: (...args: unknown[]) => void): void {
        // Drop any existing listener for this command so calling listenOn()
        // again rebinds rather than accumulating duplicates.
        const existing = this.messageListeners.get(command);
        if (existing) {
            window.removeEventListener('message', existing);
        }

        const listener = callback as EventListener;
        window.addEventListener('message', listener);
        this.messageListeners.set(command, listener);
    }

    getAppEnvironment(): string {
        return 'electron';
    }
}
