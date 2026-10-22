import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { SourcePlaybackStoreService } from "./source-playback-store.service";
import { SourcePlaybackRepositoryService } from "./source-playback-repository.service";
import type { SourceEvidenceSnapshot } from "@arm-nator/shared/interfaces";
test("store publishes only read acknowledgements, keeps prior evidence on errors and filters by category", async () => {
  let fail = false;
  const saved: SourceEvidenceSnapshot = {
    sourceId: "one",
    revision: "r",
    latest: [],
    observations: [],
    attempts: [],
    lastSuccessfulAt: {},
    account: null,
    cursor: {},
    nextEligibleAt: {},
    inconclusiveCounts: {},
  };
  const injector = createEnvironmentInjector(
    [
      {
        provide: SourcePlaybackRepositoryService,
        useValue: {
          read: async () => {
            if (fail) throw Error("disk failed");
            return [saved];
          },
        },
      },
    ],
    null as never,
  );
  try {
    const store = runInInjectionContext(
      injector,
      () => new SourcePlaybackStoreService(),
    );
    await store.load(["one"]);
    assert.equal(store.summariesFor("one").length, 3);
    store.setFilter({ category: "live", result: "verified" });
    assert.equal(store.matches("one"), false);
    fail = true;
    await store.refreshSaved(["one"]);
    assert.equal(store.snapshots().get("one")?.revision, "r");
    assert.equal(
      store.persistenceFailure(),
      "Playback evidence could not be loaded. Try again.",
    );
  } finally {
    injector.destroy();
  }
});
