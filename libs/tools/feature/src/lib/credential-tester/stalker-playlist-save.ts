import { createRandomId, type Playlist } from '@arm-nator/shared/interfaces';
import type { StalkerTestResult } from '@arm-nator/tools/core';

export function createValidatedStalkerPlaylist(result: StalkerTestResult): Playlist {
    const now = new Date().toISOString();
    return {
        _id: createRandomId(), title: result.candidate.portalUrl, count: 0,
        importDate: now, lastUsage: now, autoRefresh: false,
        portalUrl: result.resolvedPortalUrl ?? result.candidate.portalUrl, macAddress: result.candidate.macAddress,
        isFullStalkerPortal: result.isFullStalkerPortal,
        stalkerToken: result.stalkerToken,
        stalkerWatchdogTimeout: result.watchdogTimeoutSeconds,
        stalkerTimeslot: result.timeslotSeconds,
        stalkerAccountInfo: result.accountInfo,
    };
}
