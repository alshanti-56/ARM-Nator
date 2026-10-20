import assert from "node:assert/strict";
import test from "node:test";
import {
  matchingPlaybackVersions,
  playbackDiscoveryVersion,
} from "./playback-versions";
import type { DiscoveryVersion } from "./unified-discovery";
const current = playbackDiscoveryVersion({
  title: "Movie (2020)",
  streamUrl: "fixture",
  itemIdentity: {
    sourceType: "xtream",
    playlistId: "a",
    contentKind: "vod",
    providerItemId: "7",
  },
})!;
const alternative = (id: string, year = 2020): DiscoveryVersion => ({
  ...current,
  identity: { ...current.identity, playlistId: id },
  work: { kind: "movie", title: "Movie", releaseYear: year },
});
test("history/category playback has a seed independent of a search selection", () =>
  assert.equal(current.work?.releaseYear, 2020));
test("keeps same work but rejects remakes, missing years and conflicting IDs", () => {
  const trusted = {
    ...current,
    work: { ...current.work!, trustedIds: { tmdb: "1" } },
  };
  const rows = matchingPlaybackVersions(trusted, [
    alternative("b"),
    alternative("remake", 1990),
    { ...alternative("unknown"), work: { kind: "movie", title: "Movie" } },
    {
      ...alternative("conflict"),
      work: { ...current.work!, trustedIds: { tmdb: "2" } },
    },
  ]);
  assert.deepEqual(
    new Set(rows.map((v) => v.identity.playlistId)),
    new Set(["a", "b"]),
  );
});
test("opaque episode identities resolve their series without inferring episode matches", () => {
  const series = {
    sourceType: "stalker" as const,
    playlistId: "p",
    contentKind: "series" as const,
    providerItemId: "001:show",
  };
  const seed = playbackDiscoveryVersion({
    title: "Episode 1",
    streamUrl: "fixture",
    itemIdentity: {
      ...series,
      contentKind: "episode",
      providerItemId: "001:e1",
    },
    seriesIdentity: series,
    work: {
      kind: "episode",
      title: "Episode 1",
      series: { kind: "series", title: "Show", releaseYear: 2020 },
      seasonNumber: 1,
      episodeNumber: 1,
    },
  })!;
  assert.deepEqual(seed.identity, series);
  assert.equal(seed.work?.title, "Show");
});
test("direct streams and live channels do not acquire movie alternatives", () => {
  assert.equal(
    playbackDiscoveryVersion({ streamUrl: "fixture", title: "Direct" }),
    null,
  );
  assert.equal(
    playbackDiscoveryVersion({
      streamUrl: "fixture",
      title: "Live",
      isLive: true,
      itemIdentity: current.identity,
    }),
    null,
  );
});
