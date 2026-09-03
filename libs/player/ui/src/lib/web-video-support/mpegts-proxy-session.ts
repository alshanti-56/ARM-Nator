import type { ElectronBridgeApi } from "@arm-nator/shared/interfaces";

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
  private sessionId: string | null = null;
  private proxiedUrl: string | null = null;

  get currentUrl(): string | null {
    return this.proxiedUrl;
  }

  async load(
    sourceUrl: string,
    headers: Record<string, string> | undefined,
    isCurrent: () => boolean,
  ): Promise<string> {
    this.release();
    const generation = ++this.generation;
    const bridge = getElectronBridge();

    if (!bridge?.createMpegTsProxySession) {
      return sourceUrl;
    }

    try {
      const proxy = await bridge.createMpegTsProxySession(sourceUrl, headers);
      if (
        !proxy ||
        typeof proxy.id !== "string" ||
        proxy.id.trim().length === 0 ||
        typeof proxy.url !== "string" ||
        proxy.url.trim().length === 0
      ) {
        if (typeof proxy?.id === "string") {
          this.releaseRemote(bridge, proxy.id);
        }
        throw new Error(
          "The Electron MPEG-TS proxy returned an invalid session.",
        );
      }
      if (generation !== this.generation || !isCurrent()) {
        this.releaseRemote(bridge, proxy.id);
        return sourceUrl;
      }
      this.sessionId = proxy.id;
      this.proxiedUrl = proxy.url;
      return proxy.url;
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("Unable to create the Electron MPEG-TS proxy.");
    }
  }

  release(): void {
    this.generation += 1;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.proxiedUrl = null;
    if (sessionId) {
      this.releaseRemote(getElectronBridge(), sessionId);
    }
  }

  private releaseRemote(
    bridge: ElectronBridgeApi | undefined,
    sessionId: string,
  ): void {
    const release = bridge?.releaseMpegTsProxySession;
    if (typeof release !== "function") {
      return;
    }

    try {
      void Promise.resolve(release(sessionId)).catch(() => undefined);
    } catch {
      // A renderer teardown must not turn a best-effort cleanup into an
      // unhandled rejection.
    }
  }
}
