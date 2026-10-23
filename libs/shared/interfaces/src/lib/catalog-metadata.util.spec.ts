import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogYear,
  collectCatalogGenres,
  hasCompleteXtreamSearchMetadata,
  normalizeXtreamContentMetadata,
} from "./catalog-metadata.util";

test("prefers release metadata over a year embedded in the title", () => {
  assert.equal(
    catalogYear({
      title: "|EN| 2073",
      releaseDate: "2024-12-27",
    }),
    2024,
  );
});

test("uses an explicit year when release metadata is absent", () => {
  assert.equal(catalogYear({ title: "Untitled", year: "2023" }), 2023);
});

test("uses a plausible title year only as a final fallback", () => {
  assert.equal(catalogYear({ title: "Movie 2024" }), 2024);
  assert.equal(catalogYear({ title: "|EN| 2073" }), null);
});

test("allows an optional fallback title while preserving metadata precedence", () => {
  assert.equal(catalogYear({ title: "Movie 2024" }, undefined), 2024);
  assert.equal(catalogYear({ title: "Movie 2024" }, null), null);
  assert.equal(catalogYear({ title: "Movie", releaseDate: "2022-01-01" }, null), 2022);
  assert.equal(
    catalogYear({ movie_properties: { name: "1917" } }, null),
    null,
  );
  assert.equal(
    catalogYear({ movie_properties: { name: "Movie 2024" } }, undefined),
    2024,
  );
});

test("deduplicates case and known spelling variants in genre options", () => {
  assert.deepEqual(
    collectCatalogGenres([
      { genre: "ADVENTURE" },
      { genre: "Adventure" },
      { genre: "ADVENTEUR" },
      { genre: "COMEDIE" },
      { genre: "COMIDIE" },
      { genre: "Komödie" },
      { genre: "Comedy" },
    ]),
    ["Adventure", "Comedy"],
  );
});

test("recognizes complete metadata already supplied by the bulk catalog", () => {
  assert.equal(
    hasCompleteXtreamSearchMetadata({
      genre: "Action, Comedy",
      releasedate: "2022-08-05",
      director: "David Leitch",
      cast: "Brad Pitt",
      plot: "A story",
    }),
    true,
  );
});

test("does not require a detail request to search fields already present", () => {
  assert.equal(
    hasCompleteXtreamSearchMetadata({
      genre: "Comedy",
      releasedate: "2022-08-05",
      director: "Director",
      cast: "Actor",
    }),
    false,
  );
});

test("reads genre from provider-supplied nested bulk metadata", () => {
  assert.equal(
    normalizeXtreamContentMetadata({
      name: "A movie",
      movie_properties: { genre: "Action, Thriller" },
    }).genre,
    "Action, Thriller",
  );
});

test("decodes a provider-supplied JSON genre array", () => {
  assert.deepEqual(
    collectCatalogGenres([{ genre: '["Action", "Drama"]' }]),
    ["Action", "Drama"],
  );
});

test("keeps provider categories separate from genres", () => {
  assert.deepEqual(
    collectCatalogGenres([{ category_name: "Action Movies" }]),
    [],
  );
});
