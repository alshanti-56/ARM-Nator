import { TestBed } from "@angular/core/testing";
import { NativeCompositionService } from "@arm-nator/player/ui";
import { BrowserGuestHostService } from "./browser-guest-host.service";
import type { BrowserGuestSurfaceState } from "@arm-nator/shared/interfaces";

describe("persistent browser guest host", () => {
  let update: (states: BrowserGuestSurfaceState[]) => void;
  let register: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    register = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: {
        registerBrowserGuest: register,
        onBrowserGuestSurfaces: (callback: typeof update) => {
          update = callback;
          return () => undefined;
        },
      },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: NativeCompositionService, useValue: { enabled: true } },
      ],
    });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    jest.useRealTimers();
  });
  it("coalesces attachment and retains a parked guest across routes", async () => {
    const host = TestBed.inject(BrowserGuestHostService);
    const ready = host.ensure("youtube");
    expect(host.ensure("youtube")).toBe(ready);
    const key = host.entries()[0].key;
    await host.attached(key, 9);
    await ready;
    const parked = {
      id: 9,
      mode: "youtube" as const,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      visible: false,
    };
    update([parked]);
    expect(host.entries()[0].surface?.visible).toBe(false);
    await host.ensure("youtube");
    expect(register).toHaveBeenCalledTimes(1);
    update([
      {
        ...parked,
        visible: true,
        bounds: { x: 20, y: 30, width: 400, height: 200 },
      },
    ]);
    expect(host.entries()[0].surface?.bounds.width).toBe(400);
    update([]);
    expect(host.entries()).toHaveLength(0);
    const replacement = host.ensure("youtube");
    expect(host.entries()[0].key).not.toBe(key);
    await host.attached(host.entries()[0].key, 10);
    await replacement;
  });
  it("times out attachment and ignores late events from the removed tag", async () => {
    const host = TestBed.inject(BrowserGuestHostService);
    const promise = host.ensure("browser");
    const rejection = expect(promise).rejects.toThrow("did not attach");
    const key = host.entries()[0].key;
    jest.advanceTimersByTime(7000);
    await rejection;
    await host.attached(key, 20);
    expect(register).not.toHaveBeenCalled();
    expect(host.entries()).toEqual([]);
  });
  it("keeps a pending second mode during another guest update", async () => {
    const host = TestBed.inject(BrowserGuestHostService);
    const browser = host.ensure("browser");
    await host.attached(host.entries()[0].key, 1);
    await browser;
    const youtube = host.ensure("youtube");
    const key = host.entries()[1].key;
    update([
      {
        id: 1,
        mode: "browser",
        bounds: { x: 0, y: 0, width: 900, height: 500 },
        visible: true,
      },
    ]);
    expect(host.entries()).toHaveLength(2);
    await host.attached(key, 2);
    await youtube;
  });
});
