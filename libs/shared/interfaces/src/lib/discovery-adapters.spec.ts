import assert from "node:assert/strict";
import test from "node:test";
import {
  discoveryMediaHints,
  stalkerDiscoveryPage,
  xtreamDiscoveryVersion,
  readStalkerDiscoveryLiveSelection,
} from "./discovery-adapters";

test("explicit MULTI tags identify multiple languages without guessing individual tracks", () => {
  for (const title of [
    "|MULTI| Movie",
    "┃MULTI┃ Movie",
    "[MULTI] Movie",
    "Movie (MULTI)",
    "Movie (2026 MULTI)",
    "MULTI - Movie",
    "Movie MULTI",
    "Movie (2026 multi)",
  ]) {
    assert.deepEqual(discoveryMediaHints(title).languages, ["mul"], title);
  }
  for (const title of [
    "Multi Pass",
    "The Multiverse",
    "A Multi Pass Adventure",
  ]) {
    assert.equal(discoveryMediaHints(title).languages, undefined, title);
  }
  assert.deepEqual(discoveryMediaHints("EN - Movie").languages, ["en"]);
});

test("a MULTI category supplies a language fallback while explicit title languages win", () => {
  assert.deepEqual(
    discoveryMediaHints("Movie", "4K | MULTI MOVIES").languages,
    ["mul"],
  );
  assert.deepEqual(discoveryMediaHints("EN - Movie", "MULTI").languages, [
    "en",
  ]);
  assert.deepEqual(discoveryMediaHints("DE - Movie", "MULTI").languages, [
    "de",
  ]);
  assert.equal(discoveryMediaHints("Movie", "Multiverse").languages, undefined);
  const page = stalkerDiscoveryPage(
    { js: { data: [{ id: "1", name: "Movie", category_name: "MULTI" }] } },
    "portal",
    "Provider",
    { contentType: "movie", page: 1 },
  );
  assert.deepEqual(page.versions[0].languages, ["mul"]);
});
test("portal pages retain opaque identities, genuine years and explicit continuation without resolving links", () => {
  const page = stalkerDiscoveryPage(
    {
      js: {
        data: [
          {
            id: "0007-A",
            name: "|FHD| Matrix",
            year: "1999",
            category_id: "cat",
            cmd: "ffmpeg secret",
          },
        ],
        total_items: "50",
        max_page_items: "10",
      },
    },
    "portal",
    "Provider",
    { contentType: "movie", page: 1 },
  );
  assert.equal(page.versions[0].identity.providerItemId, "0007-A");
  assert.equal(page.versions[0].work?.releaseYear, 1999);
  assert.equal(page.versions[0].originalTitle, "|FHD| Matrix");
  assert.equal(page.versions[0].resolution, 1080);
  assert.equal(page.versions[0].languages, undefined);
  assert.deepEqual(page.continuation, { contentType: "movie", page: 2 });
  assert.equal("cmd" in page.versions[0], false);
  assert.throws(
    () =>
      stalkerDiscoveryPage(
        { js: { data: "malformed" } },
        "portal",
        "Provider",
        { contentType: "movie", page: 1 },
      ),
    /malformed/,
  );
  assert.throws(
    () =>
      stalkerDiscoveryPage(
        { js: { data: [{ name: "Missing ID" }] } },
        "portal",
        "Provider",
        { contentType: "movie", page: 1 },
      ),
    /identity/,
  );
  assert.equal(
    stalkerDiscoveryPage({ js: { data: [] } }, "portal", "Provider", {
      contentType: "movie",
      page: 2,
    }).continuation,
    undefined,
  );
});
test("cached Xtream variants keep original metadata and unknown labels stay unknown", () => {
  const row = {
    source_type: "xtream" as const,
    content_type: "movie" as const,
    type: "movie" as const,
    id: 42,
    xtream_id: 7,
    category_id: 3,
    title: "EN - Movie",
    rating: null,
    added: null,
    poster_url: null,
    playlist_id: "source",
    playlist_name: "Provider",
  };
  const version = xtreamDiscoveryVersion(row);
  assert.deepEqual(version.languages, ["en"]);
  assert.equal(version.resolution, undefined);
  assert.equal(version.work?.releaseYear, undefined);
  assert.equal(version.navigation.at(-1), "7");
  assert.equal(version.originalTitle, row.title);
  assert.deepEqual(
    xtreamDiscoveryVersion({ ...row, title: "Movie", category_name: "MULTI" })
      .languages,
    ["mul"],
  );
  assert.deepEqual(
    xtreamDiscoveryVersion({ ...row, category_name: "MULTI" }).languages,
    ["en"],
  );
});

