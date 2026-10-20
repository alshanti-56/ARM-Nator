import type {
  AutoPlaybackPreparation,
  ElectronBridgeApi,
  PlaybackRequestPolicy,
} from "@arm-nator/shared/interfaces";

interface HlsSourceLoader {
  loadSource(url: string): void;
}

/** Owns one renderer-side HLS proxy session, including in-flight creation. */
export class HlsProxySession {
  private generation = 0;
  private session: { id: string; bridge: ElectronBridgeApi } | null = null;
  private readonly activeLoads = new Set<Promise<boolean>>();
  private readonly pendingReleases = new Map<string, ElectronBridgeApi>();
  private drainInFlight: Promise<void> | null = null;

  async load(
    loader: HlsSourceLoader,
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
      try {
        loader.loadSource(sourceUrl);
        return true;
      } catch {
        return false;
      }
    }

    if (preparedProxy) {
      if (preparedProxy.format !== "hls" || !preparedProxy.url.trim()) {
        return false;
      }
      try {
        loader.loadSource(preparedProxy.url);
        return true;
      } catch {
        return false;
      }
    }

    const bridge = (window as Window & { electron?: ElectronBridgeApi })
      .electron;

    if (!bridge || bridge.platform === "web") {
      if (!isCurrent()) {
        return false;
      }
      try {
        loader.loadSource(sourceUrl);
        return true;
      } catch {
        return false;
      }
    }
    if (!bridge.createHlsProxySession || !bridge.releaseHlsProxySession) {
      return false;
    }

    const load = this.loadCurrent(
      bridge,
      loader,
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
    loader: HlsSourceLoader,
    sourceUrl: string,
    headers: Record<string, string> | undefined,
    isCurrent: () => boolean,
    generation: number,
    requestPolicy?: PlaybackRequestPolicy,
  ): Promise<boolean> {
    let proxy: { id: string; url: string };
    try {
      proxy = requestPolicy === undefined
        ? await bridge.createHlsProxySession!(sourceUrl, headers)
        : await bridge.createHlsProxySession!(sourceUrl, headers, requestPolicy);
    } catch {
      return false;
    }

    if (
      typeof proxy?.id !== "string" ||
      !proxy.id.trim() ||
      typeof proxy.url !== "string" ||
      !proxy.url.trim()
    ) {
      if (typeof proxy?.id === "string" && proxy.id.trim()) {
        await this.releaseRemote(bridge, proxy.id);
      }
      return false;
    }
    if (generation !== this.generation || !isCurrent()) {
      await this.releaseRemote(bridge, proxy.id);
      return false;
    }

    this.session = { id: proxy.id, bridge };
    try {
      loader.loadSource(proxy.url);
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
        .join("; ");
      throw new AggregateError(failures, `HLS proxy release failed: ${details}`);
    }
  }

  private async releaseRemote(
    bridge: ElectronBridgeApi,
    id: string,
  ): Promise<void> {
    this.pendingReleases.set(id, bridge);
    if (!bridge.releaseHlsProxySession) {
      throw new Error("HLS proxy release is unavailable.");
    }
    await bridge.releaseHlsProxySession(id);
    this.pendingReleases.delete(id);
  }
}
