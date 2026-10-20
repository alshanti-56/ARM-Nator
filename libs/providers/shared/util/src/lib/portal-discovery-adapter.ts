import { InjectionToken } from "@angular/core";
import type {
  DiscoveryRanking,
  ResolvedPortalPlayback,
  DiscoveryVersion,
  PortalSearchContinuation,
  PortalSearchPage,
} from "@arm-nator/shared/interfaces";
import type { DiscoveryPortal } from "./portal-discovery-coordinator";
export interface PortalDiscoveryAdapter {
  /** Local catalogue/remembered results only; never starts portal searches. */
  versions?(
    playback: ResolvedPortalPlayback,
    known: readonly DiscoveryVersion[],
  ): Promise<DiscoveryVersion[]>;
  rememberVersions?(versions: readonly DiscoveryVersion[]): Promise<void>;
  sources(): Promise<DiscoveryPortal[]>;
  page(
    source: DiscoveryPortal,
    query: string,
    page: PortalSearchContinuation,
    signal: AbortSignal,
  ): Promise<PortalSearchPage>;
  ranking(version: DiscoveryVersion): Promise<DiscoveryRanking>;
}
export const PORTAL_DISCOVERY_ADAPTER =
  new InjectionToken<PortalDiscoveryAdapter>("PORTAL_DISCOVERY_ADAPTER");
