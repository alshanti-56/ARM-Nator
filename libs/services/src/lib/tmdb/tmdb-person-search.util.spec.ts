import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePersonSearchText,
  personSearchQueryVariants,
  rankPersonSearchResults,
} from "./tmdb-person-search.util";

test("normalizes accents and punctuation in person names", () => {
  assert.equal(normalizePersonSearchText("  Béla-Lugosi  "), "bela lugosi");
});
test("ranks a partial first name as a usable person match", () => {
  const ranked = rankPersonSearchResults(
    [
      { id: 1, name: "Bruce Willis", known_for_department: "Acting" },
      { id: 2, name: "Christopher Walken", known_for_department: "Acting" },
    ],
    "bruce",
  );

  assert.equal(ranked[0]?.result.name, "Bruce Willis");
});

test("ranks a one-letter typo against the original query", () => {
  const ranked = rankPersonSearchResults(
    [{ id: 1, name: "Brad Pitt", known_for_department: "Acting" }],
    "prad",
  );

  assert.equal(ranked[0]?.result.name, "Brad Pitt");
});

test("generates a bounded Brad fallback for the typo prad", () => {
  const variants = personSearchQueryVariants("prad");

  assert.equal(variants[0], "prad");
  assert.ok(variants.includes("brad"));
  assert.ok(variants.length <= 8);
});

test("does not rank unrelated people", () => {
  assert.deepEqual(
    rankPersonSearchResults(
      [{ id: 1, name: "Tom Hanks", known_for_department: "Acting" }],
      "bruce",
    ),
    [],
  );
});
