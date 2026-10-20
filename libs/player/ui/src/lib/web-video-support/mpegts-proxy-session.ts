import type {
  AutoPlaybackPreparation,
  ElectronBridgeApi,
  PlaybackRequestPolicy,
} from "@arm-nator/shared/interfaces";

function getElectronBridge(): ElectronBridgeApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as Window & { electron?: ElectronBridgeApi }).electron;
}

/**
 * Owns the renderer-side lifetime of one opaque main-process MPEG-TS session.
 *
 * Stalker streams commonly require a MAC cookie, serial number, or bearer
 * token. Keeping those headers in the Electron-side proxy avoids CORS and
 * prevents credentials from being sent directly by the browser to the
 * provider. The source URL remains the fallback for non-Electron builds.
 */
export class MpegTsProxySession {
  private generation = 0;
  private session: { id: string; bridge: ElectronBridgeApi } | null = null;
  private proxiedUrl: string | null = null;
  private readonly activeLoads = new Set<Promise<string>>();
  private readonly pendingReleases = new Map<string, ElectronBridgeApi>();
  private drainInFlight: Promise<void> | null = null;

  get currentUrl(): string | null {
    return this.proxiedUrl;
  }

  async load(
    sourceUrl: string,
    headers: Record<string, string> | undefined,
    isCurrent: () => boolean,
    isLive = true,
    preparedProxy?: AutoPlaybackPreparation,
    requestPolicy?: PlaybackRequestPolicy,
    direct = false,
  ): Promise<string> {
    const generation = ++this.generation;
    if (this.drainInFlight) {
      await this.drainInFlight;
    } else if (this.session || this.pendingReleases.size > 0) {
      await this.drainOwnedResources();
    }
    if (generation !== this.generation) {
      return sourceUrl;
    }

    this.proxiedUrl = null;
    if (direct) {
      if (!isCurrent()) {
        return sourceUrl;
      }
      return sourceUrl;
    }

    if (preparedProxy) {
      if (!isCurrent()) {
        return sourceUrl;
      }
      if (preparedProxy.format !== "mpegts" || !preparedProxy.url.trim()) {
        throw new Error("The prepared playback source is not MPEG-TS.");
      }
      this.proxiedUrl = preparedProxy.url;
      return preparedProxy.url;
    }

    const bridge = getElectronBridge();

    if (!bridge?.createMpegTsProxySession) {
      return sourceUrl;
    }

    const load = this.loadCurrent(
      bridge,
      sourceUrl,
      headers,
      isCurrent,
      isLive,
      generation,
      requestPolicy,
    );
    const tracked: Promise<string> = load.finally(() =>
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
    sourceUrl: string,
    headers: Record<string, string> | undefined,
    isCurrent: () => boolean,
    isLive: boolean,
    generation: number,
    requestPolicy?: PlaybackRequestPolicy,
  ): Promise<string> {
    let proxy: { id: string; url: string };
    try {
      proxy = requestPolicy === undefined
        ? await bridge.createMpegTsProxySession!(sourceUrl, headers, isLive)
        : await bridge.createMpegTsProxySession!(
            sourceUrl,
            headers,
            isLive,
            requestPolicy,
          );
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Unable to create the Electron MPEG-TS proxy.");
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
      throw new Error("The Electron MPEG-TS proxy returned an invalid session.");
    }
    if (generation !== this.generation || !isCurrent()) {
      await this.releaseRemote(bridge, proxy.id);
      return sourceUrl;
    }

    this.session = { id: proxy.id, bridge };
    this.proxiedUrl = proxy.url;
    return proxy.url;
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
    this.proxiedUrl = null;
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
      throw new AggregateError(
        failures,
        `MPEG-TS proxy release failed: ${details}`,
      );
    }
  }

  private async releaseRemote(
    bridge: ElectronBridgeApi,
    sessionId: string,
  ): Promise<void> {
    this.pendingReleases.set(sessionId, bridge);
    const release = bridge.releaseMpegTsProxySession;
    if (typeof release !== "function") {
      throw new Error("MPEG-TS proxy release is unavailable.");
    }
    await release(sessionId);
    this.pendingReleases.delete(sessionId);
  }
}
