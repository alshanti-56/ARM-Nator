import { eq } from "drizzle-orm";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeDatabase,
  initDatabase,
} from "../../libs/database/src/lib/connection";
import { savePlaybackPosition, clearPlaybackPosition, clearAllPlaybackPositions } from "../../apps/electron-backend/src/app/database/operations/playback-position.operations";
import * as schema from "../../libs/database/src/lib/schema";
import {
  getViewingHistory,
  reconcileViewingHistoryItem,
  reconcileViewingItem,
  saveConfirmedViewingState,
  readViewingResume,
  saveViewingItemProgress,
  saveViewingTitlePreferences,
  getViewingTitlePreferences,
} from "../../apps/electron-backend/src/app/database/operations/viewing-state.operations";
import type {
  CatalogueItemIdentity,
  WorkDescriptor,
} from "../../libs/shared/interfaces/src/lib/viewing-continuity";

const identity = (
  id: string,
  sourceType: "xtream" | "stalker" = "xtream",
): CatalogueItemIdentity => ({
  sourceType,
  playlistId: "one",
  contentKind: "vod",
  providerItemId: id,
});
const matrix: WorkDescriptor = {
  kind: "movie",
  title: "|FHD| The Matrix (1999)",
  releaseYear: 1999,
};
async function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "arm-nator-continuity-"));
  process.env.ARM_NATOR_E2E_DATA_DIR = root;
  const db = await initDatabase();
  t.after(() => {
    closeDatabase();
    rmSync(root, { recursive: true, force: true });
  });
  db.insert(schema.playlists)
    .values({ id: "one", name: "One", type: "xtream" })
    .run();
  db.insert(schema.playbackPositions)
    .values({
      playlistId: "one",
      contentXtreamId: 7,
      contentType: "vod",
      positionSeconds: 94.9,
      durationSeconds: 100,
    })
    .run();
  return db;
}

test("additive migration survives reopen and leaves existing positions intact", async (t) => {
  let db = await fixture(t);
  const alias = reconcileViewingItem(db, identity("0007-A", "stalker"), matrix);
  closeDatabase();
  db = await initDatabase();
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.positionSeconds,
    94.9,
  );
  assert.equal(
    reconcileViewingItem(db, identity("0007-A", "stalker"), matrix).workId,
    alias.workId,
  );
});

test("latest confirmed progress transfers fraction only between compatible actual durations", async (t) => {
  const db = await fixture(t);
  const a = identity("a"),
    b = identity("b", "stalker");
  assert.equal(
    reconcileViewingItem(db, a, matrix).workId,
    reconcileViewingItem(db, b, { ...matrix, title: "EN - The Matrix (1999)" })
      .workId,
  );
  saveConfirmedViewingState(db, {
    identity: b,
    positionSeconds: 50,
    durationSeconds: 1200,
    confirmedAt: 100,
  });
  saveConfirmedViewingState(db, {
    identity: a,
    positionSeconds: 600,
    durationSeconds: 1200,
    confirmedAt: 200,
  });
  assert.equal(readViewingResume(db, b, 1230)?.positionSeconds, 615);
  assert.equal(readViewingResume(db, b, 1300)?.positionSeconds, 50);
  assert.equal(readViewingResume(db, b)?.positionSeconds, 50);
  assert.equal(
    db
      .select()
      .from(schema.versionViewingState)
      .all()
      .find((row) => row.identityKey.includes('"b"'))?.positionSeconds,
    50,
  );
  saveConfirmedViewingState(db, {
    identity: a,
    positionSeconds: 20,
    durationSeconds: 1200,
    confirmedAt: 150,
  });
  assert.equal(readViewingResume(db, b, 1230)?.positionSeconds, 615);
});