test("display years follow catalogue title/date fallbacks without changing work identity", () => {
  const makeRow = (title: string, extra: Record<string, unknown> = {}) => ({
    source_type: "xtream" as const,
    content_type: "movie" as const,
    type: "movie" as const,
    id: 42,
    xtream_id: 7,
    category_id: 3,
    title,
    rating: null,
    added: null,
    poster_url: null,
    playlist_id: "source",
    playlist_name: "Provider",
    ...extra,
  });

  const leto = xtreamDiscoveryVersion(makeRow("|FR| Leto 2018"));
  const specialLady = xtreamDiscoveryVersion(
    makeRow("AR - A Special Lady- 2017"),
  );
  assert.equal(leto.displayYear, 2018);
  assert.equal(specialLady.displayYear, 2017);
  assert.equal(leto.work?.releaseYear, undefined);
  assert.equal(specialLady.work?.releaseYear, undefined);

  const nestedMetadata = xtreamDiscoveryVersion(
    makeRow("The Whale", { info: { first_air_date: "2022-09-02" } }),
  );
  assert.equal(nestedMetadata.displayYear, 2022);
  assert.equal(nestedMetadata.work?.releaseYear, undefined);

  const underscoredMetadata = xtreamDiscoveryVersion(
    makeRow("Another Movie", { release_date: "2019-12-01" }),
  );
  assert.equal(underscoredMetadata.displayYear, 2019);

  const conflictingTags = xtreamDiscoveryVersion(
    makeRow("Movie (1999) (2001)"),
  );
  assert.equal(conflictingTags.displayYear, undefined);
  const explicitMetadataWins = xtreamDiscoveryVersion(
    makeRow("Movie (1999) (2001)", { releaseDate: "2022-01-01" }),
  );
  assert.equal(explicitMetadataWins.displayYear, 2022);

  const invalidMetadata = xtreamDiscoveryVersion(
    makeRow("Movie (2024)", { releaseDate: "not a date" }),
  );
  assert.equal(invalidMetadata.displayYear, undefined);

  const nestedMovieTitle = xtreamDiscoveryVersion(
    makeRow("Movie", { movie_properties: { name: "1917" } }),
  );
  assert.equal(nestedMovieTitle.displayYear, undefined);

  const liveChannel = xtreamDiscoveryVersion({
    ...makeRow("Channel 2026"),
    type: "live",
    content_type: "live",
  });
  assert.equal(liveChannel.displayYear, undefined);

  const numericTitle = xtreamDiscoveryVersion(makeRow("2001: A Space Odyssey"));
  const numericTitleWithMetadata = xtreamDiscoveryVersion(
    makeRow("2001: A Space Odyssey", { releaseDate: "1968-04-03" }),
  );
  assert.equal(numericTitle.displayYear, undefined);
  assert.equal(numericTitleWithMetadata.displayYear, 1968);
});

test("portal display years read metadata aliases and title dates without fabricating work years", () => {
  const page = stalkerDiscoveryPage(
    {
      js: {
        data: [
          { id: "1", name: "Movie", releasedate: "2020-01-01" },
          { id: "2", name: "Series", info: { first_air_date: "2021-02-03" } },
          { id: "3", name: "Gönül Dağı 10.10.2026 ✅✅" },
          { id: "4", name: "1917" },
        ],
      },
    },
    "portal",
    "Provider",
    { contentType: "movie", page: 1 },
  );
  assert.deepEqual(
    page.versions.map((version) => version.displayYear),
    [2020, 2021, 2026, undefined],
  );
  assert.equal(page.versions[1].work?.releaseYear, undefined);

  const livePage = stalkerDiscoveryPage(
    { js: { data: [{ id: "live-1", name: "Channel 2026" }] } },
    "portal",
    "Provider",
    { contentType: "live", page: 1 },
  );
  assert.equal(livePage.versions[0].displayYear, undefined);
});

test("a selected live portal result keeps its source-owned navigation target without resolving other channels", () => {
  const page = stalkerDiscoveryPage(
    {
      js: {
        data: [
          {
            id: "0001-X",
            name: "Channel",
            cmd: "ffmpeg http://fixture.invalid/live",
          },
        ],
      },
    },
    "portal",
    "Provider",
    { contentType: "live", page: 1 },
  );
  const version = page.versions[0];
  assert.equal(
    readStalkerDiscoveryLiveSelection(version.navigationState, "other"),
    null,
  );
  assert.equal(
    readStalkerDiscoveryLiveSelection(version.navigationState, "portal")?.[
      "id"
    ],
    "0001-X",
  );
});
