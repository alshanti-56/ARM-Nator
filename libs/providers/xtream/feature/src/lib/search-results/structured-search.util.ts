import {
  canonicalCatalogGenre,
  catalogGenreValues,
  catalogYear,
  GlobalSearchResult,
  normalizeTitleKeys,
} from "@arm-nator/shared/interfaces";

export interface StructuredSearchGenreOption {
  value: string;
  label: string;
}

export const STRUCTURED_SEARCH_GENRE_OPTIONS: readonly StructuredSearchGenreOption[] = [
  ["action", "Action"],
  ["adventure", "Adventure"],
  ["animation", "Animation"],
  ["comedy", "Comedy"],
  ["crime", "Crime"],
  ["documentary", "Documentary"],
  ["drama", "Drama"],
  ["family", "Family"],
  ["fantasy", "Fantasy"],
  ["history", "History"],
  ["horror", "Horror"],
  ["kids", "Kids"],
  ["music", "Music"],
  ["mystery", "Mystery"],
  ["news", "News"],
  ["reality", "Reality"],
  ["romance", "Romance"],
  ["sci-fi", "Science Fiction"],
  ["soap", "Soap"],
  ["talk", "Talk"],
  ["thriller", "Thriller"],
  ["war", "War"],
  ["western", "Western"],
].map(([value, label]) => ({ value, label }));

export function structuredSearchYearOptions(
  currentYear = new Date().getFullYear(),
): number[] {
  const firstYear = 1888;
  return Array.from(
    { length: Math.max(0, currentYear - firstYear + 1) },
    (_, index) => currentYear - index,
  );
}

export interface StructuredSearchFields {
  titleQuery: string;
  actorQuery: string;
  year: number | null;
  genres: string[];
}

/** Keep broad catalog matches, removing only rows that explicitly contradict
 * a selected year or genre. Missing provider metadata remains visible. */
export function filterBroadCatalogResults(
  results: readonly GlobalSearchResult[],
  query: Pick<StructuredSearchFields, "year" | "genres">,
): GlobalSearchResult[] {
  return results.filter((result) => {
    if (query.year !== null) {
      const resultYear = catalogYear({
        title: result.title,
        releaseDate: result.releaseDate ?? undefined,
      });
      if (resultYear !== null && resultYear !== query.year) {
        return false;
      }
    }

    if (query.genres.length === 0) {
      return true;
    }

    const resultGenres = catalogGenreValues({ genre: result.genre ?? "" }).map(
      canonicalCatalogGenre,
    );
    return (
      resultGenres.length === 0 ||
      query.genres.every((genre) => resultGenres.includes(genre))
    );
  });
}

/** Rank exact canonical-title variants before related broad title matches. */
export function rankBroadCatalogResults(
  results: readonly GlobalSearchResult[],
  canonicalTitles: readonly string[],
): GlobalSearchResult[] {
  const wantedTitles = canonicalTitles
    .map((title) => normalizeTitleKeys(title).base)
    .filter(Boolean);

  const rank = (result: GlobalSearchResult): number => {
    const candidate = normalizeTitleKeys(result.title);
    if (wantedTitles.some((title) => candidate.exact === title || candidate.base === title)) {
      return 0;
    }
    if (wantedTitles.some((title) => candidate.exact.includes(title))) {
      return 1;
    }
    return 2;
  };

  return results
    .map((result, index) => ({ result, index, rank: rank(result) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ result }) => result);
}

export function normalizeYearSearchValue(
  value: string | number | null | undefined,
): string {
  return value == null ? "" : String(value).trim();
}

export function buildStructuredSearchFields(fields: {
  title?: string | null;
  actor?: string | null;
  year?: string | number | null;
  genre?: string | null;
}): StructuredSearchFields {
  const yearText = normalizeYearSearchValue(fields.year);
  const parsedYear = Number(yearText);
  const year =
    /^(?:19|20)\d{2}$/.test(yearText) && parsedYear >= 1888 && parsedYear <= 2100
      ? parsedYear
      : null;

  return {
    titleQuery: fields.title?.trim() ?? "",
    actorQuery: fields.actor?.trim() ?? "",
    year,
    genres: [
      ...new Set(
        (fields.genre ?? "")
          .split(",")
          .map((genre) => canonicalCatalogGenre(genre.trim()))
          .filter(Boolean),
      ),
    ],
  };
}
