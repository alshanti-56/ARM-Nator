import assert from "node:assert/strict";
import test from "node:test";
import {
  isContinueWatchingRecentItem,
  findDashboardResumeHero,
} from "./dashboard-playback.utils";

test("Continue Watching recalculates legacy positions at the unrounded 95 percent threshold", () => {
  assert.equal(
    isContinueWatchingRecentItem(
      { type: "movie" },
      { positionSeconds: 94.9, durationSeconds: 100 },
    ),
    true,
  );
  assert.equal(
    isContinueWatchingRecentItem(
      { type: "movie" },
      { positionSeconds: 95, durationSeconds: 100 },
    ),
    false,
  );
  assert.equal(
    isContinueWatchingRecentItem(
      { type: "series" },
      { positionSeconds: 950, durationSeconds: 1000 },
    ),
    false,
  );
  assert.equal(
    isContinueWatchingRecentItem(
      { type: "movie" },
      { positionSeconds: 0, durationSeconds: 100 },
    ),
    false,
  );
  assert.equal(isContinueWatchingRecentItem({ type: "movie" }, null), false);
  assert.equal(
    isContinueWatchingRecentItem(
      { type: "live" },
      { positionSeconds: 30, durationSeconds: 100 },
    ),
    false,
  );
  assert.equal(
    isContinueWatchingRecentItem({ type: "movie" }, { positionSeconds: 10 }),
    true,
  );
});

test("dashboard hero skips finished, reset and unopened movies while preserving live recency", () => {
  const items = [
    { id: "finished", type: "movie" as const },
    { id: "opened", type: "movie" as const },
    { id: "resume", type: "movie" as const },
    { id: "live", type: "live" as const },
  ];
  const position = (item: (typeof items)[number]) =>
    item.id === "finished"
      ? { positionSeconds: 95, durationSeconds: 100 }
      : item.id === "resume"
        ? { positionSeconds: 94.9, durationSeconds: 100 }
        : null;
  assert.equal(findDashboardResumeHero(items, position)?.id, "resume");
  assert.equal(findDashboardResumeHero(items.slice(0, 2), position), null);
  assert.equal(
    findDashboardResumeHero([items[3], items[2]], position)?.id,
    "live",
  );
  assert.equal(
    findDashboardResumeHero([items[2]], () => ({
      positionSeconds: 0,
      action: "finished",
    })),
    null,
  );
});
