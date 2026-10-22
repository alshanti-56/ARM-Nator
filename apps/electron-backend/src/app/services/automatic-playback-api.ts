import type { AutoPlaybackPreparationResult } from '@arm-nator/shared/interfaces';
import type { PlaybackRequestPolicy } from '@arm-nator/shared/interfaces';
import type { HlsPlaybackProxyService } from './hls-playback-proxy.service';
import type { PlaybackDiagnosticsStore } from './playback-diagnostics.service';
import { MediaInspectionError } from './media-response-inspection';

export interface AutomaticPlaybackDecision {
    sourceUrl: string;
    sessionId?: string;
    engine: string;
    reason: string;
}

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);

function findDnsErrorCode(error: unknown): string | undefined {
    const seen = new Set<object>();
    let current = error;
    while (typeof current === 'object' && current !== null && !seen.has(current)) {
        seen.add(current);
        const candidate = current as { code?: unknown; cause?: unknown };
        if (typeof candidate.code === 'string' && DNS_ERROR_CODES.has(candidate.code)) {
            return candidate.code;
        }
        current = candidate.cause;
    }
    return undefined;
}

function dnsFailureMessage(code: string): string {
    return code === 'EAI_AGAIN'
        ? 'DNS lookup for the stream host temporarily failed (EAI_AGAIN). Check your network and retry.'
        : `DNS lookup could not find the stream host (${code}). Check the provider stream address and your network, then retry.`;
}

/** Keep custom failure fields intact across Electron's structured IPC boundary. */
export function createAutomaticPlaybackApi(
    proxy: HlsPlaybackProxyService,
    diagnostics?: PlaybackDiagnosticsStore,
) {
    return {
        async prepare(
            url: string,
            headers: Record<string, string> | undefined,
            isLive: boolean,
            attemptId: string,
            requestPolicy?: PlaybackRequestPolicy,
            ownerId?: number,
        ): Promise<AutoPlaybackPreparationResult> {
            try {
                const session = await proxy.createAutoSession(
                    url,
                    headers,
                    isLive,
                    attemptId,
                    requestPolicy,
                    ownerId,
                );
                return { ok: true, session };
            } catch (error) {
                const networkCode = findDnsErrorCode(error);
                return {
                    ok: false,
                    error: {
                        code: error instanceof MediaInspectionError ? error.code : networkCode ? 'network-error' : 'unknown-error',
                        status: error instanceof MediaInspectionError ? error.status : null,
                        message: networkCode
                            ? dnsFailureMessage(networkCode)
                            : error instanceof Error ? error.message : String(error),
                        ...(networkCode === undefined ? {} : { networkCode }),
                        ...(error instanceof MediaInspectionError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
                    },
                };
            }
        },
        cancel: (attemptId: string, ownerId?: number) => proxy.cancelAutoSession(attemptId, ownerId),
        release: (sessionId: string, ownerId?: number) => proxy.releaseSessionAndWait(sessionId, ownerId),
        recordDecision(decision: AutomaticPlaybackDecision): void {
            if (!decision || typeof decision.sourceUrl !== 'string' || typeof decision.engine !== 'string' || typeof decision.reason !== 'string') return;
            diagnostics?.record({
                event: 'automatic-playback-decision',
                sourceUrl: decision.sourceUrl,
                sessionId: typeof decision.sessionId === 'string' ? decision.sessionId : undefined,
                phase: 'automatic-selection',
                details: `engine=${decision.engine}; reason=${decision.reason}`,
            });
        },
    };
}
