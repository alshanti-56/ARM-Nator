import type { ElectronBridgeApi } from '@arm-nator/shared/interfaces';

interface HlsSourceLoader {
    loadSource(url: string): void;
}

/** Owns the renderer-side lifetime of one opaque main-process HLS session. */
export class ArtPlayerHlsProxySession {
    private id: string | null = null;

    private get bridge(): ElectronBridgeApi | undefined {
        return (window as Window & { electron?: ElectronBridgeApi }).electron;
    }

    async load(
        hls: HlsSourceLoader,
        sourceUrl: string,
        headers: Record<string, string> | undefined,
        isCurrent: () => boolean
    ): Promise<boolean> {
        const bridge = this.bridge;
        if (!bridge?.createHlsProxySession) {
            hls.loadSource(sourceUrl);
            return true;
        }

        try {
            const proxy = await bridge.createHlsProxySession(sourceUrl, headers);
            if (!isCurrent()) {
                void bridge.releaseHlsProxySession(proxy.id).catch(
                    () => undefined
                );
                return false;
            }
            this.release();
            this.id = proxy.id;
            hls.loadSource(proxy.url);
            return true;
        } catch {
            // Do not retry a provider URL from Electron's renderer. That would
            // recreate the CORS/redirect failure the main-process proxy avoids.
            return false;
        }
    }

    release(): void {
        const id = this.id;
        this.id = null;
        if (id) {
            void this.bridge?.releaseHlsProxySession?.(id).catch(
                () => undefined
            );
        }
    }
}
