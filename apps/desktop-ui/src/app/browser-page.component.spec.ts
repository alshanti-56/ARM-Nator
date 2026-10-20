import { TestBed } from "@angular/core/testing";
import { ActivatedRoute, Router } from "@angular/router";
import { BrowserPageComponent } from "./browser-page.component";
import { BrowserGuestHostService } from "./browser-guest-host.service";
import type { BrowserViewState } from "@arm-nator/shared/interfaces";

describe("browser page attachment bounds", () => {
  it("sizes a newly attached surface before its initial navigation completes", async () => {
    let update!: (state: BrowserViewState) => void;
    const setBounds = jest.fn();
    const state: BrowserViewState = {
      id: "main-browser-view",
      mode: "browser",
      displayMode: "full",
      url: "about:blank#arm-nator-browser",
      title: "",
      status: "loading",
      canGoBack: false,
      canGoForward: false,
      isMuted: false,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      isFullscreen: false,
    };
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        onBrowserViewUpdate: (callback: typeof update) => {
          update = callback;
          return () => undefined;
        },
        openBrowserView: () => {
          update(state);
          return new Promise(() => undefined);
        },
        setBrowserViewBounds: setBounds,
        closeBrowserView: jest.fn(),
      },
    });
    const priorObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() { return undefined; }
      disconnect() { return undefined; }
    } as unknown as typeof ResizeObserver;
    TestBed.configureTestingModule({
      providers: [
        { provide: ActivatedRoute, useValue: { snapshot: { data: {} } } },
        { provide: Router, useValue: { navigateByUrl: jest.fn() } },
        {
          provide: BrowserGuestHostService,
          useValue: {
            ensure: () => Promise.resolve(),
            cancelPending: jest.fn(),
          },
        },
      ],
    });
    const page = TestBed.runInInjectionContext(
      () => new BrowserPageComponent(),
    );
    const bounds = { left: 70, top: 150, width: 1000, height: 600 };
    Object.defineProperty(page, "viewport", {
      value: () => ({ nativeElement: { getBoundingClientRect: () => bounds } }),
    });
    try {
      page.ngAfterViewInit();
      await Promise.resolve();
      // A bounds request sent before a surface exists is ignored by the backend.
      // A loading update must resend it even if the DOM rectangle has not changed.
      expect(setBounds.mock.calls.at(-1)?.[0]).toEqual({
        x: 70,
        y: 150,
        width: 1000,
        height: 600,
      });
      expect(setBounds.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      page.ngOnDestroy();
      globalThis.ResizeObserver = priorObserver;
      TestBed.resetTestingModule();
    }
  });
});
