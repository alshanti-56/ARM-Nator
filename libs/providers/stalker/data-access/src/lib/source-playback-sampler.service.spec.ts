import "@angular/compiler";
import { StalkerAccountInfoService } from "./stalker-account-info.service";
import { StalkerSessionService } from "./stalker-session.service";
import "@arm-nator/providers/shared/util/testing";
import assert from "node:assert/strict";
import test from "node:test";
import { of } from "rxjs";
import {
  createEnvironmentInjector,
  runInInjectionContext,
} from "@angular/core";
import { DataService, PlaylistsService } from "@arm-nator/services";
import {
  STALKER_CANCEL_REQUEST,
  type Playlist,
} from "@arm-nator/shared/interfaces";
import { StalkerPortalRepairService } from "./stalker-portal-repair.service";
import { StalkerSourcePlaybackContextService } from "./source-playback-context.service";
import { StalkerSourcePlaybackSamplerService } from "./source-playback-sampler.service";
function setup(full = true) {
  let links = 0;
  const calls: any[] = [];
  const source = {
    _id: "one",
    title: "Portal",
    portalUrl: full
      ? "https://fixture.test/stalker_portal/server/load.php"
      : "https://fixture.test/portal.php",
    macAddress: "00:1A:79:00:00:01",
    stalkerToken: "saved",
    isFullStalkerPortal: full,
  } as Playlist;
  const data = {
    sendIpcEvent: async (_event: string, p: any) => {
      calls.push(p);
      const a = p?.params?.action;
      if (a === "handshake")
        return { js: { token: "saved", random: "fixture" } };
      if (a === "get_profile")
        return { js: { status: 0, account_info: { expire_date: 1800000000 } } };
      if (a === "get_genres" || a === "get_categories")
        return { js: [{ id: "g", title: "Visible" }] };
      if (a === "get_ordered_list")
        return {
          js: {
            data: p.params.movie_id
              ? [
                  {
                    id: "season",
                    name: "Season 1",
                    series: [1, 2],
                    cmd: "ffmpeg /media/season",
                  },
                ]
              : [
                  {
                    id: p.params.type === "series" ? "show" : "item",
                    name: "One",
                    cmd: "ffmpeg /ch/1",
                    use_http_tmp_link: 1,
                    category_id: "g",
                  },
                ],
          },
        };
      if (a === "create_link")
        return {
          js: { cmd: "ffmpeg https://fixture.test/media/" + ++links + ".mp4" },
        };
      return {};
    },
  };
  const repair = {
    waitForPendingRepair: async () => {},
    applyOverride: (s: any) => s,
  };
  const injector = createEnvironmentInjector(
    [
      { provide: DataService, useValue: data },
      {
        provide: PlaylistsService,
        useValue: { getPlaylistById: () => of(source) },
      },
      { provide: StalkerPortalRepairService, useValue: repair },
      {
        provide: StalkerSourcePlaybackContextService,
        useFactory: () => new StalkerSourcePlaybackContextService(),
      },
    ],
    null as never,
  );
  const sampler = runInInjectionContext(
    injector,
    () => new StalkerSourcePlaybackSamplerService(),
  );
  return { injector, sampler, data, source, calls, repair };
}
test("full and legacy portals use bounded pages and fresh links without changing saved source state", async () => {
  for (const full of [true, false]) {
    const h = setup(full);
    try {
      const signal = new AbortController().signal;
      const items = await h.sampler.select("one", "live", signal);
      assert.equal(items.length, 1);
      const one = await h.sampler.resolve("one", items[0], signal),
        two = await h.sampler.resolve("one", items[0], signal);
      assert.notEqual(one.streamUrl, two.streamUrl);
      assert.equal(h.source.stalkerToken, "saved");
      const handshakes = h.calls.filter(
        (p) => p.params?.action === "handshake",
      );
      assert.equal(handshakes.length, full ? 3 : 0);
      if (full) assert.equal(handshakes[0].params.token, "saved");
      assert.ok(
        h.calls
          .filter((p) => p.params?.action === "get_ordered_list")
          .every((p) => p.params.p === 1),
      );
    } finally {
      h.injector.destroy();
    }
  }
});
test("selects real series episode identity and requests that episode, while hidden categories stay unsampled", async () => {
  const h = setup(false);
  try {
    const signal = new AbortController().signal;
    const items = await h.sampler.select("one", "series", signal);
    assert.equal(items.length, 1);
    assert.equal(items[0].episodeId, JSON.stringify(["season", 1]));
    const playback = await h.sampler.resolve("one", items[0], signal);
    assert.equal(playback.isLive, false);
    assert.equal(
      h.calls.find((p) => p.params?.action === "create_link").params.series,
      "1",
    );
    h.source.hiddenStalkerCategoryIds = { series: ["g"] };
    assert.deepEqual(await h.sampler.select("one", "series", signal), []);
  } finally {
    h.injector.destroy();
  }
});
test("abort drains ignored create_link and handshake requests before returning ownership", async () => {
  for (const action of ["create_link", "handshake"]) {
    const h = setup(action === "handshake");
    let finish!: (v: any) => void, started!: (v?: unknown) => void;
    const ready = new Promise((r) => (started = r)),
      pending = new Promise((r) => (finish = r));
    const original = h.data.sendIpcEvent;
    h.data.sendIpcEvent = async (event, p) => {
      if (event === STALKER_CANCEL_REQUEST) return true as any;
      if (p?.params?.action === action) {
        started();
        return pending as any;
      }
      return original(event, p);
    };
    try {
      const abort = new AbortController();
      let settled = false;
      const key = {
        itemId: "item",
        title: "One",
        category: "live" as const,
        categoryId: "g",
      };
      const result = h.sampler.resolve("one", key, abort.signal).finally(() => {
        settled = true;
      });
      void result.catch(() => {});
      await ready;
      abort.abort();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      assert.equal(settled, false);
      finish({ js: { token: "saved", cmd: "https://fixture.test/late" } });
      await assert.rejects(result, /cancelled|aborted/i);
    } finally {
      h.injector.destroy();
    }
  }
});
test("pending portal repair can be cancelled before any authentication request", async () => {
  const h = setup();
  h.repair.waitForPendingRepair = () => new Promise(() => {});
  try {
    const abort = new AbortController();
    const pending = h.sampler.select("one", "live", abort.signal);
    abort.abort();
    await assert.rejects(pending);
    assert.equal(h.calls.length, 0);
  } finally {
    h.injector.destroy();
  }
});
test("a token refreshed in a catalogue response is request-scoped and follows the fresh link", async () => {
  const h = setup();
  const original = h.data.sendIpcEvent;
  h.data.sendIpcEvent = async (event, p) => {
    const response = await original(event, p);
    if (p?.params?.action === "get_ordered_list")
      return { ...response, js: { ...(response as any).js, token: "rotated" } };
    return response;
  };
  try {
    const signal = new AbortController().signal;
    const [candidate] = await h.sampler.select("one", "live", signal);
    const playback = await h.sampler.resolve("one", candidate, signal);
    assert.equal(
      h.calls.find((p) => p.params?.action === "create_link").token,
      "rotated",
    );
    assert.equal(playback.headers?.["Authorization"], "Bearer rotated");
    assert.equal(h.source.stalkerToken, "saved");
  } finally {
    h.injector.destroy();
  }
});

test("cancellable account reads use request-scoped full profiles and propagate repair cancellation", async () => {
  const h = setup();
  const child = createEnvironmentInjector(
    [
      {
        provide: StalkerSessionService,
        useValue: {
          refreshAccountProfile: () => {
            throw Error("Shared account session must not change");
          },
        },
      },
    ],
    h.injector,
  );
  try {
    const account = runInInjectionContext(
      child,
      () => new StalkerAccountInfoService(),
    );
    const info = await account.fetchAccountInfo(h.source, {
      signal: new AbortController().signal,
    });
    assert.equal(info?.expireDate, 1800000000);
    assert.equal(h.source.stalkerToken, "saved");
    h.repair.waitForPendingRepair = () => new Promise(() => {});
    const abort = new AbortController();
    const pending = account.fetchAccountInfo(h.source, {
      signal: abort.signal,
    });
    abort.abort();
    await assert.rejects(pending);
  } finally {
    child.destroy();
    h.injector.destroy();
  }
});