test("conflicting metadata detaches aliases without inheriting shared progress", async (t) => {
  const db = await fixture(t);
  const a = identity("a"),
    b = identity("b"),
    c = identity("c");
  const first = { ...matrix, trustedIds: { tmdb: "603" } };
  const second = { ...matrix, trustedIds: { tmdb: "604" } };
  const one = reconcileViewingItem(db, a, first),
    two = reconcileViewingItem(db, b, second);
  assert.notEqual(one.workId, two.workId);
  assert.notEqual(
    reconcileViewingItem(db, c, matrix).workId,
    one.workId,
    "ambiguous title cannot bridge conflicting IDs",
  );
  saveConfirmedViewingState(db, {
    identity: b,
    positionSeconds: 700,
    durationSeconds: 1200,
    confirmedAt: 200,
  });
  reconcileViewingItem(db, a, second);
  assert.equal(readViewingResume(db, a, 1200), null);
});

test("explicit finish and reset override older progress but preserve other version history", async (t) => {
  const db = await fixture(t);
  const a = identity("a"),
    b = identity("b");
  reconcileViewingItem(db, a, matrix);
  reconcileViewingItem(db, b, matrix);
  saveConfirmedViewingState(db, {
    identity: b,
    positionSeconds: 500,
    durationSeconds: 1200,
    confirmedAt: 100,
  });
  saveConfirmedViewingState(db, {
    identity: a,
    positionSeconds: 0,
    confirmedAt: 200,
    action: "finished",
  });
  assert.equal(readViewingResume(db, b, 1200)?.finished, true);
  saveConfirmedViewingState(db, {
    identity: a,
    positionSeconds: 0,
    confirmedAt: 300,
    action: "reset",
  });
  assert.equal(readViewingResume(db, b, 1200)?.positionSeconds, 0);
  assert.equal(readViewingResume(db, b, 1200)?.finished, false);
  assert.equal(
    db
      .select()
      .from(schema.versionViewingState)
      .all()
      .find((row) => row.identityKey.includes('"b"'))?.positionSeconds,
    500,
  );
  saveConfirmedViewingState(db, {
    identity: b,
    positionSeconds: 1100,
    durationSeconds: 1200,
    confirmedAt: 250,
  });
  assert.equal(readViewingResume(db, b, 1200)?.positionSeconds, 0);
});

test("legacy-compatible raw positions retain fractional clocks and reject older confirmed writes", async (t) => {
  const db = await fixture(t);
  await savePlaybackPosition(db, "one", {
    contentXtreamId: 7,
    contentType: "vod",
    positionSeconds: 94.9,
    durationSeconds: 100.1,
    confirmedAt: 200,
  });
  await savePlaybackPosition(db, "one", {
    contentXtreamId: 7,
    contentType: "vod",
    positionSeconds: 20,
    durationSeconds: 100.1,
    confirmedAt: 100,
  });
  const row = db.select().from(schema.playbackPositions).get();
  assert.equal(row?.positionSeconds, 94.9);
  assert.equal(row?.durationSeconds, 100.1);
  assert.equal(row?.confirmedAt, 200);
});

test("typed viewing operation commits neutral and compatibility clocks together", async (t) => {
  const db = await fixture(t);
  const item = {
    identity: identity("7"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 7,
      contentType: "vod" as const,
    },
  };
  saveViewingItemProgress(db, {
    item,
    positionSeconds: 94.9,
    durationSeconds: 100.1,
    confirmedAt: 200,
  });
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.positionSeconds,
    94.9,
  );
  assert.equal(readViewingResume(db, item.identity)?.positionSeconds, 94.9);
  const before = db.select().from(schema.sourceAliases).all().length;
  assert.throws(
    () =>
      saveViewingItemProgress(db, {
        item: {
          ...item,
          identity: {
            ...item.identity,
            playlistId: "missing",
            providerItemId: "new",
          },
          legacyContentInfo: {
            ...item.legacyContentInfo,
            playlistId: "missing",
          },
        },
        positionSeconds: 50,
        durationSeconds: 100,
        confirmedAt: 300,
      }),
    /source no longer exists/,
  );
  assert.equal(db.select().from(schema.sourceAliases).all().length, before);
  assert.equal(db.select().from(schema.versionViewingState).all().length, 1);
});

