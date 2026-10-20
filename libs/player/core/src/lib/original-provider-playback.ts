import type { ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';

/** Return the replayable provider request, never a released local proxy URL. */
export function originalProviderPlayback(playback: ResolvedPortalPlayback, positionSeconds?: number): ResolvedPortalPlayback {
    const original = { ...playback };
    if (original.preparedProxy) delete original.preferredProcessingMode;
    delete original.preparedProxy;
    delete original.originalStreamUrl;
    return {
        ...original,
        streamUrl: playback.originalStreamUrl ?? playback.streamUrl,
        ...(playback.isLive !== true && typeof positionSeconds === 'number' && Number.isFinite(positionSeconds)
            ? { startTime: Math.max(0, positionSeconds) } : {}),
    };
}
