import assert from "node:assert/strict";
import test from "node:test";
import {
  SourceViewingSession,
  sourceViewingIdentity,
} from "./source-viewing-session";
import type { SourceConfirmationInput } from "@arm-nator/shared/interfaces";
const key = { sourceId: "one", revision: "r", category: "movies" as const };
const sample = (t: number, generation = "1"): SourceConfirmationInput => ({
  generation,
  atMs: t * 1000,
  positionSeconds: t,
  playing: true,
  stalled: false,
  seeking: false,
  presentedFrames: t * 24,
});
test("one qualified observation per viewing selection and terminal degradation updates that same ID", () => {
  const session = new SourceViewingSession({
    id: "view",
    key,
    itemId: "7",
    title: "Movie",
    startedAt: 0,
  });
  let writes = 0,
    success: any;
  for (let t = 0; t <= 12; t++) {
    const write = session.observe(sample(t), "1", "html5");
    if (write) {
      writes++;
      success = write;
    }
  }
  assert.equal(writes, 1);
  assert.equal(success.observation.result, "verified");
  const failed = session.terminal("stalled", true, "html5", 15000);
  assert.equal(failed?.attempt.checkId, "view");
  assert.equal(failed?.observation?.successfulAt, 6000);
  assert.equal(failed?.observation?.result, "failed");
  assert.equal(session.terminal("stalled", true, "html5", 16000), null);
});
test("pause, seek, stalls, engine generations and early stop cannot manufacture a failed observation", () => {
  const session = new SourceViewingSession({
    id: "view",
    key,
    itemId: "7",
    title: "Movie",
    startedAt: 0,
  });
  for (let t = 0; t < 6; t++)
    assert.equal(session.observe(sample(t), "1", "html5"), null);
  assert.equal(
    session.observe({ ...sample(6), seeking: true }, "1", "html5"),
    null,
  );
  for (let t = 7; t < 12; t++)
    assert.equal(session.observe(sample(t), "1", "html5"), null);
  assert.equal(session.observe(sample(12, "old"), "new", "html5"), null);
  assert.equal(
    session.observe({ ...sample(12), playing: false }, "1", "html5"),
    null,
  );
  assert.equal(
    session.observe({ ...sample(13), stalled: true }, "1", "html5"),
    null,
  );
  const inconclusive = session.terminal(
    "unsupported-media",
    false,
    "html5",
    14000,
  );
  assert.equal(inconclusive?.observation, undefined);
});
test("source identity uses catalogue or content identity and never falls back to a URL", () => {
  assert.equal(
    sourceViewingIdentity({
      streamUrl: "https://fixture.test",
      title: "Direct",
    }),
    null,
  );
  assert.deepEqual(
    sourceViewingIdentity({
      streamUrl: "https://fixture.test",
      title: "Movie",
      itemIdentity: {
        sourceType: "xtream",
        playlistId: "one",
        contentKind: "vod",
        providerItemId: "7",
      },
    }),
    { sourceId: "one", itemId: "7", category: "movies" },
  );
});
