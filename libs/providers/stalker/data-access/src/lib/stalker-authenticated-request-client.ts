import type { StalkerSearchContext } from '@arm-nator/shared/interfaces';
import { abortableStalkerRequest, throwIfStalkerRequestAborted } from './abortable-stalker-request';
import {
    extractStalkerAuthFailureBody,
    isFullStalkerPortalPlaylist,
    type Playlist,
} from '@arm-nator/shared/interfaces';
import type { DataService } from '@arm-nator/services';
import { StalkerPortalError } from './stalker-portal-error';
import { isStalkerAuthorizationFailure } from './stalker-response-classification';
import { stalkerSessionFingerprint } from './stalker-session-store';
import type { StalkerTokenCache } from './stalker-token-cache';

/** Authenticated request + one-shot session renewal shared by all callers. */
export class StalkerAuthenticatedRequestClient {
    constructor(
        private readonly dataService: DataService,
        private readonly tokens: StalkerTokenCache,
        private readonly ensureToken: (
            playlist: Playlist,
            signal?: AbortSignal
        ) => Promise<{ token: string | null; serialNumber?: string }>,
        private readonly assertCurrent: (
            playlist: Playlist,
            sessionFingerprint: string
        ) => void
    ) {}

    async request<T>(
        playlist: Playlist,
        params: Record<string, string | number>,
        retryOnAuthFailure = true,
        options?: { signal?: AbortSignal; timeoutMs?: number; discovery?: StalkerSearchContext }
    ): Promise<T> {
        // Bind the whole request to one immutable connection snapshot. An
        // Edit can replace the authoritative endpoint/mode while transport is
        // in flight; its old response must never reach a store or player.
        throwIfStalkerRequestAborted(options?.signal);
        const configuration = { ...playlist } as Playlist;
        const sessionFingerprint =
            stalkerSessionFingerprint(configuration);
        const { token, serialNumber } =
            await (options?.signal ? this.ensureToken(configuration, options.signal) : this.ensureToken(configuration));
        throwIfStalkerRequestAborted(options?.signal);

        try {
            if (!configuration.portalUrl || !configuration.macAddress) throw new Error('Portal URL and MAC address are required');
            const response = await abortableStalkerRequest<T>(
                this.dataService, {
                    url: configuration.portalUrl,
                    macAddress: configuration.macAddress,
                    params,
                    token: token ?? undefined,
                    accountRef: configuration._id,
                    timeoutMs: options?.timeoutMs,
                    ...(serialNumber ? { serialNumber } : {}),
                }, options?.signal, options?.discovery
            );
            this.assertCurrent(configuration, sessionFingerprint);
            if (isStalkerAuthorizationFailure(response)) {
                return this.handleAuthorizationFailure<T>(
                    configuration,
                    params,
                    token,
                    response,
                    retryOnAuthFailure, options
                );
            }
            return response;
        } catch (error) {
            // A classified response above is already wrapped with its
            // redacted portal body. Re-classifying that app-owned error would
            // discard the body and replace it with an empty failure.
            if (error instanceof StalkerPortalError) {
                throw error;
            }
            if (isStalkerAuthorizationFailure(error)) {
                this.tokens.retireFailed(configuration._id, token);
                if (
                    retryOnAuthFailure &&
                    isFullStalkerPortalPlaylist(configuration)
                ) {
                    return this.request<T>(configuration, params, false, options);
                }
            }
            // Transport evidence (especially HTTP 401/403) is consumed by
            // lazy repair. Preserve it exactly after retry exhaustion.
            throw error;
        }
    }

    private handleAuthorizationFailure<T>(
        playlist: Playlist,
        params: Record<string, string | number>,
        failedToken: string | null,
        failure: unknown,
        retryOnAuthFailure: boolean,
        options?: { signal?: AbortSignal; timeoutMs?: number; discovery?: StalkerSearchContext }
    ): Promise<T> {
        this.tokens.retireFailed(playlist._id, failedToken);
        if (retryOnAuthFailure && isFullStalkerPortalPlaylist(playlist)) {
            return this.request<T>(playlist, params, false, options);
        }

        const failureBody = extractStalkerAuthFailureBody(failure) ?? undefined;
        throw new StalkerPortalError('auth-failed', failureBody, failureBody);
    }
}
