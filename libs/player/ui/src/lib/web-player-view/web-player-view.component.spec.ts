import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { StorageMap } from "@ngx-pwa/local-storage";
import { of } from "rxjs";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import type { ResolvedPortalPlayback } from "@arm-nator/shared/interfaces";
import { WorkspacePlayerStateService } from "../workspace-player/workspace-player-state.service";
import { WebPlayerViewComponent } from "./web-player-view.component";

function mountView(playback: ResolvedPortalPlayback, setUserAgent: jest.Mock) {
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: { setUserAgent },
  });
  TestBed.configureTestingModule({
    imports: [WebPlayerViewComponent],
    providers: [
      { provide: StorageMap, useValue: { get: () => of(undefined) } },
      { provide: RuntimeCapabilitiesService, useValue: {} },
      { provide: SettingsStore, useValue: {} },
      {
        provide: WorkspacePlayerStateService,
        useValue: {
          recoveryCountdown: signal(0),
          recovery: { identity: { selectionId: -1 } },
        },
      },
    ],
  });
  TestBed.overrideComponent(WebPlayerViewComponent, { set: { template: "" } });
  const fixture = TestBed.createComponent(WebPlayerViewComponent);
  fixture.componentRef.setInput("streamUrl", playback.streamUrl);
  fixture.componentRef.setInput("playback", playback);
  fixture.detectChanges();
  return fixture;
}

describe("WebPlayerViewComponent request header scope", () => {
  const previousElectron = Object.getOwnPropertyDescriptor(window, "electron");

  afterEach(() => {
    TestBed.resetTestingModule();
    if (previousElectron) {
      Object.defineProperty(window, "electron", previousElectron);
    } else {
      delete (window as Window & { electron?: unknown }).electron;
    }
  });

  it("scopes provider request headers to the original URL when playback uses a local proxy", async () => {
    const setUserAgent = jest.fn().mockResolvedValue(true);
    const playback: ResolvedPortalPlayback = {
      streamUrl: "http://127.0.0.1:54690/stream/session/resource",
      originalStreamUrl: "https://provider.example/live/channel.ts",
      title: "Channel",
      userAgent: "ProviderPlayer/1.0",
      referer: "https://provider.example/portal/",
    };
    const fixture = mountView(playback, setUserAgent);
    await fixture.whenStable();

    expect(setUserAgent).toHaveBeenCalledWith(
      "ProviderPlayer/1.0",
      "https://provider.example/portal/",
      playback.originalStreamUrl,
    );
    fixture.destroy();
  });

  it("keeps direct playback scoped to its provider URL", async () => {
    const setUserAgent = jest.fn().mockResolvedValue(true);
    const playback: ResolvedPortalPlayback = {
      streamUrl: "https://provider.example/live/direct.ts",
      title: "Channel",
      userAgent: "ProviderPlayer/1.0",
      referer: "https://provider.example/portal/",
    };
    const fixture = mountView(playback, setUserAgent);
    await fixture.whenStable();

    expect(setUserAgent).toHaveBeenCalledWith(
      "ProviderPlayer/1.0",
      "https://provider.example/portal/",
      playback.streamUrl,
    );
    fixture.destroy();
  });
});
