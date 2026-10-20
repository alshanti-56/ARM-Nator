import type { AutoPlaybackPreparationResult, ElectronBridgeApi } from '@arm-nator/shared/interfaces';
import type { UserAgentProfile } from './user-agent-profiles';

export interface UserAgentTestResult {
    profile: UserAgentProfile;
    state: 'queued' | 'testing' | 'working' | 'failed' | 'cancelled';
    detail: string;
}

export interface UserAgentTestSample {
    url: string;
    headers: Record<string, string>;
}

export interface UserAgentTestDependencies {
    /** A fresh provider URL for each attempt; short-lived links are never reused. */
    resolveSample(profile: UserAgentProfile, sampleIndex: number, signal: AbortSignal): Promise<UserAgentTestSample>;
    probe(sample: UserAgentTestSample, signal: AbortSignal): Promise<{ working: boolean; detail: string }>;
    timeoutMs?: number;
    sampleCount?: number;
}

/** Sequential, bounded and cancellable: never opens competing player connections. */
export async function runUserAgentTests(
    profiles: readonly UserAgentProfile[],
    signal: AbortSignal,
    dependencies: UserAgentTestDependencies,
    publish: (result: UserAgentTestResult) => void,
): Promise<void> {
    for (const profile of profiles) {
        if (signal.aborted) {
            publish({ profile, state: 'cancelled', detail: 'Not tested' });
            continue;
        }
        publish({ profile, state: 'testing', detail: 'Checking sample live channels…' });
        let detail = 'No recognizable media';
        let working = false;
        for (let sampleIndex = 0; sampleIndex < Math.min(2, dependencies.sampleCount ?? 2) && !signal.aborted; sampleIndex++) {
            const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(dependencies.timeoutMs ?? 12_000)]);
            try {
                const sample = await dependencies.resolveSample(profile, sampleIndex, attemptSignal);
                attemptSignal.throwIfAborted();
                const result = await dependencies.probe(sample, attemptSignal);
                attemptSignal.throwIfAborted();
                detail = result.detail;
                if (result.working) { working = true; break; }
            } catch {
                detail = attemptSignal.aborted ? 'Timed out' : 'Could not resolve or read the sample stream';
            }
        }
        publish({ profile, state: signal.aborted ? 'cancelled' : working ? 'working' : 'failed', detail: signal.aborted ? 'Cancelled' : detail });
    }
}

/** Uses the same signature inspection as Auto and always releases retained bodies. */
export async function probeUserAgentMedia(
    bridge: Pick<ElectronBridgeApi, 'prepareAutoPlayback' | 'cancelAutoPlaybackPreparation' | 'releaseAutoPlaybackSession'>,
    sample: UserAgentTestSample,
    signal: AbortSignal,
): Promise<{ working: boolean; detail: string }> {
    signal.throwIfAborted();
    const attemptId = `user-agent-test-${crypto.randomUUID()}`;
    let aborted = false;
    let releasePromise: Promise<void> | undefined;
    const release = (result: AutoPlaybackPreparationResult): Promise<void> => {
        if (!result.ok) return Promise.resolve();
        return releasePromise ??= bridge.releaseAutoPlaybackSession(result.session.id);
    };
    let rejectAbort!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
        aborted = true;
        // The next profile must wait until the previous connection is closed.
        void bridge.cancelAutoPlaybackPreparation(attemptId).then(
            () => rejectAbort(signal.reason),
            () => rejectAbort(signal.reason),
        );
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const preparation = bridge.prepareAutoPlayback(sample.url, sample.headers, true, attemptId);
    // A late successful preparation still owns a response and must be released.
    void preparation.then(async (result) => {
        if (aborted) await release(result);
    }).catch(() => undefined);
    try {
        const result: AutoPlaybackPreparationResult = await Promise.race([preparation, cancelled]);
        if (!result.ok) {
            return { working: false, detail: result.error.status ? `HTTP ${result.error.status}` : result.error.code === 'startup-timeout' ? 'Timed out' : 'No recognizable media' };
        }
        await release(result);
        signal.throwIfAborted();
        return { working: true, detail: `${result.session.container ?? result.session.format} media detected` };
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
}
