import { TestBed } from "@angular/core/testing";
import { signal } from "@angular/core";
import { Router } from "@angular/router";
import { provideTranslateService } from "@ngx-translate/core";
import { SourcePlaybackStoreService } from "@arm-nator/services";
import { summarizeSourceEvidence } from "@arm-nator/shared/interfaces";
import { SourcePlaybackCompactComponent } from "./source-playback-compact.component";
it("uses saved category results, updates reactively and opens their Sources filter without selecting the playlist", async () => {
  const summaries = signal(
    ["live", "movies", "series"].map((category) =>
      summarizeSourceEvidence(
        { sourceId: "one", revision: "r", category: category as "live" },
        [],
        null,
        Date.now(),
      ),
    ),
  );
  const setFilter = jest.fn(),
    navigate = jest.fn(async () => true);
  await TestBed.configureTestingModule({
    imports: [SourcePlaybackCompactComponent],
    providers: [
      provideTranslateService(),
      { provide: Router, useValue: { navigate } },
      {
        provide: SourcePlaybackStoreService,
        useValue: { summariesFor: () => summaries(), setFilter },
      },
    ],
  }).compileComponents();
  const f = TestBed.createComponent(SourcePlaybackCompactComponent);
  f.componentRef.setInput("sourceId", "one");
  f.componentRef.setInput("title", "Fixture");
  f.detectChanges();
  expect(f.nativeElement.querySelectorAll("button").length).toBe(3);
  expect(
    f.nativeElement.querySelector('[data-result="untested"]'),
  ).toBeTruthy();
  summaries.update((rows) =>
    rows.map((r, i) => ({
      ...r,
      result: i === 0 ? "verified" : i === 1 ? "failed" : "mixed",
      stale: i === 0,
    })),
  );
  f.detectChanges();
  const button = f.nativeElement.querySelector('[data-result="verified"]');
  expect(button.classList.contains("stale")).toBe(true);
  expect(button.getAttribute("aria-label")).toContain("STALE");
  const selected = jest.fn();
  f.nativeElement.addEventListener("click", selected);
  button.click();
  expect(selected).not.toHaveBeenCalled();
  expect(setFilter).toHaveBeenCalledWith({ category: "live", result: "any" });
  expect(navigate).toHaveBeenCalledWith(["/workspace/sources"], {
    queryParams: { q: "Fixture" },
  });
});