test("title preferences survive reopen, merge confirmed fields, and reject stale choices", async (t) => {
  let db = await fixture(t);
  const item = { identity: identity("a"), work: matrix };
  saveViewingTitlePreferences(
    db,
    item,
    { audio: { language: "eng", role: "main" } },
    100,
  );
  saveViewingTitlePreferences(db, item, { subtitle: "off" }, 200);
  saveViewingTitlePreferences(
    db,
    item,
    { audio: { language: "fr", role: "main" } },
    150,
  );
  closeDatabase();
  db = await initDatabase();
  assert.deepEqual(getViewingTitlePreferences(db, item), {
    audio: { language: "en", role: "main" },
    subtitle: "off",
  });
  const version = { identity: identity("b", "stalker"), work: matrix };
  assert.deepEqual(
    getViewingTitlePreferences(db, version),
    getViewingTitlePreferences(db, item),
  );
  assert.throws(
    () =>
      saveViewingTitlePreferences(
        db,
        item,
        { audio: { language: "und", role: "main" } },
        300,
      ),
    /Invalid track/,
  );
});

test("episodes share title preferences through confirmed series identity without sharing episode progress", async (t) => {
  const db = await fixture(t);
  const series: WorkDescriptor = {
    kind: "series",
    title: "Known Series",
    releaseYear: 2020,
  };
  const episode = (id: string, number: number) => ({
    identity: { ...identity(id), contentKind: "episode" as const },
    seriesIdentity: { ...identity("parent"), contentKind: "series" as const },
    work: {
      kind: "episode" as const,
      title: "Episode",
      series,
      seasonNumber: 1,
      episodeNumber: number,
    },
  });
  const first = episode("e1", 1),
    next = episode("e2", 2);
  saveViewingTitlePreferences(
    db,
    first,
    { subtitle: { language: "ar", role: "main" } },
    100,
  );
  assert.deepEqual(getViewingTitlePreferences(db, next), {
    subtitle: { language: "ar", role: "main" },
  });
  saveViewingItemProgress(db, {
    item: first,
    positionSeconds: 60,
    durationSeconds: 120,
    confirmedAt: 200,
  });
  assert.equal(readViewingResume(db, next.identity, 120), null);
  assert.throws(
    () =>
      getViewingTitlePreferences(db, {
        ...next,
        seriesIdentity: { ...next.seriesIdentity, playlistId: "other" },
      }),
    /Invalid series/,
  );
});

test("conflicting trusted metadata cannot inherit title preferences", async (t) => {
  const db = await fixture(t);
  const first = {
    identity: identity("a"),
    work: { ...matrix, trustedIds: { tmdb: "603" } },
  };
  const other = {
    identity: identity("b"),
    work: { ...matrix, trustedIds: { tmdb: "604" } },
  };
  saveViewingTitlePreferences(db, first, { subtitle: "off" }, 100);
  saveViewingTitlePreferences(
    db,
    other,
    { audio: { language: "ar", role: "main" } },
    200,
  );
  const changed = { ...first, work: other.work };
  assert.equal(getViewingTitlePreferences(db, changed), null);
  assert.throws(
    () => saveViewingTitlePreferences(db, changed, { subtitle: "off" }, 300),
    /Conflicting title/,
  );
});

test("a changed parent series identity cannot inherit another series preferences", async (t) => {
  const db = await fixture(t);
  const series = (tmdb: string): WorkDescriptor => ({
    kind: "series",
    title: "Series",
    releaseYear: 2020,
    trustedIds: { tmdb },
  });
  const item = (episodeId: string, parentId: string, tmdb: string) => ({
    identity: { ...identity(episodeId), contentKind: "episode" as const },
    seriesIdentity: { ...identity(parentId), contentKind: "series" as const },
    work: {
      kind: "episode" as const,
      title: "Episode",
      series: series(tmdb),
      seasonNumber: 1,
      episodeNumber: 1,
    },
  });
  saveViewingTitlePreferences(
    db,
    item("old", "parent", "1"),
    { subtitle: "off" },
    100,
  );
  saveViewingTitlePreferences(
    db,
    item("other", "other-parent", "2"),
    { audio: { language: "fr", role: "main" } },
    200,
  );
  assert.equal(
    getViewingTitlePreferences(db, item("new", "parent", "2")),
    null,
  );
});

