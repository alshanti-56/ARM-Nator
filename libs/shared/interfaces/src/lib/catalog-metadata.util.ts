/**
 * Metadata helpers shared by the catalog filters and the poster grid.
 * Xtream sends list and detail payloads with slightly different shapes, so
 * keep the field-name fallbacks in one place.
 */
export type CatalogMetadataRecord = Readonly<Record<string, unknown>>;

export interface XtreamContentMetadata {
  genre?: string;
  releaseDate?: string;
  country?: string;
  director?: string;
  cast?: string;
  description?: string;
  rating?: string;
  posterUrl?: string;
  backdropUrl?: string;
}

export type XtreamMetadataEnrichmentStatus = "complete" | "failed";

export interface XtreamMetadataEnrichmentState {
  status: XtreamMetadataEnrichmentStatus;
  attemptedAt: string;
  retryAfter: string | null;
}

export interface MetadataDisplayEntry {
  key: string;
  label: string;
  value: string;
}

/**
 * Turns an arbitrary provider payload into safe, readable detail rows.
 * This intentionally does not use a fixed field list: new Xtream fields can
 * be displayed before the typed catalog model is updated.
 */
export function metadataDisplayEntries(
  record: CatalogMetadataRecord | null | undefined,
  keyPrefix = "",
): MetadataDisplayEntry[] {
  if (!record) return [];

  return Object.entries(record)
    .map(([key, rawValue]) => {
      const value = metadataDisplayValue(rawValue);
      if (!value) return null;

      const fullKey = keyPrefix ? `${keyPrefix}.${key}` : key;
      return {
        key: fullKey,
        label: humanizeMetadataKey(fullKey),
        value,
      };
    })
    .filter((entry): entry is MetadataDisplayEntry => entry !== null);
}

function metadataDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    return value.every(
      (entry) =>
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean",
    )
      ? value.join(", ")
      : JSON.stringify(value);
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }
  return undefined;
}

function humanizeMetadataKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b(tmdb|imdb|url|id)\b/gi, (token) => token.toUpperCase())
    .replace(/\b\w/g, (token) => token.toUpperCase());
}

function nestedInfo(item: CatalogMetadataRecord): CatalogMetadataRecord | null {
  const info = item["info"];
  return info && typeof info === "object" && !Array.isArray(info)
    ? (info as CatalogMetadataRecord)
    : null;
}

function metadataText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;

    // Some Xtream-compatible panels serialize list metadata as a JSON array
    // even though the field is declared as a string. Decode that shape so a
    // provider-supplied genre is preserved without any detail request.
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return metadataText(parsed);
      } catch {
        // Keep the original value when a panel uses a non-JSON bracketed
        // label. It is still useful metadata and should not be discarded.
      }
    }

    return trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (!Array.isArray(value)) return undefined;

  const values = value
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (typeof entry === "number" && Number.isFinite(entry)) {
        return String(entry);
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as Record<string, unknown>;
        return metadataText(record["name"] ?? record["title"]);
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));

  return values.length ? values.join(", ") : undefined;
}

function metadataSources(item: CatalogMetadataRecord): CatalogMetadataRecord[] {
  const sources: CatalogMetadataRecord[] = [item];

  // The standard player API uses `info` for get_vod_info. A number of
  // Xtream-compatible panels also put the same fields directly in a bulk
  // stream item under `movie_properties`/`movie_info`. Read those shapes too
  // so list-provided genres are imported without per-title detail calls.
  for (const key of [
    "info",
    "movie_properties",
    "movieProperties",
    "movie_info",
    "vod_info",
  ]) {
    const value = item[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      sources.push(value as CatalogMetadataRecord);
    }
  }

  return sources;
}

function firstText(
  item: CatalogMetadataRecord,
  fields: readonly string[],
): string | undefined {
  for (const source of metadataSources(item)) {
    for (const field of fields) {
      const value = metadataText(source[field]);
      if (value) return value;
    }
  }
  return undefined;
}

function peopleText(item: CatalogMetadataRecord): string | undefined {
  const info = nestedInfo(item);
  const names = [item["actors"], item["cast"], info?.["actors"], info?.["cast"]]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  return names.length ? names.join(" ") : undefined;
}

export function catalogTitle(item: CatalogMetadataRecord): string {
  return firstText(item, ["title", "name", "o_name"]) ?? "No name";
}

export function catalogGenre(item: CatalogMetadataRecord): string | undefined {
  return firstText(item, ["genre", "genres"]);
}

const CATALOG_GENRE_ALIASES: Readonly<Record<string, string>> = {
  adventeur: "adventure",
  aventure: "adventure",
  comedie: "comedy",
  comidie: "comedy",
  komodie: "comedy",
};

const CATALOG_GENRE_LABELS: Readonly<Record<string, string>> = {
  adventure: "Adventure",
  comedy: "Comedy",
};

function normalizeGenreKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Returns the stable comparison key used by the Refine genre filter. */
export function canonicalCatalogGenre(value: string): string {
  const key = normalizeGenreKey(value);
  return CATALOG_GENRE_ALIASES[key] ?? key;
}

function catalogGenreLabel(key: string): string {
  const knownLabel = CATALOG_GENRE_LABELS[key];
  if (knownLabel) return knownLabel;

  return key.replace(/(^|\s)\S/g, (letter) => letter.toLocaleUpperCase());
}

