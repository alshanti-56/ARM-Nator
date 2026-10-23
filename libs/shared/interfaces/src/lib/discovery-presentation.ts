import {
  normalizeTitleKeys,
  displayProviderTitle,
} from "./title-normalization.util";
import {
  catalogYear,
  type CatalogMetadataRecord,
} from "./catalog-metadata.util";
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

/**
 * Resolves the year shown by the catalogue grid without promoting title-only
 * fallbacks into a saved or grouped work identity.
 */
export function discoveryCatalogDisplayYear(
  title: string,
  metadata: object | null | undefined,
): number | undefined {
  const explicitYear = discoveryTitleYear(title);
  const maximumYear = new Date().getFullYear() + 2;
  const titleYears = [...title.matchAll(/\b(?:19|20)\d{2}\b/g)]
    .map((match) => Number(match[0]))
    .filter((year) => year >= 1888 && year <= maximumYear);
  let fallbackTitle: string | null = null;

  if (explicitYear !== undefined) {
    fallbackTitle = String(explicitYear);
  } else if (titleYears.length === 1) {
    // A leading number is commonly part of the title (1917, 2001: A Space
    // Odyssey). Do not present it as a release year without provider metadata
    // or an explicit release tag.
    const withoutProviderPrefix = title
      .replace(/^\s*\|[A-Z]{2,3}\|\s*/i, "")
      .replace(/^\s*[A-Z]{2,3}\s*[-|▎│]\s*/i, "");
    if (!/^\s*(?:19|20)\d{2}(?:\b|:)/.test(withoutProviderPrefix))
      fallbackTitle = title;
  }

  return (
    catalogYear((metadata ?? {}) as CatalogMetadataRecord, fallbackTitle) ??
    undefined
  );
}

/** The UI may use a catalogue fallback; identity and grouping must use work. */
export function discoveryDisplayYear(
  version: DiscoveryVersion,
): number | undefined {
  return version.displayYear ?? version.work?.releaseYear ?? undefined;
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
