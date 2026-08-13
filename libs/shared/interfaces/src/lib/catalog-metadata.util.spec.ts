import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogYear,
  collectCatalogGenres,
  hasCompleteXtreamSearchMetadata,
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
