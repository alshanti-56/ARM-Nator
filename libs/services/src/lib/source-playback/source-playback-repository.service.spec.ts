import "@angular/compiler";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { DatabaseService } from "../database-electron.service";
import { SourcePlaybackRepositoryService } from "./source-playback-repository.service";
test("repository batches reads and propagates persistence failure", async () => {
  let reads = 0;
  const injector = createEnvironmentInjector(
    [
      {
        provide: DatabaseService,
        useValue: {
          getSourcePlaybackEvidence: async (ids: string[]) => {
            reads++;
            assert.equal(ids.length, 6);
            return [];
          },
          saveSourcePlaybackEvidence: async () => {
            throw new Error("disk unavailable");
          },
        },
      },
    ],
    null as never,
  );
  try {
    const repository = runInInjectionContext(
      injector,
      () => new SourcePlaybackRepositoryService(),
    );
    await repository.read(["1", "2", "3", "4", "5", "6"]);
    assert.equal(reads, 1);
    await assert.rejects(repository.write({} as never), /disk unavailable/);
  } finally {
    injector.destroy();
  }
});
