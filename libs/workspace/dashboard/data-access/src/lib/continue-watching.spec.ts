import assert from "node:assert/strict";
import test from "node:test";
import {
  groupContinueWatching,
  recentViewingEntry,
  recentVersionLabel,
} from "./continue-watching";
import type {
  PortalRecentItem,
  ViewingHistoryEntry,
  PlaybackPositionData,
} from "@arm-nator/shared/interfaces";
const item = (id: string, playlist = id, extra = {}): PortalRecentItem => ({
  id,
  xtream_id: id,
  playlist_id: playlist,
  category_id: 1,
  type: "movie",
  source: "xtream",
  title: "The Matrix",
  viewed_at: "2026-01-01",
  ...extra,
});
const work = { kind: "movie" as const, title: "The Matrix", releaseYear: 1999 };
const position = (seconds = 20, confirmedAt = 100): PlaybackPositionData => ({
  contentXtreamId: 7,
  contentType: "vod",
  positionSeconds: seconds,
  durationSeconds: 100,
  confirmedAt,
});

test("Continue Watching groups known works, retains versions and uses latest confirmed state", () => {
  const a = item("7", "one", { work }),
    b = item("8", "two", {
      work: { ...work, title: "|FHD| The Matrix (1999)" },
    });
  const positions = new Map([
    [a, position(20, 100)],
    [b, position(60, 200)],
  ]);
  const groups = groupContinueWatching(
    [a, b, a],
    (value) => positions.get(value) ?? null,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary, b);
  assert.deepEqual(groups[0].versions, [b, a]);
  positions.set(b, { ...position(0, 300), action: "finished" });
  assert.deepEqual(
    groupContinueWatching([a, b], (value) => positions.get(value) ?? null),
    [],
  );
});

test("missing years, remakes, conflicting IDs and ambiguous title matches stay separate", () => {
  const a = item("a", "a", { work: { ...work, trustedIds: { tmdb: "603" } } });
  const b = item("b", "b", { work: { ...work, trustedIds: { tmdb: "604" } } });
  const unknown = item("u", "u", { work });
  assert.equal(
    groupContinueWatching([unknown, a, b], () => position()).length,
    3,
  );
  assert.equal(
    groupContinueWatching([item("x"), item("y")], () => position()).length,
    2,
  );
  assert.equal(
    groupContinueWatching(
      [a, item("r", "r", { work: { ...work, releaseYear: 2026 } })],
      () => position(),
    ).length,
    2,
  );
});

test("opaque provider IDs and exact episode identities select only their own neutral history", () => {
  const row: ViewingHistoryEntry = {
    item: {
      identity: {
        sourceType: "stalker",
        playlistId: "portal",
        contentKind: "vod",
        providerItemId: "0007-A",
      },
      work,
    },
    workId: "matrix",
    sharedAllowed: true,
    raw: {
      ...position(30),
      durationSeconds: 100,
      action: "progress",
      finished: false,
    },
    resume: null,
  };
  assert.equal(
    recentViewingEntry(item("0007-A", "portal", { source: "stalker" }), [row]),
    row,
  );
  assert.equal(
    recentViewingEntry(item("7", "portal", { source: "stalker" }), [row]),
    null,
  );
});

test("version labels preserve source name and original tagged title", () => {
  assert.equal(
    recentVersionLabel(
      item("7", "one", {
        playlist_name: "Provider One",
        title: "|FHD| The Matrix (1999)",
      }),
    ),
    "Provider One · |FHD| The Matrix (1999)",
  );
  assert.notEqual(
    recentVersionLabel(item("7", "one")),
    recentVersionLabel(item("7", "two")),
  );
});

test("an incompatible longer cut retains its own unfinished position after another cut completes", () => {
  const a = item("7", "one", { work }),
    b = item("8", "two", { work });
  const positions = new Map([
    [a, { ...position(95, 200), durationSeconds: 100 }],
    [b, { ...position(50, 100), durationSeconds: 200 }],
  ]);
  const groups = groupContinueWatching(
    [a, b],
    (value) => positions.get(value) ?? null,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary, b);
  assert.equal(groups[0].position.positionSeconds, 50);
  positions.set(b, { ...position(50, 100), durationSeconds: 110 });
  assert.deepEqual(
    groupContinueWatching([a, b], (value) => positions.get(value) ?? null),
    [],
  );
});

test("opening an unplayed version cannot supersede confirmed completion of the work", () => {
  const a = item("7", "one", { work }),
    b = item("8", "two", { work }),
    unopened = item("9", "three", { work, viewed_at: "2030-01-01" });
  assert.deepEqual(
    groupContinueWatching([unopened, a, b], (value) =>
      value === unopened
        ? null
        : position(value === a ? 95 : 40, value === a ? 200 : 100),
    ),
    [],
  );
});

test("series versions group by known parent without transferring different episode clocks", () => {
  const parent = {
    kind: "series" as const,
    title: "Series",
    releaseYear: 2020,
  };
  const first = item("parent-A", "one", { type: "series" });
  const second = item("parent-B", "two", { type: "series" });
  const history: ViewingHistoryEntry[] = [first, second].map(
    (value, index) => ({
      item: {
        identity: {
          sourceType: "xtream",
          playlistId: value.playlist_id,
          contentKind: "episode",
          providerItemId: `episode-${index}`,
        },
        seriesIdentity: {
          sourceType: "xtream",
          playlistId: value.playlist_id,
          contentKind: "series",
          providerItemId: value.xtream_id as string,
        },
        work: {
          kind: "episode",
          title: `Episode ${index + 1}`,
          series: parent,
          seasonNumber: 1,
          episodeNumber: index + 1,
        },
      },
      workId: `work-episode-${index}`,
      sharedAllowed: true,
      raw: {
        positionSeconds: 20 + index * 10,
        durationSeconds: 100,
        confirmedAt: 100 + index,
        action: "progress",
        finished: false,
      },
      resume: null,
    }),
  );
  const groups = groupContinueWatching([first, second], () => null, history);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].primary, second);
  assert.equal(groups[0].position.positionSeconds, 30);
});
