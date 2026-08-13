import assert from "node:assert/strict";
import test from "node:test";
import {
  matchesMixedSearchFilters,
  parseMixedSearchQuery,
} from "./mixed-search.util";

test("splits a person, year, and genre from a free-form query", () => {
  assert.deepEqual(parseMixedSearchQuery("brad pitt 2022 comedy"), {
    personQuery: "brad pitt",
    year: 2022,
    genres: ["comedy"],
  });
});

test("keeps person names that overlap with ordinary search words", () => {
  assert.deepEqual(parseMixedSearchQuery("john comedy 2022"), {
    personQuery: "john",
    year: 2022,
    genres: ["comedy"],
  });
});

test("matches Bullet Train catalog fields for the target query", () => {
  const query = parseMixedSearchQuery("brad pitt 2022 comedy");
  assert.equal(
    matchesMixedSearchFilters(
      {
        queryTitle: "Bullet Train",
        playlistId: "playlist",
        playlistName: "Remote source",
        categoryId: 1,
        xtreamId: 123,
        type: "movie",
        genre: "Action, Komödie, Thriller",
        releaseDate: "2022-08-05",
        trailingYear: null,
      },
      query,
    ),
    true,
  );
});

test("rejects a title with the wrong year or genre", () => {
  const query = parseMixedSearchQuery("brad pitt 2022 comedy");
  const baseMatch = {
    queryTitle: "Bullet Train",
    playlistId: "playlist",
    playlistName: "Remote source",
    categoryId: 1,
    xtreamId: 123,
    type: "movie" as const,
    trailingYear: null,
  };
  assert.equal(
    matchesMixedSearchFilters(
      { ...baseMatch, genre: "Action, Thriller", releaseDate: "2022-08-05" },
      query,
    ),
    false,
  );
  assert.equal(
    matchesMixedSearchFilters(
      { ...baseMatch, genre: "Action, Comedy", releaseDate: "2021-08-05" },
      query,
    ),
    false,
  );
});
