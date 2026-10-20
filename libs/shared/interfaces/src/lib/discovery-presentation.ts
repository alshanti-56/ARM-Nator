import {
  normalizeTitleKeys,
  displayProviderTitle,
} from "./title-normalization.util";
import { catalogueIdentityKey, describeMovieWork } from "./viewing-continuity";
import type { DiscoveryVersion } from "./unified-discovery";

/** Only explicit provider release tags: a bare number may be part of the title. */
export function discoveryTitleYear(title: string): number | undefined {
  const years = new Set<number>();
  for (const match of title.matchAll(
    /\(\s*((?:19|20)\d{2})(?:\s+(?:MULTI|MULTI-SUB|VOSTFR|VF|HD|FHD|UHD|4K))*\s*\)|\[\s*((?:19|20)\d{2})(?:\s+(?:MULTI|MULTI-SUB|VOSTFR|VF|HD|FHD|UHD|4K))*\s*\]/gi,
  ))
    years.add(Number(match[1] ?? match[2]));
  const suffix = title.match(/\s[-–—]\s*((?:19|20)\d{2})(.*)$/);
  if (suffix && !normalizeTitleKeys(suffix[2]).exact)
    years.add(Number(suffix[1]));
  if (years.size !== 1) return undefined;
  const year = [...years][0];
  return year >= 1888 && year <= new Date().getFullYear() + 2
    ? year
    : undefined;
}

/** Discovery can use explicit catalogue title tags without changing saved viewing identities. */
export function describeDiscoveryWork(
  title: string,
  metadata: object | null | undefined,
) {
  const work = describeMovieWork(
    title.replace(/^([A-Z]{2,3})\s*[▎│]\s+/, "$1| "),
    metadata,
  );
  return {
    ...work,
    releaseYear: work.releaseYear ?? discoveryTitleYear(title),
  };
}

export function discoveryDisplayTitle(version: DiscoveryVersion): string {
  return displayProviderTitle(
    version.work?.title || version.originalTitle,
    version.work?.releaseYear,
  );
}

export interface DiscoverySourceGroup {
  key: string;
  providerName: string;
  versions: DiscoveryVersion[];
}
export function groupDiscoverySources(
  versions: readonly DiscoveryVersion[],
): DiscoverySourceGroup[] {
  const sources = new Map<string, DiscoverySourceGroup>(),
    seen = new Set<string>();
  for (const version of versions) {
    const identity = catalogueIdentityKey(version.identity);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = JSON.stringify([
      version.identity.sourceType,
      version.identity.playlistId,
    ]);
    const source = sources.get(key) ?? {
      key,
      providerName: version.providerName,
      versions: [],
    };
    source.versions.push(version);
    sources.set(key, source);
  }
  return [...sources.values()];
}
