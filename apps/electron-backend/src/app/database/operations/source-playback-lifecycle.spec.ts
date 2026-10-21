import assert from "node:assert/strict";
import test from "node:test";
import { fixture, evidence } from "./source-playback.test-fixtures";
import {
  readSourcePlaybackEvidence,
  saveSourcePlaybackEvidence,
} from "./source-playback.operations";
test("rename retains revision but direct credentials and payload device edits invalidate it", () => {
  const { db, sqlite } = fixture();
  try {
    const original = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    saveSourcePlaybackEvidence(db, evidence(original));
    sqlite.prepare("UPDATE playlists SET name='Renamed' WHERE id='one'").run();
    assert.equal(readSourcePlaybackEvidence(db, ["one"])[0].revision, original);
    sqlite
      .prepare("UPDATE playlists SET username='different' WHERE id='one'")
      .run();
    const changed = readSourcePlaybackEvidence(db, ["one"])[0];
    assert.notEqual(changed.revision, original);
    assert.equal(changed.latest.length, 0);
    sqlite
      .prepare(`UPDATE playlists SET payload=? WHERE id='one'`)
      .run(JSON.stringify({ stalkerSerialNumber: "new-identity" }));
    assert.notEqual(
      readSourcePlaybackEvidence(db, ["one"])[0].revision,
      changed.revision,
    );
    assert.equal(
      saveSourcePlaybackEvidence(db, evidence(original)),
      "obsolete",
    );
  } finally {
    sqlite.close();
  }
});
test("delete and reimport cannot resurrect old evidence; removing all cascades", () => {
  const { db, sqlite } = fixture();
  try {
    const original = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    saveSourcePlaybackEvidence(db, evidence(original));
    sqlite.prepare("DELETE FROM playlists WHERE id='one'").run();
    assert.deepEqual(readSourcePlaybackEvidence(db, ["one"]), []);
    sqlite
      .prepare(
        "INSERT INTO playlists(id,name,type) VALUES ('one','One','xtream')",
      )
      .run();
    assert.notEqual(
      readSourcePlaybackEvidence(db, ["one"])[0].revision,
      original,
    );
    assert.equal(
      saveSourcePlaybackEvidence(db, evidence(original)),
      "obsolete",
    );
    sqlite.exec("DELETE FROM playlists");
    assert.equal(
      sqlite
        .prepare("SELECT count(*) as n FROM source_playback_observations")
        .get().n,
      0,
    );
  } finally {
    sqlite.close();
  }
});
test("ephemeral Stalker tokens retain the durable evidence revision", () => {
  const { db, sqlite } = fixture();
  try {
    const revision = readSourcePlaybackEvidence(db, ["one"])[0].revision;
    saveSourcePlaybackEvidence(db, evidence(revision));
    sqlite
      .prepare("UPDATE playlists SET payload=? WHERE id='one'")
      .run(JSON.stringify({ stalkerToken: "rotated-token" }));
    assert.equal(readSourcePlaybackEvidence(db, ["one"])[0].revision, revision);
    assert.equal(readSourcePlaybackEvidence(db, ["one"])[0].latest.length, 1);
  } finally {
    sqlite.close();
  }
});
