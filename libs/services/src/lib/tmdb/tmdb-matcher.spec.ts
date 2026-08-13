import assert from "node:assert/strict";
import test from "node:test";
import { pickConfidentMatch } from "./tmdb-matcher";

test("resolves an ambiguous title without a year by popularity", () => {
  const result = pickConfidentMatch(
    [
      {
        id: 1,
        title: "Lucy",
        release_date: "2006-01-01",
        vote_count: 50,
        popularity: 2,
      },
      {
        id: 2,
        title: "Lucy",
        release_date: "2014-07-25",
        vote_count: 5000,
        popularity: 80,
      },
    ],
    { title: "Lucy", year: null },
    "movie",
  );

  assert.equal(result?.id, 2);
});

test("still uses the selected year before popularity", () => {
  const result = pickConfidentMatch(
    [
      { id: 1, title: "Lucy", release_date: "2006-01-01", vote_count: 5000 },
      { id: 2, title: "Lucy", release_date: "2014-07-25", vote_count: 50 },
    ],
    { title: "Lucy", year: 2014 },
    "movie",
  );

  assert.equal(result?.id, 2);
});
