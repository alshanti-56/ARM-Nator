import { Injector } from "@angular/core";
import { of } from "rxjs";
import { PlaylistsService, PlaybackPositionService } from "@arm-nator/services";
import { StalkerSessionService } from "@arm-nator/providers/stalker/data-access";
import { AppPortalDiscoveryService } from "./portal-discovery.service";
import type {
  DiscoveryVersion,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
jest.mock("@arm-nator/providers/stalker/data-access", () => ({
  StalkerSessionService: class {},
}));
const version = (
  source: string,
  type: "xtream" | "stalker" = "xtream",
): DiscoveryVersion => ({
  identity: {
    sourceType: type,
    playlistId: source,
    contentKind: "vod",
    providerItemId: type === "stalker" ? "007" : "7",
  },
  providerName: source,
  originalTitle: "|FHD| Movie (2020)",
  categoryId: "42",
  contentType: "movie",
  work: { kind: "movie", title: "Movie", releaseYear: 2020 },
  navigation: [
    `/workspace/${type === "xtream" ? "xtreams" : "stalker"}`,
    source,
    "vod",
    "42",
    "007",
  ],
});
const playback: ResolvedPortalPlayback = {
  streamUrl: "http://fixture.invalid",
  title: "Movie",
  itemIdentity: version("a").identity,
  work: version("a").work,
};
function setup(saved: DiscoveryVersion[] = []) {
  let stored = JSON.stringify(saved);
  const bridge = {
    dbGetAppState: jest.fn(async () => stored),
    dbSetAppState: jest.fn(async (_key: string, value: string) => {
      stored = value;
      return { success: true };
    }),
    dbGetContentByXtreamId: jest
      .fn()
      .mockResolvedValue({
        id: 10,
        title: "|FHD| Movie (2020)",
        category_id: 999,
        xtream_id: 7,
        type: "movie",
        rating: null,
        added: null,
        poster_url: null,
      }),
    dbGlobalSearch: jest
      .fn()
      .mockResolvedValue(
        ["a", "b"].map((source) => ({
          id: source,
          source_type: "xtream",
          content_type: "movie",
          type: "movie",
          title: "|FHD| Movie (2020)",
          playlist_id: source,
          playlist_name: source,
          category_id: 42,
          xtream_id: 7,
          rating: null,
          added: null,
          poster_url: null,
        })),
      ),
  };
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: bridge,
  });
  const session = { makeAuthenticatedRequest: jest.fn() };
  const injector = Injector.create({
    providers: [
      AppPortalDiscoveryService,
      {
        provide: PlaylistsService,
        useValue: {
          getAllPlaylists: () =>
            of(["a", "b", "portal"].map((_id) => ({ _id, title: _id }))),
        },
      },
      {
        provide: PlaybackPositionService,
        useValue: { getViewingHistory: async () => [] },
      },
      { provide: StalkerSessionService, useValue: session },
    ],
  });
  return {
    service: injector.get(AppPortalDiscoveryService),
    injector,
    bridge,
    session,
    getStored: () => stored,
  };
}
it("category/history lookup uses local data and exact provider category links, never network sessions", async () => {
  const h = setup();
  try {
    const versions = await h.service.versions(playback, []);
    expect(versions.map((v) => v.identity.playlistId)).toEqual(
      expect.arrayContaining(["a", "b"]),
    );
    expect(
      versions.find((v) => v.identity.playlistId === "a")?.navigation,
    ).toEqual(["/workspace/xtreams", "a", "vod", "42", "7"]);
    expect(h.session.makeAuthenticatedRequest).not.toHaveBeenCalled();
  } finally {
    h.injector.destroy();
  }
});
it("remembers portal versions across service restart and ignores removed providers", async () => {
  const h = setup();
  try {
    await h.service.rememberVersions([
      version("portal", "stalker"),
      version("removed", "stalker"),
    ]);
    const saved = JSON.parse(h.getStored());
    const fresh = setup(saved);
    try {
      const versions = await fresh.service.versions(playback, []);
      expect(versions.some((v) => v.identity.playlistId === "portal")).toBe(
        true,
      );
      expect(versions.some((v) => v.identity.playlistId === "removed")).toBe(
        false,
      );
      expect(fresh.session.makeAuthenticatedRequest).not.toHaveBeenCalled();
    } finally {
      fresh.injector.destroy();
    }
  } finally {
    h.injector.destroy();
  }
});
it("reports failed persistence instead of claiming the choices were saved", async () => {
  const h = setup();
  try {
    h.bridge.dbSetAppState.mockResolvedValueOnce({ success: false });
    await expect(
      h.service.rememberVersions([version("portal", "stalker")]),
    ).rejects.toThrow("save version");
  } finally {
    h.injector.destroy();
  }
});
it("does not mix remakes from indexed results", async () => {
  const h = setup();
  try {
    const row = (await h.bridge.dbGlobalSearch())[0];
    h.bridge.dbGlobalSearch.mockResolvedValue([
      { ...row, playlist_id: "b", title: "Movie (1990)" },
    ]);
    const versions = await h.service.versions(playback, []);
    expect(versions).toHaveLength(1);
  } finally {
    h.injector.destroy();
  }
});
