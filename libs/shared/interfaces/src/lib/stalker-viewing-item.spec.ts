import assert from "node:assert/strict";
import test from "node:test";
import {
  stalkerViewingItem,
  optionalStalkerViewingItem,
} from "./stalker-viewing-item";

test("Stalker preserves opaque IDs and identifies a series only from explicit parent metadata", () => {
  const movie = stalkerViewingItem("portal", {
    id: "0007-A",
    name: "Movie",
    year: 2020,
    category_id: "movies",
  });
  assert.equal(movie.identity.providerItemId, "0007-A");
  assert.equal(movie.activity?.providerItemId, "0007-A");
  const episode = stalkerViewingItem(
    "portal",
    {
      id: "episode:1",
      name: "Episode",
      series_id: "series-X",
      series_title: "Series",
      series_year: 2019,
      season_number: 2,
    },
    { episodeNumber: 3, seasonNumber: 2 },
  );
  assert.equal(episode.seriesIdentity?.providerItemId, "series-X");
  assert.equal(episode.work.series?.title, "Series");
  assert.equal(episode.work.series?.releaseYear, 2019);
  assert.equal(episode.activity?.providerItemId, "series-X");
  assert.equal(episode.work.seasonNumber, 2);
  const unknown = stalkerViewingItem(
    "portal",
    { id: "episode:1", name: "Episode" },
    { episodeNumber: 3 },
  );
  assert.equal(unknown.seriesIdentity, undefined);
  assert.equal(unknown.work.series, undefined);
  assert.equal(unknown.activity, undefined);
  assert.throws(
    () => stalkerViewingItem("portal", { name: "Missing ID" }),
    /identity/,
  );
});

test("command-only portal playback does not invent a history identity", () => {
  assert.equal(
    optionalStalkerViewingItem("portal", {
      cmd: "ffmpeg http://fixture/movie",
    }),
    null,
  );
  assert.equal(
    optionalStalkerViewingItem("portal", { stream_id: "opaque" })?.identity
      .providerItemId,
    "opaque",
  );
});
