import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContentSearchFtsMatchQuery,
  normalizeSearchMatchText,
  scoreSearchTextMatch,
  shouldUseContentSearchFts,
} from "./content-search.util";

test("normalizes mixed-case and accented search text", () => {
  assert.equal(normalizeSearchMatchText(" Amélie 2025 "), "amelie 2025");
});

test("builds an order-independent search query for year and genre terms", () => {
  assert.equal(
    buildContentSearchFtsMatchQuery("2025 comedy"),
    '"2025" AND "comedy"',
  );
  assert.equal(
    buildContentSearchFtsMatchQuery("comedy 2025"),
    '"comedy" AND "2025"',
  );
});

test("keeps all meaningful words in a mixed catalog search", () => {
  assert.equal(
    buildContentSearchFtsMatchQuery("inception 2025 comedy"),
    '"inception" AND "2025" AND "comedy"',
  );
  assert.equal(shouldUseContentSearchFts("inception 2025 comedy"), true);
});

test("uses the fallback path when a query contains only short tokens", () => {
  assert.equal(shouldUseContentSearchFts("a b"), false);
});

test("requires every meaningful term when optional catalog fields are missing", () => {
  assert.equal(scoreSearchTextMatch("Comedy", "2025 comedy"), null);
});
