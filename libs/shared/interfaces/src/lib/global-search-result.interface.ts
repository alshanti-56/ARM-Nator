import type { DiscoveryVersion } from "./unified-discovery";
import type { CatalogueItemIdentity } from "./viewing-continuity";
export const GLOBAL_SEARCH_RESULT_SOURCES = {
  Xtream: "xtream",
} as const;

export type GlobalSearchResultSource =
  (typeof GLOBAL_SEARCH_RESULT_SOURCES)[keyof typeof GLOBAL_SEARCH_RESULT_SOURCES];

export interface GlobalSearchPaginationOptions {
  limit?: number;
  offset?: number;
}

export const GLOBAL_SEARCH_CONTENT_TYPES = {
  Live: "live",
  Movie: "movie",
  Series: "series",
} as const;

export type GlobalSearchContentType =
  (typeof GLOBAL_SEARCH_CONTENT_TYPES)[keyof typeof GLOBAL_SEARCH_CONTENT_TYPES];

export interface GlobalSearchBaseResult {
  source_type: GlobalSearchResultSource;
  content_type: GlobalSearchContentType;
  id: number | string;
  category_id: number | string;
  category_name?: string | null;
  title: string;
  rating: string | null;
  added: string | null;
  poster_url: string | null;
  xtream_id: number;
  type: GlobalSearchContentType;
  playlist_id: string;
  playlist_name: string;
}

export interface XtreamGlobalSearchResult extends GlobalSearchBaseResult {
  source_type: typeof GLOBAL_SEARCH_RESULT_SOURCES.Xtream;
  genre?: string | null;
  releaseDate?: string | null;
  country?: string | null;
  director?: string | null;
  cast?: string | null;
  description?: string;
  backdrop_url?: string | null;
  direct_source?: string | null;
  added_at?: string;
  viewed_at?: string;
  position?: number | null;
}

export type GlobalSearchResult = XtreamGlobalSearchResult;

/** Neutral portal variants retain string IDs; indexed Xtream callers keep the existing numeric adapter. */
export interface StalkerGlobalSearchResult extends DiscoveryVersion {
  identity: CatalogueItemIdentity & { sourceType: "stalker" };
}
export type UnifiedGlobalSearchResult =
  XtreamGlobalSearchResult | StalkerGlobalSearchResult;
export type {
  GroupedGlobalSearchResult,
  PortalSearchSourceStatus,
  PortalSearchContinuation,
} from "./unified-discovery";
