import "@angular/compiler";
import { of } from "rxjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import {
  PlaylistsService,
  DatabaseService,
  SourcePlaybackRepositoryService,
} from "@arm-nator/services";
import { XtreamApiService } from "./services/xtream-api.service";
import { XtreamUrlService } from "./services/xtream-url.service";
import { XtreamSourcePlaybackSamplerService } from "./source-playback-sampler.service";
function setup(cached: boolean) {
  let calls = 0;
  const injector = createEnvironmentInjector(
    [
      {
        provide: PlaylistsService,
        useValue: {
          getPlaylistById: () =>
            of({
              _id: "one",
              serverUrl: "https://fixture.test",
              username: "sample",
              password: "sample",
              hiddenGroupTitles: ["Hidden"],
            }),
        },
      },
      {
        provide: DatabaseService,
        useValue: {
          getSourcePlaybackCandidates: async () =>
            cached
              ? [
                  {
                    itemId: "7",
                    title: "Cached",
                    category: "live",
                    categoryId: "1",
                  },
                ]
              : [],
          hasXtreamCategories: async () => false,
        },
      },
      {
        provide: SourcePlaybackRepositoryService,
        useValue: { read: async () => [] },
      },
      {
        provide: XtreamApiService,
        useValue: {
          getCategories: async () => [
            { category_id: "1", category_name: "Visible" },
            { category_id: "2", category_name: "Hidden" },
          ],
          getLiveStreams: async (_c: unknown, o: { categoryId: string }) => {
            calls++;
            assert.equal(o.categoryId, "1");
            return [
              { stream_id: 1, name: "One", category_id: "1" },
              { stream_id: 2, name: "Two", category_id: "1" },
            ];
          },
          cancelSession: async () => true,
        },
      },
      {
        provide: XtreamUrlService,
        useValue: { constructLiveUrl: () => "https://fixture.test/live" },
      },
    ],
    null as never,
  );
  return {
    injector,
    get calls() {
      return calls;
    },
  };
}
test("cached sampling avoids provider catalogue downloads", async () => {
  const h = setup(true);
  try {
    const sampler = runInInjectionContext(
      h.injector,
      () => new XtreamSourcePlaybackSamplerService(),
    );
    const items = await sampler.select(
      "one",
      "live",
      new AbortController().signal,
    );
    assert.equal(items.length, 1);
    assert.equal(h.calls, 0);
  } finally {
    h.injector.destroy();
  }
});

test("uncached discovery requests only visible provider categories", async () => {
  const h = setup(false);
  try {
    const sampler = runInInjectionContext(
      h.injector,
      () => new XtreamSourcePlaybackSamplerService(),
    );
    const items = await sampler.select(
      "one",
      "live",
      new AbortController().signal,
    );
    assert.equal(items.length, 2);
    assert.equal(h.calls, 1);
  } finally {
    h.injector.destroy();
  }
});
