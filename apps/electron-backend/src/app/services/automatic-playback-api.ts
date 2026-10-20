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
                return {
                    ok: false,
                    error: {
                        code: error instanceof MediaInspectionError ? error.code : 'unknown-error',
                        status: error instanceof MediaInspectionError ? error.status : null,
                        message: error instanceof Error ? error.message : String(error),
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
