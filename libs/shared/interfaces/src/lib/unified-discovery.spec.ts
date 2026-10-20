import assert from "node:assert/strict";
import test from "node:test";
import {
  groupDiscoveryVersions,
  rankDiscoveryVersions,
} from "./unified-discovery";
import type { DiscoveryVersion } from "./unified-discovery";
const version = (
  id: string,
  extra: Partial<DiscoveryVersion> = {},
): DiscoveryVersion => ({
  identity: {
    sourceType: "xtream",
    playlistId: id,
    contentKind: "vod",
    providerItemId: "7",
  },
  providerName: id,
  categoryId: "1",
  originalTitle: "|FHD| The Matrix (1999)",
  contentType: "movie",
  work: { kind: "movie", title: "The Matrix", releaseYear: 1999 },
  navigation: ["/workspace/xtreams", id, "vod", "1", "7"],
  ...extra,
});
test("discovery groups exact known works and retains every original version and opaque target", () => {
  const a = version("a"),
    b = version("b", {
      identity: {
        sourceType: "stalker",
        playlistId: "b",
        contentKind: "vod",
        providerItemId: "0007-A",
      },
      navigation: ["/workspace/stalker", "b", "vod", "cat", "0007-A"],
    });
  const grouped = groupDiscoveryVersions([a, b, a]);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].versions, [a, b]);
  assert.equal(grouped[0].versions[1].navigation.at(-1), "0007-A");
});
test("conflicting IDs, ambiguous aliases, missing years, remakes, sequels and live sources remain distinct", () => {
  const a = version("a", {
    work: {
      kind: "movie",
      title: "The Matrix",
      releaseYear: 1999,
      trustedIds: { tmdb: "603" },
    },
  });
  const b = version("b", { work: { ...a.work!, trustedIds: { tmdb: "604" } } });
  assert.equal(groupDiscoveryVersions([version("title-only"), a, b]).length, 3);
  assert.equal(
    groupDiscoveryVersions([
      version("a", { work: undefined }),
      version("b", { work: undefined }),
    ]).length,
    2,
  );
  assert.equal(
    groupDiscoveryVersions([
      version("a"),
      version("b", {
        work: { kind: "movie", title: "The Matrix", releaseYear: 2026 },
      }),
    ]).length,
    2,
  );
  assert.equal(
    groupDiscoveryVersions([
      version("a"),
      version("b", {
        work: {
          kind: "movie",
          title: "The Matrix Reloaded",
          releaseYear: 2003,
        },
      }),
    ]).length,
    2,
  );
  assert.equal(
    groupDiscoveryVersions([
      version("a", { contentType: "live" }),
      version("b", { contentType: "live" }),
    ]).length,
    2,
  );
});
test("selection prefers confirmed ten-second success, then language, resolution, source order and stable identity", () => {
  const a = version("a", { languages: ["en"], resolution: 720 }),
    b = version("b", { languages: ["fr"], resolution: 2160 }),
    c = version("c", { languages: ["en"], resolution: 1080 });
  const key = (v: DiscoveryVersion) =>
    JSON.stringify([
      v.identity.sourceType,
      v.identity.playlistId,
      v.identity.contentKind,
      v.identity.providerItemId,
    ]);
  assert.equal(rankDiscoveryVersions([b, a, c], { language: "eng" })[0], c);
  assert.equal(
    rankDiscoveryVersions([b, a, c], {
      successfulAt: { [key(a)]: 123 },
      language: "fr",
    })[0],
    a,
  );
  assert.equal(
    rankDiscoveryVersions([a, c], {
      language: "en",
      sourceOrder: ["a", "c"],
    })[0],
    c,
  );
  assert.equal(
    rankDiscoveryVersions([version("b"), version("a")], {
      sourceOrder: ["b", "a"],
    })[0].providerName,
    "b",
  );
  assert.deepEqual(
    rankDiscoveryVersions([version("b"), version("a")], {}).map(
      (v) => v.providerName,
    ),
    ["a", "b"],
  );
});
