import { Injector } from "@angular/core";
import {
  DiscoverySelectionService,
  PORTAL_DISCOVERY_ADAPTER,
} from "@arm-nator/providers/shared/util";
import type {
  DiscoveryVersion,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
const version = (id: string): DiscoveryVersion => ({
  identity: {
    sourceType: "xtream",
    playlistId: id,
    contentKind: "vod",
    providerItemId: "7",
  },
  providerName: id,
  originalTitle: "Movie (2020)",
  categoryId: "1",
  contentType: "movie",
  work: { kind: "movie", title: "Movie", releaseYear: 2020 },
  navigation: ["/workspace/xtreams", id, "vod", "1", "7"],
});
const playback = (id: string): ResolvedPortalPlayback => ({
  streamUrl: "http://fixture.invalid/movie",
  title: "Movie",
  itemIdentity: version(id).identity,
  work: version(id).work,
  isLive: false,
});
function setup() {
  const adapter = {
    versions: jest.fn(),
    rememberVersions: jest.fn().mockResolvedValue(undefined),
  };
  const injector = Injector.create({
    providers: [
      DiscoverySelectionService,
      { provide: PORTAL_DISCOVERY_ADAPTER, useValue: adapter },
    ],
  });
  return {
    adapter,
    injector,
    service: injector.get(DiscoverySelectionService),
  };
}
it("loads alternatives for category/history playback without a search selection", async () => {
  const { adapter, injector, service } = setup();
  try {
    adapter.versions.mockResolvedValue([version("a"), version("b")]);
    await service.loadForPlayback(playback("a"));
    expect(service.matches(playback("a"))).toBe(true);
    expect(
      service.selection()?.versions.map((v) => v.identity.playlistId),
    ).toEqual(["a", "b"]);
    expect(service.loading()).toBe(false);
  } finally {
    injector.destroy();
  }
});
it("ignores an obsolete lookup after a different title starts or playback closes", async () => {
  const { adapter, injector, service } = setup();
  try {
    let finish!: (v: DiscoveryVersion[]) => void;
    adapter.versions.mockReturnValueOnce(new Promise((r) => (finish = r)));
    const pending = service.loadForPlayback(playback("a"));
    await service.loadForPlayback(null);
    finish([version("a"), version("b")]);
    await pending;
    expect(service.selection()).toBeNull();
    expect(service.loading()).toBe(false);
  } finally {
    injector.destroy();
  }
});
it("keeps an existing search group usable when local lookup fails and reports failure", async () => {
  const { adapter, injector, service } = setup();
  try {
    service.select([version("a"), version("b")], version("a"));
    adapter.versions.mockRejectedValue(new Error("disk unavailable"));
    await service.loadForPlayback(playback("a"));
    expect(service.selection()?.versions).toHaveLength(2);
    expect(service.error()).toContain("disk unavailable");
  } finally {
    injector.destroy();
  }
});
it("does not attach movie alternatives to a live channel or a different series", async () => {
  const { adapter, injector, service } = setup();
  try {
    service.select([version("a"), version("b")], version("a"));
    await service.loadForPlayback({ ...playback("a"), isLive: true });
    expect(adapter.versions).not.toHaveBeenCalled();
    expect(service.selection()).toBeNull();
  } finally {
    injector.destroy();
  }
});

it("version playback is an exact, one-shot request rather than a normal details visit", () => {
  const { service, injector } = setup();
  try {
    expect(service.requestPlayback(version("b"))).toBe(true);
    expect(service.takePlaybackRequest(version("a").identity)).toBeNull();
    expect(
      service.takePlaybackRequest(version("b").identity)?.version.identity
        .playlistId,
    ).toBe("b");
    expect(service.takePlaybackRequest(version("b").identity)).toBeNull();
    service.requestPlayback(version("b"));
    service.cancelPlaybackRequest();
    expect(service.takePlaybackRequest(version("b").identity)).toBeNull();
  } finally {
    injector.destroy();
  }
});
it("series switching requires exact season and episode numbers and carries no episode IDs across providers", () => {
  const { service, injector } = setup();
  try {
    const series = {
      ...version("b"),
      contentType: "series" as const,
      identity: { ...version("b").identity, contentKind: "series" as const },
    };
    expect(service.requestPlayback(series)).toBe(false);
    expect(
      service.requestPlayback(series, {
        kind: "episode",
        title: "E2",
        seasonNumber: 1,
        episodeNumber: 2,
      }),
    ).toBe(true);
    expect(service.takePlaybackRequest(series.identity)?.episode).toEqual({
      seasonNumber: 1,
      episodeNumber: 2,
    });
  } finally {
    injector.destroy();
  }
});
