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
test("series candidates identify a real episode and resolve a fresh episode detail", async () => {
  const h = setup(true);
  const api = h.injector.get(XtreamApiService) as any;
  const db = h.injector.get(DatabaseService) as any;
  const urls = h.injector.get(XtreamUrlService) as any;
  let reads = 0;
  db.getSourcePlaybackCandidates = async () => [
    { itemId: "show", title: "Show", category: "series", categoryId: "1" },
  ];
  api.getSeriesInfo = async () => {
    reads++;
    return {
      episodes: {
        1: [
          {
            id: "episode",
            title: "Episode 1",
            episode_num: 1,
            season: 1,
            container_extension: "mp4",
          },
        ],
      },
    };
  };
  urls.constructEpisodeUrl = (_c: unknown, e: any) =>
    "https://fixture.test/series/" + e.id + "." + e.container_extension;
  try {
    const s = runInInjectionContext(
      h.injector,
      () => new XtreamSourcePlaybackSamplerService(),
    );
    const items = await s.select("one", "series", new AbortController().signal);
    assert.equal(items[0]?.episodeId, "episode");
    const playback = await s.resolve(
      "one",
      items[0],
      new AbortController().signal,
    );
    assert.equal(playback.streamUrl, "https://fixture.test/series/episode.mp4");
    assert.equal(playback.isLive, false);
    assert.equal(reads, 2);
    api.getSeriesInfo = async () => ({ episodes: {} });
    assert.deepEqual(
      await s.select("one", "series", new AbortController().signal),
      [],
    );
  } finally {
    h.injector.destroy();
  }
});
test("movies require provider extension; series without a real playable episode remain untested", async () => {
  const h = setup(true);
  const api = h.injector.get(XtreamApiService) as any;
  const urls = h.injector.get(XtreamUrlService) as any;
  api.getVodInfo = async () => ({
    movie_data: { stream_id: 7, container_extension: "mp4" },
  });
  urls.constructVodUrl = (_c: unknown, d: any) =>
    d.movie_data.container_extension ? "https://fixture.test/movie/7.mp4" : "";
  try {
    const s = runInInjectionContext(
      h.injector,
      () => new XtreamSourcePlaybackSamplerService(),
    );
    const c = {
      itemId: "7",
      title: "Movie",
      category: "movies" as const,
      categoryId: "1",
    };
    assert.equal(
      (await s.resolve("one", c, new AbortController().signal)).streamUrl,
      "https://fixture.test/movie/7.mp4",
    );
    api.getVodInfo = async () => ({ movie_data: { stream_id: 7 } });
    await assert.rejects(s.resolve("one", c, new AbortController().signal));
  } finally {
    h.injector.destroy();
  }
});
test("hidden or removed categories never resolve a media sample", async () => {
  const h = setup(true);
  const api = h.injector.get(XtreamApiService) as any;
  try {
    const s = runInInjectionContext(
      h.injector,
      () => new XtreamSourcePlaybackSamplerService(),
    );
    api.getCategories = async () => [
      { category_id: "1", category_name: "Hidden" },
    ];
    const c = {
      itemId: "7",
      title: "Channel",
      category: "live" as const,
      categoryId: "1",
    };
    await assert.rejects(s.resolve("one", c, new AbortController().signal));
    api.getCategories = async () => [];
    await assert.rejects(s.resolve("one", c, new AbortController().signal));
  } finally {
    h.injector.destroy();
  }
});
