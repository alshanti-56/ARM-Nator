import type { PlayerOpenContext } from '@arm-nator/player/core';
import { registerPlaybackContext } from '@arm-nator/player/core';
import type { ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';

export type StalkerPlaybackResolver = NonNullable<
    PlayerOpenContext['resolvePlayback']
>;

/**
 * Adds the data-only recovery callback for a Stalker URL that was minted by
 * `create_link`. Static URLs keep account/header metadata for credential
 * actions but intentionally have no callback: returning the unchanged
 * catalog URL would not renew anything.
 */
export function createStalkerPlaybackRecoveryContext(
    original: ResolvedPortalPlayback,
    resolver: StalkerPlaybackResolver
): Pick<PlayerOpenContext, 'resolvePlayback'> {
    if (!original.recovery?.providerLinkRenewable) return {};

    const context: Pick<PlayerOpenContext, 'resolvePlayback'> = {
        resolvePlayback: async (request) => {
            throwIfAborted(request.signal);
            const refreshed = await resolver(request);
            throwIfAborted(request.signal);
            return {
                ...refreshed,
                itemIdentity: original.itemIdentity ?? refreshed.itemIdentity,
                seriesIdentity: original.seriesIdentity ?? refreshed.seriesIdentity,
                work: original.work ?? refreshed.work,
                contentInfo: original.contentInfo ?? refreshed.contentInfo,
            };
        },
    };
    registerPlaybackContext(original, context);
    return context;
}

function throwIfAborted(signal: AbortSignal): void {
    if (!signal.aborted) return;
    const error = new Error('Stalker playback resolution was aborted');
    error.name = 'AbortError';
    throw error;
}
