/* eslint-disable max-lines */
import { inject, Injectable } from '@angular/core';
import { DataService } from '@arm-nator/services';
import { createLogger } from '@arm-nator/providers/shared/util';import { XtreamCategory, XtreamCodeActions, XtreamLiveStream, XtreamSerieDetails, XtreamSerieItem, XtreamVodDetails, XtreamVodStream, XTREAM_REQUEST, normalizeXtreamServerUrl } from '@arm-nator/shared/interfaces';

import { XtreamAccountInfo } from '../account-info/account-info.interface';

/**
 * Xtream API credentials
 */
export interface XtreamCredentials {
    allowedOutputFormats?: string[];
    serverUrl: string;
    username: string;
    password: string;
}

/**
 * Category type mapping for API calls
 */
export type CategoryType = 'live' | 'vod' | 'series';

/**
 * Stream type mapping for API calls
 */
export type StreamType = 'live' | 'movie' | 'series';

export interface XtreamRequestOptions {
    requestId?: string;
    sessionId?: string;
    suppressErrorLog?: boolean;
}

const XTREAM_ACCOUNT_ACTIONS = [
    XtreamCodeActions.GetAccountInfo,
    null,
    'get_profile',
] as const;

/**
 * Service for all Xtream Codes API interactions.
 * Extracts API communication logic from the XtreamStore.
 */
@Injectable({ providedIn: 'root' })
export class XtreamApiService {
    private readonly dataService = inject(DataService);
    private readonly logger = createLogger('XtreamApiService');

    async cancelSession(sessionId: string): Promise<boolean> {
        if (
            !sessionId ||
            typeof window.electron?.xtreamCancelSession !== 'function'
        ) {
            return false;
        }

        try {
            const result = await window.electron.xtreamCancelSession(sessionId);
            return result.success;
        } catch (error) {
            this.logger.error('Failed to cancel Xtream session:', error);
            return false;
        }
    }

    /**
     * Get account/portal status
     */
    async getAccountInfo(
        credentials: XtreamCredentials,
        options?: XtreamRequestOptions
    ): Promise<XtreamAccountInfo> {
        let lastError: unknown;
        let lastResponse: XtreamAccountInfo | null = null;

        for (const action of XTREAM_ACCOUNT_ACTIONS) {
            try {
                const response = await this.sendRequest<XtreamAccountInfo>(
                    credentials.serverUrl,
                    {
                        ...(action ? { action } : {}),
                        username: credentials.username,
                        password: credentials.password,
                    },
                    options
                );

                if (this.hasAccountInfoPayload(response)) {
                    return response;
                }

                lastResponse = response;
            } catch (error) {
                lastError = error;
            }
        }

        if (lastResponse) {
            return lastResponse;
        }

        throw lastError instanceof Error
            ? lastError
            : new Error('Failed to fetch Xtream account info');
    }

    /**
     * Get categories by type
     */
    async getCategories(
        credentials: XtreamCredentials,
        type: CategoryType,
        options?: XtreamRequestOptions
    ): Promise<XtreamCategory[]> {
        const actionMap: Record<CategoryType, XtreamCodeActions> = {
            live: XtreamCodeActions.GetLiveCategories,
            vod: XtreamCodeActions.GetVodCategories,
            series: XtreamCodeActions.GetSeriesCategories,
        };

        const response = await this.sendRequest(
            credentials.serverUrl,
            {
                action: actionMap[type],
                username: credentials.username,
                password: credentials.password,
            },
            options
        );

        return Array.isArray(response) ? response : [];
    }

    /**
     * Get live streams
     */
    async getLiveStreams(
        credentials: XtreamCredentials,
        options?: XtreamRequestOptions
    ): Promise<XtreamLiveStream[]> {
        const response = await this.sendRequest(
            credentials.serverUrl,
            {
                action: XtreamCodeActions.GetLiveStreams,
                username: credentials.username,
                password: credentials.password,
            },
            options
        );

        return Array.isArray(response) ? response : [];
    }

