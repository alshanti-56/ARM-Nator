import type {
  ElectronBridgeApi,
  PlaybackNetworkInspection,
} from "@arm-nator/shared/interfaces";

export type ArtPlayer2VodSourceMode = "direct" | "proxy";

export interface ArtPlayer2VodSource {
  url: string;
  mode: ArtPlayer2VodSourceMode;
}

function getElectronBridge(): ElectronBridgeApi | undefined {
  return (window as Window & { electron?: ElectronBridgeApi }).electron;
}

function hasValidByteRangeResponse(
  inspection: PlaybackNetworkInspection,
): boolean {
  if (inspection.status !== 206) {
    return false;
  }

  const contentRange = inspection.headers["content-range"] ?? "";
  const acceptRanges = inspection.headers["accept-ranges"] ?? "";
  const contentType = inspection.contentType ?? "";

  return (
    /^bytes\s+0-\d+\/\d+$/i.test(contentRange) &&
    /(?:^|,\s*)bytes(?:,|$)/i.test(acceptRanges) &&
    (/^video\//i.test(contentType) || /mp4|octet-stream/i.test(contentType))
  );
}

/**
 * Keeps the stock ArtPlayer2 player independent from the application's
 * legacy ArtPlayer sessions while supplying a browser-compatible VOD URL.
 *
 * Native MPV/KS playback is unaffected. This transport is only used for
 * finite HTTP media rendered by ArtPlayer2.
 */
export class ArtPlayer2VodTransport {
  private generation = 0;
  private proxySessionId: string | null = null;

  async prepare(
    sourceUrl: string,
    headers: Record<string, string>,
    isCurrent: () => boolean,
  ): Promise<ArtPlayer2VodSource> {
    this.release();
    const generation = ++this.generation;
    const bridge = getElectronBridge();

    if (!bridge?.inspectPlaybackUrl) {
      return { mode: "direct", url: sourceUrl };
    }

    try {
      const inspection = await bridge.inspectPlaybackUrl(sourceUrl, headers);
      if (
        generation === this.generation &&
        isCurrent() &&
        hasValidByteRangeResponse(inspection)
      ) {
        return { mode: "direct", url: sourceUrl };
      }
    } catch {
      // The local gateway is the compatibility path when probing fails.
    }

    return this.createProxy(sourceUrl, headers, generation, isCurrent);
  }

  async fallbackToProxy(
    sourceUrl: string,
    headers: Record<string, string>,
    isCurrent: () => boolean,
  ): Promise<ArtPlayer2VodSource | null> {
    const generation = ++this.generation;
    return this.createProxy(sourceUrl, headers, generation, isCurrent);
  }

  release(): void {
    this.generation += 1;
    const sessionId = this.proxySessionId;
    this.proxySessionId = null;
    if (sessionId) {
      void getElectronBridge()
        ?.releaseProgressiveVodProxySession?.(sessionId)
        .catch(() => undefined);
    }
  }

  private async createProxy(
    sourceUrl: string,
    headers: Record<string, string>,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<ArtPlayer2VodSource> {
    const bridge = getElectronBridge();
    if (!bridge?.createProgressiveVodProxySession) {
      return { mode: "direct", url: sourceUrl };
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
        return { mode: "direct", url: sourceUrl };
      }
      this.proxySessionId = proxy.id;
      return { mode: "proxy", url: proxy.url };
    } catch {
      return { mode: "direct", url: sourceUrl };
    }
  }
}

export function isArtPlayer2VodRangeCompatible(
  inspection: PlaybackNetworkInspection,
): boolean {
  return hasValidByteRangeResponse(inspection);
}
