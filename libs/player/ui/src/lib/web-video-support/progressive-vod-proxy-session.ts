import type { ElectronBridgeApi } from '@arm-nator/shared/interfaces';

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
    private id: string | null = null;
    private generation = 0;

    private get bridge(): ElectronBridgeApi | undefined {
        return (window as Window & { electron?: ElectronBridgeApi }).electron;
    }

    async load(
        target: ProgressiveVodSourceTarget,
        sourceUrl: string,
        headers: Record<string, string> | undefined,
        isCurrent: () => boolean,
    ): Promise<boolean> {
        this.release();
        const generation = ++this.generation;
        const bridge = this.bridge;

        if (!bridge?.createProgressiveVodProxySession) {
            if (isCurrent()) {
                target.setSource(sourceUrl);
                return true;
            }
            return false;
        }

        try {
            const proxy = await bridge.createProgressiveVodProxySession(
                sourceUrl,
                headers,
            );
            if (generation !== this.generation || !isCurrent()) {
                void bridge.releaseProgressiveVodProxySession(proxy.id).catch(
                    () => undefined,
                );
                return false;
            }
            this.id = proxy.id;
            target.setSource(proxy.url);
            return true;
        } catch {
            // Keep the established direct-URL fallback for environments where
            // the Electron proxy is unavailable. The native media element can
            // still play providers that expose correct CORS/range responses.
            if (generation !== this.generation || !isCurrent()) {
                return false;
            }
            target.setSource(sourceUrl);
            return true;
        }
    }

    release(): void {
        this.generation += 1;
        const id = this.id;
        this.id = null;
        if (id) {
            void this.bridge?.releaseProgressiveVodProxySession?.(id).catch(
                () => undefined,
            );
        }
    }
}