    /**
     * Get VOD streams
     */
    async getVodStreams(
        credentials: XtreamCredentials,
        options?: XtreamRequestOptions
    ): Promise<XtreamVodStream[]> {
        const response = await this.sendRequest(
            credentials.serverUrl,
            {
                action: XtreamCodeActions.GetVodStreams,
                username: credentials.username,
                password: credentials.password,
            },
            options
        );

        return Array.isArray(response) ? response : [];
    }

    /**
     * Get series items
     */
    async getSeriesStreams(
        credentials: XtreamCredentials,
        options?: XtreamRequestOptions
    ): Promise<XtreamSerieItem[]> {
        const response = await this.sendRequest(
            credentials.serverUrl,
            {
                action: XtreamCodeActions.GetSeries,
                username: credentials.username,
                password: credentials.password,
            },
            options
        );

        return Array.isArray(response) ? response : [];
    }

    /**
     * Get streams by type (unified method)
     */
    async getStreams(
        credentials: XtreamCredentials,
        type: StreamType,
        options?: XtreamRequestOptions
    ): Promise<XtreamLiveStream[] | XtreamVodStream[] | XtreamSerieItem[]> {
        switch (type) {
            case 'live':
                return this.getLiveStreams(credentials, options);
            case 'movie':
                return this.getVodStreams(credentials, options);
            case 'series':
                return this.getSeriesStreams(credentials, options);
        }
    }

    /**
     * Get VOD details
     */
    async getVodInfo(
        credentials: XtreamCredentials,
        vodId: string | number,
        options?: XtreamRequestOptions
    ): Promise<XtreamVodDetails> {
        return this.sendRequest(
            credentials.serverUrl,
            {
                action: XtreamCodeActions.GetVodInfo,
                username: credentials.username,
                password: credentials.password,
                vod_id: vodId,
            },
            options
        );
    }

    /**
     * Get series details
     */
    async getSeriesInfo(
        credentials: XtreamCredentials,
        seriesId: string | number,
        options?: XtreamRequestOptions
    ): Promise<XtreamSerieDetails> {
        return this.sendRequest(
            credentials.serverUrl,
            {
                action: XtreamCodeActions.GetSeriesInfo,
                username: credentials.username,
                password: credentials.password,
                series_id: seriesId,
            },
            options
        );
    }


    private parseUnixTimestamp(value: unknown): number | null {
        const parsed = Number.parseInt(String(value ?? ''), 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }

    private toIsoString(timestamp: number | null): string | null {
        return timestamp ? new Date(timestamp * 1000).toISOString() : null;
    }

    private normalizeDateString(value: unknown): string {
        const rawValue = String(value ?? '').trim();
        if (!rawValue) {
            return '';
        }

        const parsed = Date.parse(rawValue.replace(' ', 'T'));
        return Number.isFinite(parsed)
            ? new Date(parsed).toISOString()
            : rawValue;
    }

    /**
     * Send request via IPC to avoid CORS issues
     */
    private async sendRequest<TResponse>(
        url: string,
        params: Record<string, string | number>,
        options?: XtreamRequestOptions
    ): Promise<TResponse> {
        const normalizedUrl = normalizeXtreamServerUrl(url);
        const serializedParams: Record<string, string> = {};
        Object.entries(params).forEach(([key, value]) => {
            const serializedValue = String(value);
            serializedParams[key] =
                key === 'username' || key === 'password'
                    ? serializedValue.trim()
                    : serializedValue;
        });

        const response = (await this.dataService.sendIpcEvent(XTREAM_REQUEST, {
            url: normalizedUrl,
            params: serializedParams,
            requestId: options?.requestId,
            sessionId: options?.sessionId,
            suppressErrorLog: options?.suppressErrorLog,
        })) as {
            message?: string;
            payload?: unknown;
            type?: string;
        };

        // The IPC layer catches errors and returns { type: 'ERROR', message, status }
        // instead of rejecting. Convert that back into a thrown error so callers
        // can handle it with .catch() / try-catch.
        if (
            response?.type === 'ERROR' ||
            (!response?.payload && response?.message)
        ) {
            throw new Error(response?.message ?? 'Request failed');
        }

        return response?.payload as TResponse;
    }

    private hasAccountInfoPayload(
        response: XtreamAccountInfo | null | undefined
    ): boolean {
        return Boolean(response?.user_info);
    }
}
