import test from "node:test";
import assert from "node:assert/strict";
import { xtreamDiscoveryVersion } from "./discovery-adapters";
import { groupDiscoveryVersions } from "./unified-discovery";
import {
  discoveryDisplayYear,
  discoveryDisplayTitle,
  groupDiscoverySources,
} from "./discovery-presentation";

const row = (title: string, id = 1, releaseDate: string | null = null) => ({
  id,
  xtream_id: id,
  category_id: 1,
  title,
  releaseDate,
  type: "movie" as const,
  content_type: "movie" as const,
  source_type: "xtream" as const,
  playlist_id: "a",
  playlist_name: "Source A",
  poster_url: null,
  rating: null,
  added: null,
});

test("explicit release tags collapse language/quality copies while keeping their raw targets", () => {
  const rows = [
    "EN - The Matrix (1999)",
    "DE - The Matrix - 1999 4K",
    "|FHD| The Matrix (1999 MULTI)",
    "The Matrix (1999) [MULTI-SUB]",
  ].map((title, i) => xtreamDiscoveryVersion(row(title, i + 1)));
  assert.deepEqual(
    rows.map((v) => v.work?.releaseYear),
    [1999, 1999, 1999, 1999],
  );
  assert.equal(groupDiscoveryVersions(rows).length, 1);
  assert.equal(groupDiscoveryVersions(rows)[0].versions.length, 4);
  assert.equal(rows[1].navigation.at(-1), "2");
  assert.equal(rows[1].originalTitle, "DE - The Matrix - 1999 4K");
});
test("numeric titles, conflicting tags, structured dates, remakes and trusted conflicts remain safe", () => {
  for (const title of [
    "1917",
    "2001: A Space Odyssey",
    "Blade Runner 2049",
    "The Matrix 1999",
    "Movie (1999) (2001)",
  ])
    assert.equal(
      xtreamDiscoveryVersion(row(title)).work?.releaseYear,
      undefined,
      title,
    );
  assert.equal(
    xtreamDiscoveryVersion(row("The Matrix (1999)", 1, "2026-01-01")).work
      ?.releaseYear,
    2026,
  );
  const a = xtreamDiscoveryVersion(row("Movie (1999)", 1)),
    b = xtreamDiscoveryVersion(row("Movie (2026)", 2));
  assert.equal(groupDiscoveryVersions([a, b]).length, 2);
  b.work = { ...a.work!, trustedIds: { tmdb: "2" } };
  a.work = { ...a.work!, trustedIds: { tmdb: "1" } };
  assert.equal(groupDiscoveryVersions([a, b]).length, 2);
});
test("display titles preserve names and story numbers while hiding known provider tags", () => {
  assert.equal(
    discoveryDisplayTitle(
      xtreamDiscoveryVersion(row("EN - The Matrix (1999) 4K")),
    ),
    "The Matrix",
  );
  assert.equal(
    discoveryDisplayTitle(
      xtreamDiscoveryVersion(row("DE| Blade Runner 2049 (2017)")),
    ),
    "Blade Runner 2049",
  );
  assert.equal(
    discoveryDisplayTitle(
      xtreamDiscoveryVersion(row("IT - It: Chapter Two (2019)")),
    ),
    "It: Chapter Two",
  );
  assert.equal(
    discoveryDisplayTitle(xtreamDiscoveryVersion(row("Rocky II (1979)"))),
    "Rocky II",
  );
  assert.equal(
    discoveryDisplayTitle(xtreamDiscoveryVersion(row("Making It (2020)"))),
    "Making It",
  );
});

test("catalogue-only display years do not become work identity years", () => {
  const version = xtreamDiscoveryVersion(row("|FR| Leto 2018"));
  assert.equal(version.work?.releaseYear, undefined);
  assert.equal(discoveryDisplayYear(version), 2018);
  assert.equal(discoveryDisplayTitle(version), "Leto 2018");

  const numeric = xtreamDiscoveryVersion(row("2001: A Space Odyssey"));
  assert.equal(discoveryDisplayYear(numeric), undefined);
  assert.equal(discoveryDisplayTitle(numeric), "2001: A Space Odyssey");
  assert.equal(
    discoveryDisplayTitle(xtreamDiscoveryVersion(row("Blade Runner 2049"))),
    "Blade Runner 2049",
  );
});
test("provider grouping retains all quality choices and sources with identical display names", () => {
  const a = xtreamDiscoveryVersion(row("Movie (2026)", 1)),
    b = xtreamDiscoveryVersion(row("Movie (2026) 4K", 2));
  const c = {
    ...a,
    identity: {
      ...a.identity,
      sourceType: "stalker" as const,
      playlistId: "b",
      providerItemId: "0007-A",
    },
  };
  const groups = groupDiscoverySources([a, b, c, a]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].versions, [a, b]);
  assert.equal(groups[1].versions[0].identity.providerItemId, "0007-A");
});

test("explicit trailing quality tags are available to Auto and source choices", () => {
  assert.equal(xtreamDiscoveryVersion(row("Movie (2026) 4k")).resolution, 2160);
  assert.equal(
    xtreamDiscoveryVersion(row("Movie - 2026 FHD")).resolution,
    1080,
  );
  assert.equal(
    xtreamDiscoveryVersion(row("Movie without quality (2026)")).resolution,
    undefined,
  );
});

test("portal bar tags and malformed release tags do not create duplicate or unsafe works", () => {
  const a = xtreamDiscoveryVersion({
    ...row("IT ▎ Matchbox Adventures"),
    type: "series",
    content_type: "series",
    releaseDate: "2021-09-22",
  });
  const b = xtreamDiscoveryVersion({
    ...row("IT| Matchbox Adventures", 2),
    type: "series",
    content_type: "series",
    releaseDate: "2021-09-22",
  });
  assert.equal(groupDiscoveryVersions([a, b]).length, 1);
  assert.equal(discoveryDisplayTitle(a), "Matchbox Adventures");
  assert.deepEqual(a.languages, ["it"]);
  assert.equal(
    xtreamDiscoveryVersion(row("Movie (1999]")).work?.releaseYear,
    undefined,
  );
});