/** undefined keeps catalogTitle(item); null disables title fallback entirely. */
export function catalogYear(
  item: CatalogMetadataRecord,
  fallbackTitle?: string | null,
): number | null {
  const releaseMetadataFields = [
    "releaseDate",
    "releasedate",
    "release_date",
    "first_air_date",
  ];
  const explicitYearFields = ["year"];

  const releaseMetadata = firstValidYear(item, releaseMetadataFields);
  if (releaseMetadata.value !== null || releaseMetadata.hasValue) {
    return releaseMetadata.value;
  }

  const explicitYear = firstValidYear(item, explicitYearFields);
  if (explicitYear.value !== null || explicitYear.hasValue) {
    return explicitYear.value;
  }

  // A title is only a last-resort source. In particular, do not allow a
  // future year embedded in a title (for example, "|EN| 2073") into Refine.
  const titleYear =
    fallbackTitle === null
      ? null
      : extractPlausibleYear(fallbackTitle ?? catalogTitle(item));
  return titleYear;
}

const MIN_PLAUSIBLE_YEAR = 1888;

function extractPlausibleYear(value: string): number | null {
  const match = value.match(/\b(19|20)\d{2}\b/);
  if (!match) return null;

  const year = Number(match[0]);
  const maximumYear = new Date().getFullYear() + 2;
  return year >= MIN_PLAUSIBLE_YEAR && year <= maximumYear ? year : null;
}

function firstValidYear(
  item: CatalogMetadataRecord,
  fields: readonly string[],
): { value: number | null; hasValue: boolean } {
  const info = nestedInfo(item);
  let hasValue = false;

  for (const field of fields) {
    for (const value of [item[field], info?.[field]]) {
      const text = metadataText(value);
      if (!text) continue;

      hasValue = true;
      const year = extractPlausibleYear(text);
      if (year !== null) return { value: year, hasValue: true };
    }
  }

  return { value: null, hasValue };
}

export function catalogRating(item: CatalogMetadataRecord): number | null {
  const raw = firstText(item, ["rating_imdb", "rating"]);
  const value = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

export function normalizeXtreamContentMetadata(
  item: CatalogMetadataRecord,
): XtreamContentMetadata {
  const backdrop = firstText(item, [
    "backdropUrl",
    "backdrop_url",
    "backdrop_path",
  ]);

  return {
    genre: firstText(item, ["genre", "genres"]),
    releaseDate: firstText(item, [
      "releaseDate",
      "releasedate",
      "release_date",
      "first_air_date",
      "year",
    ]),
    country: firstText(item, [
      "country",
      "countries",
      "production_countries",
      "origin_country",
    ]),
    director: firstText(item, [
      "director",
      "directors",
      "creator",
      "created_by",
    ]),
    cast: firstText(item, ["cast", "actors", "credits"]),
    description: firstText(item, [
      "description",
      "plot",
      "overview",
      "summary",
    ]),
    rating: firstText(item, [
      "rating_imdb",
      "rating",
      "vote_average",
      "imdb_rating",
    ]),
    posterUrl: firstText(item, [
      "posterUrl",
      "poster_url",
      "movie_image",
      "cover_big",
      "cover",
      "stream_icon",
      "poster_path",
    ]),
    backdropUrl: backdrop?.split(",")[0]?.trim() || undefined,
  };
}

/**
 * Bulk Xtream list responses can already contain the metadata needed by the
 * catalog search index. Keep the rule deliberately conservative: country is
 * not consistently present in list responses, but the core searchable fields
 * below are enough to avoid a detail request without hiding useful metadata.
 */
export function hasCompleteXtreamSearchMetadata(
  item: CatalogMetadataRecord,
): boolean {
  const metadata = normalizeXtreamContentMetadata(item);
  return Boolean(
    metadata.genre?.trim() &&
      metadata.releaseDate?.trim() &&
      metadata.director?.trim() &&
      metadata.cast?.trim() &&
      metadata.description?.trim(),
  );
}

/** Search all useful catalog metadata, not just the poster title. */
export function catalogSearchText(item: CatalogMetadataRecord): string {
  const info = nestedInfo(item);
  return [
    catalogTitle(item),
    catalogGenre(item),
    catalogYear(item),
    firstText(item, ["country"]),
    firstText(item, ["director"]),
    peopleText(item),
    firstText(item, ["description", "plot"]),
    firstText(item, ["duration", "episode_run_time"]),
    info?.["tmdb_status"],
  ]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLocaleLowerCase();
}

export function catalogGenreValues(item: CatalogMetadataRecord): string[] {
  return (catalogGenre(item) ?? "")
    .split(/[,|;/]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function collectCatalogGenres(
  items: readonly CatalogMetadataRecord[],
): string[] {
  const genres = new Map<string, string>();
  for (const item of items) {
    for (const genre of catalogGenreValues(item)) {
      const key = canonicalCatalogGenre(genre);
      if (!genres.has(key)) genres.set(key, catalogGenreLabel(key));
    }
  }
  return Array.from(genres.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

export function collectCatalogYears(
  items: readonly CatalogMetadataRecord[],
): number[] {
  const years = new Set<number>();
  for (const item of items) {
    const year = catalogYear(item);
    if (year !== null) years.add(year);
  }
  return Array.from(years).sort((a, b) => b - a);
}
