export type ContentMetadataSource = "provider" | "tmdb";

/** The unmodified provider response and the matched TMDB response, kept in memory. */
export interface ContentMetadataSources<TInfo> {
  provider: TInfo;
  tmdb: Readonly<Record<string, unknown>>;
}

export function preserveMetadataSources<TInfo>(
  previous: ContentMetadataSources<TInfo> | undefined,
  provider: TInfo,
  tmdb: Readonly<Record<string, unknown>>,
): ContentMetadataSources<TInfo> {
  return {
    provider: previous?.provider ?? structuredClone(provider),
    tmdb: structuredClone(tmdb),
  };
}

/** Selects display metadata only; never changes the selected playable item. */
export function metadataInfoForSource<TInfo>(
  item:
    | {
        info?: TInfo | [] | null;
        metadataSources?: ContentMetadataSources<TInfo>;
      }
    | null
    | undefined,
  source: ContentMetadataSource,
): TInfo | null {
  const info =
    source === "provider"
      ? (item?.metadataSources?.provider ?? item?.info)
      : item?.info;
  return info && !Array.isArray(info) && typeof info === "object"
    ? (info as TInfo)
    : null;
}
