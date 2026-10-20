import { catalogueIdentityKey, describeMovieWork } from "./viewing-continuity";
import type { ViewingItem, WorkDescriptor } from "./viewing-continuity";

/** Portal IDs stay opaque; episode titles/IDs do not establish a parent series identity. */
export function stalkerViewingItem(
  playlistId: string,
  item: object,
  options: {
    episodeNumber?: number;
    seasonNumber?: number;
    episodeProviderId?: string | number;
    parent?: { id: string; work: WorkDescriptor };
    categoryId?: string;
  } = {},
): ViewingItem {
  const row = item as Record<string, unknown>;
  const rawId = row["id"] ?? row["stream_id"];
  if (rawId === null || rawId === undefined || !String(rawId).trim())
    throw new Error("Missing Stalker item identity");
  const title = String(
    row["o_name"] ?? row["name"] ?? row["title"] ?? "Unknown",
  );
  const episode =
    options.episodeNumber !== undefined ||
    options.episodeProviderId !== undefined;
  const seriesId = row["series_id"];
  const parent =
    options.parent ??
    (episode &&
    seriesId !== undefined &&
    String(seriesId).trim() &&
    row["series_title"]
      ? {
          id: String(seriesId),
          work: {
            ...describeMovieWork(String(row["series_title"]), {
              year: row["series_year"],
              tmdb_id: row["series_tmdb_id"],
              imdb_id: row["series_imdb_id"],
            }),
            kind: "series" as const,
          },
        }
      : undefined);
  const identity = {
    sourceType: "stalker" as const,
    playlistId,
    contentKind: episode ? ("episode" as const) : ("vod" as const),
    providerItemId: episode
      ? JSON.stringify([
          String(rawId),
          options.episodeProviderId ?? options.seasonNumber ?? null,
          options.episodeNumber,
        ])
      : String(rawId),
  };
  catalogueIdentityKey(identity);
  const seriesIdentity = parent
    ? {
        sourceType: "stalker" as const,
        playlistId,
        contentKind: "series" as const,
        providerItemId: parent.id,
      }
    : undefined;
  return {
    identity,
    seriesIdentity,
    work: episode
      ? {
          kind: "episode",
          title,
          series: parent?.work,
          seasonNumber: options.seasonNumber,
          episodeNumber: options.episodeNumber,
        }
      : describeMovieWork(title, item),
    activity:
      !episode || parent
        ? {
            title: episode && parent ? parent.work.title : title,
            contentKind: episode ? "series" : "movie",
            providerItemId: episode && parent ? parent.id : String(rawId),
            categoryId: String(
              row["category_id"] ??
                row["genre_id"] ??
                options.categoryId ??
                "*",
            ),
            posterUrl:
              typeof row["cover"] === "string"
                ? row["cover"]
                : typeof row["logo"] === "string"
                  ? row["logo"]
                  : undefined,
          }
        : undefined,
  };
}

/** Command-only portal responses remain playable without fabricating catalogue history. */
export function optionalStalkerViewingItem(
  playlistId: string,
  item: object,
  options: Parameters<typeof stalkerViewingItem>[2] = {},
): ViewingItem | null {
  const row = item as Record<string, unknown>;
  const id = row["id"] ?? row["stream_id"];
  return id === null || id === undefined || !String(id).trim()
    ? null
    : stalkerViewingItem(playlistId, item, options);
}
