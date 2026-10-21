import { TestBed } from "@angular/core/testing";
import { provideTranslateService } from "@ngx-translate/core";
import { PlaylistItemComponent } from "../playlist-item/playlist-item.component";
import {
  PortalStatusService,
  RuntimeCapabilitiesService,
} from "@arm-nator/services";
import { summarizeSourceEvidence } from "@arm-nator/shared/interfaces";
describe("source row evidence interaction", () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlaylistItemComponent],
      providers: [
        ...provideTranslateService(),
        {
          provide: RuntimeCapabilitiesService,
          useValue: { supportsXtreamSqliteDataSource: true },
        },
        {
          provide: PortalStatusService,
          useValue: {
            checkPortalStatus: async () => "active",
            getStatusClass: () => "",
            getStatusIcon: () => "",
          },
        },
      ],
    }).compileComponents();
  });
  function row() {
    const f = TestBed.createComponent(PlaylistItemComponent);
    f.componentRef.setInput("item", {
      _id: "one",
      title: "One",
      serverUrl: "https://example.test",
      username: "user",
      password: "pass",
      importDate: "2026-10-21",
      type: "xtream",
    });
    f.componentRef.setInput(
      "sourceEvidence",
      ["live", "movies", "series"].map((category) =>
        summarizeSourceEvidence(
          { sourceId: "one", revision: "r", category: category as "live" },
          [],
          null,
          Date.now(),
        ),
      ),
    );
    f.detectChanges();
    return f;
  }
  it("keeps source body navigation but expands disclosure and badges without navigating", () => {
    const f = row();
    const navigate = jest.fn();
    f.componentInstance.playlistClicked.subscribe(navigate);
    f.nativeElement.querySelector(".source-disclosure").click();
    f.detectChanges();
    expect(navigate).not.toHaveBeenCalled();
    expect(
      f.nativeElement
        .querySelector(".source-disclosure")
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(f.nativeElement.querySelector(".source-disclosure").tagName).toBe(
      "BUTTON",
    );
    f.nativeElement.querySelectorAll(".source-badge")[1].click();
    f.detectChanges();
    expect(f.componentInstance.expandedCategory()).toBe("movies");
    expect(navigate).not.toHaveBeenCalled();
    f.nativeElement.querySelector(".playlist-title").click();
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("preserves row actions and hides extra evidence in compact sidebar mode", () => {
    const f = row();
    const refresh = jest.fn(),
      edit = jest.fn(),
      remove = jest.fn(),
      navigate = jest.fn();
    f.componentInstance.refreshClicked.subscribe(refresh);
    f.componentInstance.editPlaylistClicked.subscribe(edit);
    f.componentInstance.removeClicked.subscribe(remove);
    f.componentInstance.playlistClicked.subscribe(navigate);
    f.nativeElement.querySelector(".refresh-btn").click();
    f.nativeElement.querySelector(".edit-btn").click();
    f.nativeElement.querySelector(".delete-btn").click();
    expect([
      refresh.mock.calls.length,
      edit.mock.calls.length,
      remove.mock.calls.length,
      navigate.mock.calls.length,
    ]).toEqual([1, 1, 1, 0]);
    f.componentRef.setInput("showActions", false);
    f.detectChanges();
    expect(f.nativeElement.querySelector(".source-results")).toBeNull();
  });
});