test("a confirmed clock without fresh duration retains the known actual duration", async (t) => {
  const db = await fixture(t);
  const item = {
    identity: identity("7"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 7,
      contentType: "vod" as const,
    },
  };
  saveViewingItemProgress(db, {
    item,
    positionSeconds: 60,
    durationSeconds: 120,
    confirmedAt: 200,
  });
  saveViewingItemProgress(db, { item, positionSeconds: 70, confirmedAt: 300 });
  assert.equal(readViewingResume(db, item.identity)?.durationSeconds, 120);
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.durationSeconds,
    120,
  );
});

test("explicit actions survive through compatibility history when duration is unknown", async (t) => {
  const db = await fixture(t);
  const item = {
    identity: identity("7"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 7,
      contentType: "vod" as const,
    },
  };
  saveViewingItemProgress(db, {
    item,
    positionSeconds: 0,
    confirmedAt: 200,
    action: "finished",
  });
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.action,
    "finished",
  );
  saveViewingItemProgress(db, {
    item,
    positionSeconds: 0,
    confirmedAt: 300,
    action: "reset",
  });
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.action,
    "reset",
  );
  saveViewingItemProgress(db, {
    item,
    positionSeconds: 10,
    durationSeconds: 120,
    confirmedAt: 400,
  });
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.action,
    "progress",
  );
});

test("neutral history preserves opaque version identity, compatibility metadata and raw/shared positions", async (t) => {
  const db = await fixture(t);
  const one = {
    identity: identity("0007-A", "stalker"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 42,
      contentType: "vod" as const,
    },
  };
  const two = { identity: identity("7"), work: matrix };
  saveViewingItemProgress(db, {
    item: one,
    positionSeconds: 30,
    durationSeconds: 1200,
    confirmedAt: 100,
  });
  saveViewingItemProgress(db, {
    item: two,
    positionSeconds: 600,
    durationSeconds: 1200,
    confirmedAt: 200,
  });
  const rows = getViewingHistory(db, "one");
  assert.equal(rows.length, 2);
  const opaque = rows.find(
    (row) => row.item.identity.providerItemId === "0007-A",
  );
  assert.equal(opaque?.item.legacyContentInfo?.contentXtreamId, 42);
  assert.equal(opaque?.raw.positionSeconds, 30);
  assert.equal(opaque?.resume?.positionSeconds, 600);
  assert.equal(opaque?.workId, rows[0].workId);
  assert.deepEqual(getViewingHistory(db, "missing"), []);
});

test("opening a migrated numeric version adopts its existing raw progress without changing that history", async (t) => {
  const db = await fixture(t);
  const item = {
    identity: identity("7"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 7,
      contentType: "vod" as const,
    },
  };
  reconcileViewingHistoryItem(db, item);
  assert.equal(readViewingResume(db, item.identity)?.positionSeconds, 94.9);
  assert.equal(readViewingResume(db, item.identity)?.finished, false);
  assert.equal(
    db.select().from(schema.playbackPositions).get()?.positionSeconds,
    94.9,
  );
  const opaque = { ...item, identity: identity("0007-A", "stalker") };
  reconcileViewingHistoryItem(db, opaque);
  assert.equal(
    readViewingResume(db, opaque.identity),
    null,
    "an opaque ID cannot inherit ambiguous numeric legacy history",
  );
});

test("colliding legacy numeric adapters never overwrite another opaque Stalker version raw history", async (t) => {
  const db = await fixture(t);
  const one = {
    identity: identity("opaque-A", "stalker"),
    work: matrix,
    legacyContentInfo: {
      playlistId: "one",
      contentXtreamId: 42,
      contentType: "vod" as const,
    },
  };
  const two = { ...one, identity: identity("opaque-B", "stalker") };
  saveViewingItemProgress(db, {
    item: one,
    positionSeconds: 25,
    durationSeconds: 1200,
    confirmedAt: 100,
  });
  saveViewingItemProgress(db, {
    item: two,
    positionSeconds: 70,
    durationSeconds: 1200,
    confirmedAt: 200,
  });
  assert.equal(
    db
      .select()
      .from(schema.playbackPositions)
      .all()
      .find((row) => row.contentXtreamId === 42)?.positionSeconds,
    25,
  );
  assert.equal(
    getViewingHistory(db, "one").find(
      (row) => row.item.identity.providerItemId === "opaque-B",
    )?.raw.positionSeconds,
    70,
  );
});

