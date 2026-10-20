import type {
  PortalSearchContinuation,
  PortalSearchPage,
} from "./unified-discovery";
import type { StalkerAuthFailureMarker } from "./stalker-auth-failure.util";
/** Data-only IPC: AbortSignals remain in their owning process. */
export interface StalkerRequestPayload {
  url: string;
  macAddress: string;
  params: Record<string, string | number>;
  token?: string;
  serialNumber?: string;
  requestId?: string;
  accountRef?: string;
  timeoutMs?: number;
}
export const STALKER_CANCEL_REQUEST = "STALKER_CANCEL_REQUEST";

export interface StalkerSearchContext {
  playlistId: string;
  providerName: string;
  page: PortalSearchContinuation;
}
export interface StalkerSearchRequestPayload extends StalkerRequestPayload {
  discovery: StalkerSearchContext;
}
export type StalkerSearchPageResponse =
  PortalSearchPage | StalkerAuthFailureMarker;
export const STALKER_SEARCH_PAGE = "STALKER_SEARCH_PAGE";
