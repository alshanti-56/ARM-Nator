import { resolveM3uCatchupUrl } from '@arm-nator/providers/m3u/utils';
import { Channel, EpgProgram } from '@arm-nator/shared/interfaces';
import { EpgActions } from './actions';

/**
 * Map a catch-up request to its follow-up action. The user explicitly asked
 * for archive playback, so an unresolvable URL must surface through
 * `onUnavailable` (snackbar) instead of silently resetting.
 */
export function resolveActiveEpgProgramAction(
    program: EpgProgram,
    activeChannel: Channel | undefined | null,
    onUnavailable: () => void
) {
    const playbackUrl = activeChannel
        ? resolveM3uCatchupUrl(activeChannel, program)
        : null;

    if (!playbackUrl) {
        onUnavailable();
        return EpgActions.resetActiveEpgProgram();
    }

    return EpgActions.setActivePlaybackUrl({ playbackUrl, program });
}
