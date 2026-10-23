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
test("a yearless variant joins the unique known-year title group without changing version order", () => {
  const unknown = version("unknown", {
      work: { kind: "movie", title: "The Matrix" },
      languages: ["fr"],
      resolution: 720,
    }),
    known = version("known", {
      work: { kind: "movie", title: "The Matrix", releaseYear: 1999 },
      languages: ["en"],
      resolution: 2160,
    });

  for (const input of [
    [unknown, known],
    [known, unknown],
  ]) {
    const grouped = groupDiscoveryVersions(input);
    assert.equal(grouped.length, 1);
    assert.deepEqual(grouped[0].versions, input);
  }
});
test("multiple yearless language variants join a unique known-year work in either identity order", () => {
  const yearlessWork = { kind: "movie" as const, title: "The Matrix" };
  const unknown = (id: string, language: string, resolution: number) =>
    version(id, {
      originalTitle: `${language.toUpperCase()}| The Matrix ${resolution}p`,
      work: yearlessWork,
      languages: [language],
      resolution,
    });
  const known = (id: string) =>
    version(id, {
      work: {
        kind: "movie",
        title: "The Matrix",
        releaseYear: 1999,
      },
    });
  const unknownA = unknown("a", "en", 1080);
  const unknownB = unknown("b", "fr", 2160);
  const knownFirst = known("a");
  const knownLast = known("z");

  for (const input of [
    [unknownA, unknownB, knownLast],
    [unknownB, unknown("c", "de", 720), knownFirst],
  ]) {
    const grouped = groupDiscoveryVersions(input);
    assert.equal(grouped.length, 1);
    assert.deepEqual(grouped[0].versions, input);
  }
});
test("same-title yearless versions stay separate when no release year is known", () => {
  const a = version("a", {
      work: { kind: "movie", title: "The Matrix" },
    }),
    b = version("b", {
      work: { kind: "movie", title: "The Matrix" },
    });

  assert.equal(groupDiscoveryVersions([a, b]).length, 2);
});
test("a yearless title stays separate when multiple known remake years are present", () => {
  const unknown = version("unknown", {
      work: { kind: "movie", title: "The Matrix" },
    }),
    original = version("original", {
      work: { kind: "movie", title: "The Matrix", releaseYear: 1999 },
    }),
    remake = version("remake", {
      work: { kind: "movie", title: "The Matrix", releaseYear: 2026 },
    });

  const grouped = groupDiscoveryVersions([unknown, original, remake]);
  assert.equal(grouped.length, 3);
  assert.deepEqual(
    grouped.map((group) => group.versions),
    [[unknown], [original], [remake]],
  );
});
test("a yearless title does not bridge conflicting trusted catalogue IDs", () => {
  const unknown = version("unknown", {
      work: {
        kind: "movie",
        title: "The Matrix",
        trustedIds: { tmdb: "604" },
      },
    }),
    known = version("known", {
      work: {
        kind: "movie",
        title: "The Matrix",
        releaseYear: 1999,
        trustedIds: { tmdb: "603" },
      },
    });

  const grouped = groupDiscoveryVersions([unknown, known]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(
    grouped.map((group) => group.versions),
    [[unknown], [known]],
  );
});
test("multiple yearless descriptors preserve conflicting trusted IDs alongside the known work", () => {
  const first = version("a", {
      work: {
        kind: "movie",
        title: "The Matrix",
        trustedIds: { tmdb: "603" },
      },
    }),
    second = version("b", {
      work: {
        kind: "movie",
        title: "The Matrix",
        trustedIds: { tmdb: "604" },
      },
    }),
    knownFirst = version("c", {
      work: {
        kind: "movie",
        title: "The Matrix",
        releaseYear: 1999,
        trustedIds: { tmdb: "603" },
      },
    });

  const grouped = groupDiscoveryVersions([first, second, knownFirst]);
  assert.equal(grouped.length, 2);
  assert.deepEqual(
    grouped.map((group) => group.versions),
    [[first, knownFirst], [second]],
  );
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
