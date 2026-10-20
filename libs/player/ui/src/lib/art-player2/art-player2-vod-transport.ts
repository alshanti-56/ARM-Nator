import type {
  AutoPlaybackPreparation,
  ElectronBridgeApi,
  PlaybackNetworkInspection,
} from "@arm-nator/shared/interfaces";

export type ArtPlayer2VodSourceMode = "direct" | "proxy" | "prepared";

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
  private proxySession: { id: string; bridge: ElectronBridgeApi } | null = null;
  private readonly pendingOperations = new Set<
    Promise<ArtPlayer2VodSource | null>
  >();
  private readonly pendingReleases = new Map<string, ElectronBridgeApi>();
  private drainInFlight: Promise<void> | null = null;

  async prepare(
    sourceUrl: string,
    headers: Record<string, string>,
    isCurrent: () => boolean,
    preparedProxy?: AutoPlaybackPreparation,
    direct = false,
  ): Promise<ArtPlayer2VodSource> {
    const generation = ++this.generation;
    await this.drainOwnedResources();
    if (generation !== this.generation || !isCurrent()) {
      return { mode: "direct", url: sourceUrl };
    }
    if (direct) return { mode: "direct", url: sourceUrl };
    if (preparedProxy) {
      if (preparedProxy.format !== "progressive" || !preparedProxy.url.trim()) {
        throw new Error("The prepared playback source is not progressive media.");
      }
      return { mode: "prepared", url: preparedProxy.url };
    }
    return this.trackOperation(
      this.prepareCurrent(sourceUrl, headers, generation, isCurrent),
    );
  }

  async fallbackToProxy(
    sourceUrl: string,
    headers: Record<string, string>,
    isCurrent: () => boolean,
  ): Promise<ArtPlayer2VodSource | null> {
    const generation = ++this.generation;
    return this.trackOperation(
      this.createProxy(sourceUrl, headers, generation, isCurrent),
    );
  }

  release(): void {
    void this.releaseAndWait().catch(() => undefined);
  }

  async releaseAndWait(): Promise<void> {
    this.generation += 1;
    await this.drainOwnedResources();
  }

  private async prepareCurrent(
    sourceUrl: string,
    headers: Record<string, string>,
    generation: number,
    isCurrent: () => boolean,
  ): Promise<ArtPlayer2VodSource> {
    const bridge = getElectronBridge();
    if (!bridge?.inspectPlaybackUrl) {
      return { mode: "direct", url: sourceUrl };
    }

    try {
      const inspection = await bridge.inspectPlaybackUrl(sourceUrl, headers);
      if (generation !== this.generation || !isCurrent()) {
        return { mode: "direct", url: sourceUrl };
      }
      if (hasValidByteRangeResponse(inspection)) {
        return { mode: "direct", url: sourceUrl };
      }
    } catch {
      // The local gateway is the compatibility path when probing fails.
    }

    if (generation !== this.generation || !isCurrent()) {
      return { mode: "direct", url: sourceUrl };
    }
    return this.createProxy(sourceUrl, headers, generation, isCurrent);
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

    let proxy: { id: string; url: string };
    try {
      proxy = await bridge.createProgressiveVodProxySession(
        sourceUrl,
        headers,
      );
    } catch {
      return { mode: "direct", url: sourceUrl };
    }

    if (
      !proxy ||
      typeof proxy.id !== "string" ||
      proxy.id.trim().length === 0 ||
      typeof proxy.url !== "string" ||
      proxy.url.trim().length === 0
    ) {
      if (typeof proxy?.id === "string" && proxy.id.trim()) {
        await this.releaseRemote(bridge, proxy.id);
      }
      throw new Error("The progressive VOD proxy returned an invalid session.");
    }
    if (generation !== this.generation || !isCurrent()) {
      await this.releaseRemote(bridge, proxy.id);
      return { mode: "direct", url: sourceUrl };
    }

    this.proxySession = { id: proxy.id, bridge };
    return { mode: "proxy", url: proxy.url };
  }

  private trackOperation<T extends ArtPlayer2VodSource | null>(
    operation: Promise<T>,
  ): Promise<T> {
    const tracked: Promise<T> = operation.finally(() =>
      this.pendingOperations.delete(tracked),
    );
    this.pendingOperations.add(tracked);
    return tracked;
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
    while (this.pendingOperations.size > 0) {
      await Promise.allSettled([...this.pendingOperations]);
    }

    const session = this.proxySession;
    this.proxySession = null;
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
        .join("; ");
      throw new AggregateError(failures, `ArtPlayer2 VOD proxy release failed: ${details}`);
    }
  }

  private async releaseRemote(
    bridge: ElectronBridgeApi,
    id: string,
  ): Promise<void> {
    this.pendingReleases.set(id, bridge);
    if (!bridge.releaseProgressiveVodProxySession) {
      throw new Error("Progressive VOD proxy release is unavailable.");
    }
    await bridge.releaseProgressiveVodProxySession(id);
    this.pendingReleases.delete(id);
  }
}

export function isArtPlayer2VodRangeCompatible(
  inspection: PlaybackNetworkInspection,
): boolean {
  return hasValidByteRangeResponse(inspection);
}
