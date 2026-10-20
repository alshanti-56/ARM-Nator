import assert from "node:assert/strict";
import test from "node:test";
import {
  matchPreferredTrack,
  captureTrackPreference,
  inferTrackRole,
} from "./title-track-preferences";

test("track preferences match semantic language and role across unrelated engine IDs", () => {
  const preferred = captureTrackPreference({
    language: "eng",
    role: "commentary",
  });
  assert.deepEqual(preferred, { language: "en", role: "commentary" });
  assert.equal(
    matchPreferredTrack(
      [
        { id: 3, language: "en", role: "main" },
        { id: 77, language: "en-US", role: "commentary" },
      ],
      preferred,
    )?.id,
    77,
  );
  assert.equal(
    matchPreferredTrack(
      [{ id: 3, language: "fr", role: "commentary" }],
      preferred,
    ),
    null,
  );
  assert.equal(
    matchPreferredTrack(
      [{ id: 3, language: "en", role: "unknown" }],
      preferred,
    ),
    null,
  );
  assert.equal(captureTrackPreference({ language: "und", role: "main" }), null);
});

test("missing metadata never fabricates a preference; accessibility and forced roles remain distinct", () => {
  assert.equal(captureTrackPreference({}), null);
  assert.equal(inferTrackRole({ forced: true }), "forced");
  assert.equal(inferTrackRole({ kind: "captions" }), "sdh");
  assert.equal(inferTrackRole({ roles: ["commentary"] }), "commentary");
  assert.equal(
    inferTrackRole({ characteristics: "public.accessibility.describes-video" }),
    "description",
  );
  assert.equal(inferTrackRole({ label: "English commentary" }), "commentary");
  assert.equal(inferTrackRole({}), "main");
});
