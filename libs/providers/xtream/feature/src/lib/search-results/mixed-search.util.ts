import {
  CatalogTitleMatch,
  canonicalCatalogGenre,
  catalogGenreValues,
  catalogYear,
} from "@arm-nator/shared/interfaces";

export interface MixedSearchQuery {
  personQuery: string;
  year: number | null;
  genres: string[];
}

const SINGLE_WORD_GENRES = new Set([
  "action",
  "adventure",
  "animation",
  "comedy",
  "crime",
  "documentary",
  "drama",
  "family",
  "fantasy",
  "history",
  "horror",
  "kids",
  "music",
  "mystery",
  "news",
  "reality",
  "romance",
  "sci-fi",
  "soap",
  "talk",
  "thriller",
  "war",
  "western",
]);

const MULTI_WORD_GENRES = new Set([
  "science fiction",
  "tv movie",
  "war politics",
]);

function normalizeToken(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isSearchYear(token: string): boolean {
  const year = Number(token);
  return /^(?:19|20)\d{2}$/.test(token) && year >= 1888 && year <= 2100;
}

/**
 * Splits a free-form search into the parts that can be handled by each
 * source. For example, "brad pitt 2022 comedy" becomes person="brad pitt",
 * year=2022, genres=["comedy"].
 */
export function parseMixedSearchQuery(searchTerm: string): MixedSearchQuery {
  const tokens = searchTerm.match(/"[^"]+"|\S+/g) ?? [];
  const normalizedTokens = tokens.map((token) =>
    normalizeToken(token.replace(/^"|"$/g, "")),
  );
  const personTokens: string[] = [];
  const genres: string[] = [];
  let year: number | null = null;

  for (let index = 0; index < normalizedTokens.length; index += 1) {
    const token = normalizedTokens[index];
    if (!token) continue;

    if (isSearchYear(token)) {
      year = Number(token);
      continue;
    }

    const phrase = `${token} ${normalizedTokens[index + 1] ?? ""}`.trim();
    if (MULTI_WORD_GENRES.has(phrase)) {
      genres.push(phrase);
      index += 1;
      continue;
    }

    if (SINGLE_WORD_GENRES.has(token)) {
      genres.push(token);
      continue;
    }

    personTokens.push(tokens[index].replace(/^"|"$/g, ""));
  }

  return {
    personQuery: personTokens.join(" ").trim(),
    year,
    genres: [...new Set(genres.map(canonicalCatalogGenre))],
  };
}

export function matchesMixedSearchFilters(
  match: CatalogTitleMatch,
  query: Pick<MixedSearchQuery, "year" | "genres">,
): boolean {
  if (query.year !== null) {
    const matchYear = catalogYear({ releaseDate: match.releaseDate ?? "" });
    if (
      (matchYear !== null && matchYear !== query.year) ||
      (matchYear === null && match.trailingYear !== query.year)
    ) {
      return false;
    }
  }

  if (query.genres.length === 0) {
    return true;
  }

  const matchGenres = catalogGenreValues({ genre: match.genre ?? "" }).map(
    canonicalCatalogGenre,
  );
  return query.genres.every((genre) => matchGenres.includes(genre));
}
