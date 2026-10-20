import type {
    AutoPlaybackPreparation,
    ElectronBridgeApi,
    PlaybackRequestPolicy,
} from '@arm-nator/shared/interfaces';

interface ProgressiveVodSourceTarget {
    setSource(url: string): void;
}

/**
 * Owns the renderer-side lifetime of one progressive-VOD proxy session.
 *
 * The proxy is deliberately used only for finite HTTP media. Live HLS has a
 * separate manifest/segment proxy and recovery policy, while a progressive
 * MP4 needs byte-range handling and a stable local origin.
 */
export class ProgressiveVodProxySession {
    private session: { id: string; bridge: ElectronBridgeApi } | null = null;
    private generation = 0;
    private readonly activeLoads = new Set<Promise<boolean>>();
    private readonly pendingReleases = new Map<string, ElectronBridgeApi>();
    private drainInFlight: Promise<void> | null = null;

    private get bridge(): ElectronBridgeApi | undefined {
        return (window as Window & { electron?: ElectronBridgeApi }).electron;
    }

    async load(
        target: ProgressiveVodSourceTarget,
        sourceUrl: string,
        headers: Record<string, string> | undefined,
        isCurrent: () => boolean,
        preparedProxy?: AutoPlaybackPreparation,
        requestPolicy?: PlaybackRequestPolicy,
        direct = false,
    ): Promise<boolean> {
        const generation = ++this.generation;
        if (this.drainInFlight) {
            await this.drainInFlight;
        } else if (this.session || this.pendingReleases.size > 0) {
            await this.drainOwnedResources();
        }
        if (generation !== this.generation || !isCurrent()) {
            return false;
        }

        if (direct) {
            target.setSource(sourceUrl);
            return true;
        }

        if (preparedProxy) {
            if (preparedProxy.format !== 'progressive' || !preparedProxy.url.trim()) {
                return false;
            }
            target.setSource(preparedProxy.url);
            return true;
        }

        const bridge = this.bridge;

        if (!bridge?.createProgressiveVodProxySession) {
            target.setSource(sourceUrl);
            return true;
        }

        const load = this.loadCurrent(
            bridge,
            target,
            sourceUrl,
            headers,
            isCurrent,
            generation,
            requestPolicy,
        );
        const tracked: Promise<boolean> = load.finally(() =>
            this.activeLoads.delete(tracked),
        );
        this.activeLoads.add(tracked);
        return tracked;
    }

    release(): void {
        void this.releaseAndWait().catch(() => undefined);
    }

    async releaseAndWait(): Promise<void> {
        this.generation += 1;
        await this.drainOwnedResources();
    }

    private async loadCurrent(
        bridge: ElectronBridgeApi,
        target: ProgressiveVodSourceTarget,
        sourceUrl: string,
        headers: Record<string, string> | undefined,
        isCurrent: () => boolean,
        generation: number,
        requestPolicy?: PlaybackRequestPolicy,
    ): Promise<boolean> {
        let proxy: { id: string; url: string };
        try {
            proxy = requestPolicy === undefined
                ? await bridge.createProgressiveVodProxySession!(sourceUrl, headers)
                : await bridge.createProgressiveVodProxySession!(
                    sourceUrl,
                    headers,
                    requestPolicy,
                );
        } catch {
            // Preserve the established direct-URL fallback when the proxy is
            // unavailable, provided this source is still current.
            if (generation !== this.generation || !isCurrent()) {
                return false;
            }
            target.setSource(sourceUrl);
            return true;
        }

        if (
            !proxy ||
            typeof proxy.id !== 'string' ||
            proxy.id.trim().length === 0 ||
            typeof proxy.url !== 'string' ||
            proxy.url.trim().length === 0
        ) {
            if (typeof proxy?.id === 'string' && proxy.id.trim()) {
                await this.releaseRemote(bridge, proxy.id);
            }
            throw new Error('The progressive VOD proxy returned an invalid session.');
        }
        if (generation !== this.generation || !isCurrent()) {
            await this.releaseRemote(bridge, proxy.id);
            return false;
        }

        this.session = { id: proxy.id, bridge };
        try {
            target.setSource(proxy.url);
            return true;
        } catch {
            this.session = null;
            await this.releaseRemote(bridge, proxy.id);
            return false;
        }
    }

    private async drainOwnedResources(): Promise<void> {
        if (!this.drainInFlight) {
            const drain = this.drain();
            const trackedDrain = drain.finally(() => {
                if (this.drainInFlight === trackedDrain) {
                    this.drainInFlight = null;
                }
            });
            this.drainInFlight = trackedDrain;
        }
        return this.drainInFlight;
    }

    private async drain(): Promise<void> {
        while (this.activeLoads.size > 0) {
            await Promise.allSettled([...this.activeLoads]);
        }

        const session = this.session;
        this.session = null;
        if (session) {
            this.pendingReleases.set(session.id, session.bridge);
        }

        const failures: unknown[] = [];
        for (const [id, bridge] of [...this.pendingReleases]) {
            try {
                await this.releaseRemote(bridge, id);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            const details = failures
                .map((error) =>
                    error instanceof Error ? error.message : String(error),
                )
                .join('; ');
            throw new AggregateError(
                failures,
                `Progressive VOD proxy release failed: ${details}`,
            );
        }
    }

    private async releaseRemote(
        bridge: ElectronBridgeApi,
        id: string,
    ): Promise<void> {
        this.pendingReleases.set(id, bridge);
        if (!bridge.releaseProgressiveVodProxySession) {
            throw new Error('Progressive VOD proxy release is unavailable.');
        }
        await bridge.releaseProgressiveVodProxySession(id);
        this.pendingReleases.delete(id);
    }
}
