import { TmdbPersonSearchResult } from "./tmdb.types";

const PERSON_MATCH_MIN_SCORE = 0.72;

/**
 * Person names arrive from a free-form search box. Keep this normalization
 * deliberately separate from title normalization: names need token and
 * prefix matching, while provider titles need stricter catalog matching.
 */
export function normalizePersonSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function personTokens(value: string): string[] {
  const normalized = normalizePersonSearchText(value);
  return normalized ? normalized.split(" ") : [];
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      );
      diagonal = above;
    }
  }

  return previous[right.length];
}

function tokenMatchScore(queryToken: string, candidateToken: string): number {
  if (queryToken === candidateToken) {
    return 1;
  }

  // This is what makes "bruce" and "brad p" useful without requiring the
  // user to type the complete name.
  if (queryToken.length >= 2 && candidateToken.startsWith(queryToken)) {
    return 0.94;
  }

  const maxDistance = queryToken.length <= 4 ? 1 : 2;
  const distance = levenshteinDistance(queryToken, candidateToken);
  if (distance > maxDistance) {
    return 0;
  }

  return Math.max(0.72, 0.9 - distance / Math.max(queryToken.length, 1));
}

export interface RankedPersonSearchResult {
  result: TmdbPersonSearchResult;
  score: number;
}

/**
 * Ranks TMDB's person results against the user's original query. TMDB's
 * result order is useful, but not sufficient for partial names because a
 * query such as "bruce" can match many people.
 */
export function rankPersonSearchResults(
  results: readonly TmdbPersonSearchResult[],
  query: string,
): RankedPersonSearchResult[] {
  const queryTokens = personTokens(query);
  if (queryTokens.length === 0) {
    return [];
  }

  return results
    .map((result) => {
      const candidateTokens = personTokens(result.name ?? "");
      if (candidateTokens.length === 0 || queryTokens.length > candidateTokens.length) {
        return null;
      }

      const used = new Set<number>();
      const tokenScores: number[] = [];
      for (const queryToken of queryTokens) {
        let bestScore = 0;
        let bestIndex = -1;
        for (let index = 0; index < candidateTokens.length; index += 1) {
          if (used.has(index)) {
            continue;
          }
          const score = tokenMatchScore(queryToken, candidateTokens[index]);
          if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
          }
        }
        if (bestIndex < 0) {
          return null;
        }
        used.add(bestIndex);
        tokenScores.push(bestScore);
      }

      const actingBonus =
        result.known_for_department?.toLocaleLowerCase() === "acting"
          ? 0.03
          : 0;
      return {
        result,
        score: Math.min(1.05, tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length + actingBonus),
      };
    })
    .filter((item): item is RankedPersonSearchResult =>
      item !== null && item.score >= PERSON_MATCH_MIN_SCORE,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.result.popularity ?? 0) - (left.result.popularity ?? 0),
    );
}

// Conservative spelling pairs. They are only used after the original TMDB
// query returned no usable person, and the total retry count is bounded.
const COMMON_TYPO_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["b", "p"],
  ["d", "t"],
  ["g", "k"],
  ["f", "v"],
  ["s", "z"],
  ["m", "n"],
];

/**
 * Returns a small, bounded set of fallback queries for common one-letter
 * mistakes. The original query is always first and should be tried alone
 * before any fallback request is made.
 */
export function personSearchQueryVariants(query: string): string[] {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return [];
  }

  const tokens = normalized.split(" ");
  const variants = new Set<string>([normalized]);
  const addVariant = (tokenIndex: number, replacement: string, offset: number) => {
    const nextTokens = [...tokens];
    nextTokens[tokenIndex] =
      nextTokens[tokenIndex].slice(0, offset) +
      replacement +
      nextTokens[tokenIndex].slice(offset + 1);
    variants.add(nextTokens.join(" "));
  };

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex].toLocaleLowerCase();
    if (token.length < 3) {
      continue;
    }
    for (let offset = 0; offset < token.length; offset += 1) {
      const pair = COMMON_TYPO_PAIRS.find(
        ([left, right]) => token[offset] === left || token[offset] === right,
      );
      if (!pair) {
        continue;
      }
      addVariant(
        tokenIndex,
        token[offset] === pair[0] ? pair[1] : pair[0],
        offset,
      );
      if (variants.size >= 8) {
        return [...variants];
      }
    }
  }

  return [...variants];
}
