import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStructuredSearchFields,
  filterBroadCatalogResults,
  normalizeYearSearchValue,
  rankBroadCatalogResults,
  structuredSearchYearOptions,
} from "./structured-search.util";

test("normalizes numeric year input emitted by a number control", () => {
  assert.equal(normalizeYearSearchValue(2022), "2022");
  assert.equal(buildStructuredSearchFields({ year: 2022 }).year, 2022);
});

test("clears an empty year while the user is editing", () => {
  assert.equal(normalizeYearSearchValue(null), "");
  assert.equal(buildStructuredSearchFields({ year: null }).year, null);
});

test("builds descending year options through the current year", () => {
  assert.deepEqual(structuredSearchYearOptions(2024).slice(0, 3), [2024, 2023, 2022]);
  assert.equal(structuredSearchYearOptions(2024).at(-1), 1888);
});

function result(title: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_type: "xtream" as const,
    content_type: "movie" as const,
    id: title,
    category_id: 1,
    title,
    rating: null,
    added: null,
    poster_url: null,
    xtream_id: 1,
    type: "movie" as const,
    playlist_id: "playlist",
    playlist_name: "Remote source",
    ...overrides,
  };
}

test("keeps broad title matches and ranks canonical variants first", () => {
  const ranked = rankBroadCatalogResults(
    [
      result("Bullet Train Explosion (2025)"),
      result("Bullet Train (2022) 4K"),
      result("Bullet Train Down (2022)"),
    ],
    ["Bullet Train"],
  );

  assert.deepEqual(
    ranked.map((item) => item.title),
    [
      "Bullet Train (2022) 4K",
      "Bullet Train Explosion (2025)",
      "Bullet Train Down (2022)",
    ],
  );
});

test("filters only known contradictions and keeps unknown metadata", () => {
  const filtered = filterBroadCatalogResults(
    [
      result("Bullet Train (2022)", { releaseDate: "2022-08-03", genre: "Comedy" }),
      result("Bullet Train Explosion (2025)", { releaseDate: "2025-04-23", genre: "Action" }),
      result("Bullet Train 4K"),
    ],
    { year: 2022, genres: ["comedy"] },
  );

  assert.deepEqual(
    filtered.map((item) => item.title),
    ["Bullet Train (2022)", "Bullet Train 4K"],
  );
});
