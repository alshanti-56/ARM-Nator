import type { GlobalSearchResult } from "./global-search-result.interface";
import type {
  DiscoveryVersion,
  PortalSearchContinuation,
  PortalSearchPage,
} from "./unified-discovery";
import {
  describeDiscoveryWork,
  discoveryCatalogDisplayYear,
} from "./discovery-presentation";
import { normalizeTrackLanguage } from "./title-track-preferences";

/** Read only explicit provider tags; unlabelled quality/language remains unknown. */
export function discoveryMediaHints(
  title: string,
  categoryName?: string | null,
): Pick<DiscoveryVersion, "resolution" | "languages"> {
  const resolutionTag = title.match(/\b(2160|1080|720|480)p\b/i)?.[1];
  const named =
    title.match(/(?:\||\[|\()(4K|UHD|FHD|HD|SD)(?:\||\]|\))/i)?.[1] ??
    title.match(/(?:^|\s)(4K|UHD|FHD|HD|SD)\s*$/i)?.[1];
  const resolutions: Record<string, number> = {
    "4K": 2160,
    UHD: 2160,
    FHD: 1080,
    HD: 720,
    SD: 480,
  };
  const languageTag = title
    .match(/^\s*(?:\|([A-Z]{2,3})\||([A-Z]{2,3})\s*[-|▎│]\s*)/)
    ?.slice(1)
    .find(Boolean);
  const normalized = normalizeTrackLanguage(languageTag);
  const known = new Set([
    "en",
    "ar",
    "fr",
    "de",
    "es",
    "pt",
    "it",
    "ru",
    "ja",
    "ko",
    "zh",
    "hi",
    "tr",
    "nl",
    "fa",
    "ur",
    "pl",
    "uk",
    "he",
    "el",
    "ro",
    "sv",
    "no",
    "da",
    "fi",
    "cs",
    "hu",
    "th",
  ]);
  const language = normalized && known.has(normalized) ? normalized : null;
  const multi =
    /[|┃▎│[(]\s*MULTI\s*[|┃▎│\])]/i.test(title) ||
    /[[(]\s*\d{4}\s+MULTI\s*[\])]/i.test(title) ||
    /^\s*MULTI\s*[-|┃▎│]/i.test(title) ||
    /\S\s+MULTI\s*$/i.test(title) ||
    (!language && /\bMULTI\b/i.test(categoryName ?? ""));
  return {
    resolution: resolutionTag
      ? Number(resolutionTag)
      : named
        ? resolutions[named.toUpperCase()]
        : undefined,
    languages: multi ? ["mul"] : language ? [language] : undefined,
  };
}
export function xtreamDiscoveryVersion(
  row: GlobalSearchResult,
): DiscoveryVersion {
  const type = row.content_type ?? row.type;
  const routeType = type === "movie" ? "vod" : type;
  const work =
    type === "live"
      ? undefined
      : { ...describeDiscoveryWork(row.title, row), kind: type };
  return {
    identity: {
      sourceType: "xtream",
      playlistId: row.playlist_id,
      contentKind: routeType,
      providerItemId: String(row.xtream_id),
    },
    providerName: row.playlist_name,
    categoryId: String(row.category_id),
    originalTitle: row.title,
    contentType: type,
    posterUrl: row.poster_url ?? undefined,
    backdropUrl: row.backdrop_url || undefined,
    description: row.description || undefined,
    genre: row.genre || undefined,
    displayYear:
      type === "live" ? undefined : discoveryCatalogDisplayYear(row.title, row),
    work,
    ...discoveryMediaHints(row.title, row.category_name),
    navigation: [
      "/workspace/xtreams",
      row.playlist_id,
      routeType,
      String(row.category_id),
      String(row.xtream_id),
    ],
  };
}
export function stalkerDiscoveryPage(
  response: unknown,
  playlistId: string,
  providerName: string,
  page: PortalSearchContinuation,
): PortalSearchPage {
  const envelope = response as { js?: unknown };
  const body = envelope?.js as Record<string, unknown> | unknown[] | undefined;
  if (!body || typeof body !== "object")
    throw new Error("Portal returned a malformed search page");
  if (!Array.isArray(body) && body["error"])
    throw new Error(String(body["error"]));
  const data = Array.isArray(body) ? body : body["data"];
  if (!Array.isArray(data) || data.length > 1000)
    throw new Error("Portal returned a malformed search page");
  const versions = data.map((raw): DiscoveryVersion => {
    if (!raw || typeof raw !== "object")
      throw new Error("Portal returned a malformed search item");
    const row = raw as Record<string, unknown>;
    const id = row["id"] ?? row["stream_id"] ?? row["series_id"];
    if (id === undefined || id === null || !String(id).trim())
      throw new Error("Portal returned an item without an identity");
    const title = String(
      row["o_name"] ?? row["name"] ?? row["title"] ?? "Unknown",
    );
    const category = String(row["category_id"] ?? row["genre_id"] ?? "*");
    const isSeries =
      page.contentType === "series" ||
      row["is_series"] === true ||
      row["is_series"] === 1 ||
      row["is_series"] === "1";
    const contentType =
      page.contentType === "live" ? "live" : isSeries ? "series" : "movie";
    const routeType =
      page.contentType === "movie"
        ? "vod"
        : page.contentType === "live"
          ? "itv"
          : "series";
    return {
      identity: {
        sourceType: "stalker",
        playlistId,
        contentKind: contentType === "movie" ? "vod" : contentType,
        providerItemId: String(id),
      },
      providerName,
      categoryId: category,
      originalTitle: title,
      contentType,
      posterUrl:
        typeof row["cover"] === "string"
          ? row["cover"]
          : typeof row["logo"] === "string"
            ? row["logo"]
            : undefined,
      description:
        typeof row["description"] === "string"
          ? row["description"]
          : typeof row["plot"] === "string"
            ? row["plot"]
            : undefined,
      genre: typeof row["genre"] === "string" ? row["genre"] : undefined,
      displayYear:
        contentType === "live"
          ? undefined
          : discoveryCatalogDisplayYear(title, row),
      work:
        contentType === "live"
          ? undefined
          : { ...describeDiscoveryWork(title, row), kind: contentType },
      ...discoveryMediaHints(
        title,
        typeof row["category_name"] === "string"
          ? row["category_name"]
          : undefined,
      ),
      navigation: [
        "/workspace/stalker",
        playlistId,
        routeType,
        category,
        ...(contentType === "live" ? [] : [String(id)]),
      ],
      navigationState:
        contentType === "live"
          ? {
              openStalkerDiscoveryItem: {
                playlistId,
                providerItemId: String(id),
                row: { ...row },
              },
            }
          : undefined,
    };
  });
  const total = Array.isArray(body) ? NaN : Number(body["total_items"]);
  const size = Array.isArray(body) ? NaN : Number(body["max_page_items"]);
  const knownBoundary =
    Number.isSafeInteger(total) &&
    total >= 0 &&
    Number.isSafeInteger(size) &&
    size > 0;
  return {
    versions,
    continuation:
      data.length > 0 && (!knownBoundary || page.page * size < total)
        ? { ...page, page: page.page + 1 }
        : undefined,
  };
}

/** Route state is consumed only by its named source and exact returned item. */
export function readStalkerDiscoveryLiveSelection(
  state: Record<string, unknown> | null | undefined,
  playlistId: string,
): Record<string, unknown> | null {
  const selection = state?.["openStalkerDiscoveryItem"] as
    | { playlistId?: unknown; providerItemId?: unknown; row?: unknown }
    | undefined;
  if (
    selection?.playlistId !== playlistId ||
    !selection.row ||
    typeof selection.row !== "object"
  )
    return null;
  const row = selection.row as Record<string, unknown>;
  const id = row["id"] ?? row["stream_id"];
  return id !== undefined && String(id) === selection.providerItemId
    ? row
    : null;
}
