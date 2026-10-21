import assert from "node:assert/strict";
import test from "node:test";
import { sourcePlaybackOccupied } from "./source-playback-occupancy";
test("paused, dismissed external, loading, recovery and YouTube all remain occupied", () => {
  const idle = {
    playback: false,
    stopped: true,
    preparing: false,
    recovering: false,
    youtube: false,
    external: null,
  };
  assert.equal(sourcePlaybackOccupied(idle), false);
  for (const state of [
    { ...idle, playback: true, stopped: false },
    { ...idle, preparing: true },
    { ...idle, recovering: true },
    { ...idle, youtube: true },
    { ...idle, external: { status: "unknown" } },
    { ...idle, external: { status: "error" } },
    { ...idle, external: { status: "paused" } },
  ])
    assert.equal(sourcePlaybackOccupied(state), true);
  assert.equal(
    sourcePlaybackOccupied({ ...idle, external: { status: "closed" } }),
    false,
  );
});
