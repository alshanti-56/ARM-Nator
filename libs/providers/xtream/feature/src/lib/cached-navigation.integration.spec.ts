import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { Router } from "@angular/router";
import { Subject } from "rxjs";
import { PlaylistContextFacade } from "@arm-nator/providers/shared/playlist-util";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { XtreamWorkspaceRouteSession } from "./xtream-workspace-route-session.service";

describe("cached section navigation after successful authentication", () => {
  afterEach(() => TestBed.resetTestingModule());
  it.each(["vod", "live", "series"])(
    "hydrates the cached %s section when another section is already initialized",
    async (section) => {
      const playlist = {
        id: "source",
        name: "Source",
        serverUrl: "http://fixture.invalid",
        username: "fixture",
        password: "fixture",
      };
      let ready = false;
      const store = {
        playlistId: signal("source"),
        currentPlaylist: signal(playlist),
        portalStatus: signal("active"),
        contentInitBlockReason: signal(null),
        isContentInitialized: signal(true),
        contentLoadStateByType: signal({
          vod: "ready",
          live: "idle",
          series: "idle",
          [section]: "idle",
        }),
        isCachedContentScopeReady: jest.fn(() => ready),
        hasUsableOfflineCache: jest.fn(async () => true),
        hydrateCachedContent: jest.fn(async () => {
          ready = true;
        }),
        initializeContent: jest.fn(async () => undefined),
        setSelectedContentType: jest.fn(),
        setSelectedCategory: jest.fn(),
      };
      TestBed.configureTestingModule({
        providers: [
          XtreamWorkspaceRouteSession,
          {
            provide: Router,
            useValue: {
              url: `/workspace/xtreams/source/${section}`,
              events: new Subject(),
            },
          },
          {
            provide: PlaylistContextFacade,
            useValue: {
              routeProvider: signal(null),
              routePlaylistId: signal(null),
              activePlaylist: signal({ ...playlist, _id: "source" }),
              syncFromUrl: () => ({
                provider: "xtreams",
                playlistId: "source",
                section,
              }),
            },
          },
          { provide: XtreamStore, useValue: store },
        ],
      });
      TestBed.inject(XtreamWorkspaceRouteSession);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(store.hydrateCachedContent).toHaveBeenCalledWith(section);
      expect(store.initializeContent).not.toHaveBeenCalled();
    },
  );
});