test('clearing legacy history also clears its neutral version without erasing another version history', async t => {
 const db = await fixture(t);
 const first = { identity: identity('7'), work: matrix, legacyContentInfo: { playlistId: 'one', contentXtreamId: 7, contentType: 'vod' as const } };
 const second = { ...first, identity: identity('8'), legacyContentInfo: { ...first.legacyContentInfo, contentXtreamId: 8 } };
 saveViewingItemProgress(db, { item: second, positionSeconds: 40, durationSeconds: 1200, confirmedAt: 100 });
 saveViewingItemProgress(db, { item: first, positionSeconds: 60, durationSeconds: 1200, confirmedAt: 200 });
 await clearPlaybackPosition(db, 'one', 7, 'vod');
 assert.equal(getViewingHistory(db).length, 1);
 assert.equal(readViewingResume(db, second.identity)?.positionSeconds, 40);
 assert.equal(db.select().from(schema.playbackPositions).all().find(row => row.contentXtreamId === 8)?.positionSeconds, 40);
 await clearAllPlaybackPositions(db, 'one'); assert.deepEqual(getViewingHistory(db), []);
});

test('successful playback belongs to its raw version and survives later progress and resets', async t => {
 const db=await fixture(t);const a=identity('success-A'),b=identity('success-B');
 reconcileViewingItem(db,a,matrix);reconcileViewingItem(db,b,matrix);
 saveConfirmedViewingState(db,{identity:a,positionSeconds:20,durationSeconds:100,confirmedAt:200,successfulAt:190});
 saveConfirmedViewingState(db,{identity:a,positionSeconds:0,confirmedAt:300,action:'reset'});
 assert.equal(readViewingResume(db,a)?.successfulAt,190);
 assert.equal(readViewingResume(db,b,100)?.successfulAt,undefined);
 assert.throws(()=>saveConfirmedViewingState(db,{identity:b,positionSeconds:10,confirmedAt:400,successfulAt:401}),/Invalid/);
});


test('legacy duplicate work records with identical known descriptors share the latest confirmed resume without rewriting raw history', async t => {
 const db=await fixture(t),a=identity('duplicate-A'),b=identity('duplicate-B');
 const work={...matrix,trustedIds:{tmdb:'603'}};
 const alias=reconcileViewingItem(db,a,work);reconcileViewingItem(db,b,work);
 saveConfirmedViewingState(db,{identity:b,positionSeconds:5,durationSeconds:1200,confirmedAt:100});
 const original=db.select().from(schema.matchedWorks).all().find(row=>row.id===alias.workId)!;
 db.insert(schema.matchedWorks).values({...original,id:'legacy-duplicate'}).run();
 db.update(schema.sourceAliases).set({workId:'legacy-duplicate'}).where(eq(schema.sourceAliases.providerItemId,b.providerItemId)).run();
 db.insert(schema.sharedViewingState).values({workId:'legacy-duplicate',identityKey:JSON.stringify(['xtream','one','vod',b.providerItemId]),positionSeconds:5,durationSeconds:1200,confirmedAt:100,action:'progress'}).run();
 saveConfirmedViewingState(db,{identity:a,positionSeconds:80,durationSeconds:1200,confirmedAt:200});
 assert.equal(readViewingResume(db,b,1200)?.positionSeconds,80);
 assert.equal(readViewingResume(db,b,1800)?.positionSeconds,5);
 assert.equal(db.select().from(schema.versionViewingState).all().find(row=>row.identityKey.includes('duplicate-B'))?.positionSeconds,5);
 saveConfirmedViewingState(db,{identity:a,positionSeconds:0,confirmedAt:300,action:'reset'});
 assert.equal(readViewingResume(db,b,1200)?.positionSeconds,0);
 db.update(schema.sourceAliases).set({sharedAllowed:false}).where(eq(schema.sourceAliases.providerItemId,b.providerItemId)).run();
 assert.equal(readViewingResume(db,b,1200)?.positionSeconds,5);
});
