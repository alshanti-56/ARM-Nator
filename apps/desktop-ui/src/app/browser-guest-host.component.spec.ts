import { TestBed } from "@angular/core/testing";
import { BrowserGuestHostComponent } from "./browser-guest-host.component";
import { BrowserGuestHostService } from "./browser-guest-host.service";
import { signal } from "@angular/core";

it("fills the CSS viewport throughout a guest fullscreen transition", () => {
  const surface = {
    id: 1,
    mode: "youtube",
    visible: true,
    isFullscreen: true,
    bounds: { x: 0, y: 0, width: 400, height: 240 },
  };
  const entries = signal([{ key: 1, mode: "youtube", seen: true, surface }]);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: BrowserGuestHostService,
        useValue: {
          entries,
          composition: { sceneClip: () => "none" },
          attached: jest.fn(),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(BrowserGuestHostComponent);
  fixture.detectChanges();
  const guest = fixture.nativeElement.querySelector("webview") as HTMLElement;
  expect(guest.style.width).toBe("100vw");
  expect(guest.style.height).toBe("100vh");
  entries.set([
    {
      key: 1,
      mode: "youtube",
      seen: true,
      surface: { ...surface, isFullscreen: false },
    },
  ]);
  fixture.detectChanges();
  expect(guest.style.width).toBe("400px");
  expect(guest.style.height).toBe("240px");
});
