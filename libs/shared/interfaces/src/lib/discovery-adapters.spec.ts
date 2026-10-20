import assert from "node:assert/strict";
import test from "node:test";
import {
  stalkerDiscoveryPage,
  xtreamDiscoveryVersion,
  readStalkerDiscoveryLiveSelection,
} from "./discovery-adapters";
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
