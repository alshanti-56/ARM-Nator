import { TestBed } from "@angular/core/testing";
import { provideTranslateService } from "@ngx-translate/core";
import { SourcePlaybackDetailsComponent } from "./source-playback-details.component";
import { summarizeSourceEvidence } from "@arm-nator/shared/interfaces";
describe("playback check details", () => {
  it("does not claim verification from an empty history or enable unavailable checks", async () => {
    await TestBed.configureTestingModule({
      imports: [SourcePlaybackDetailsComponent],
      providers: provideTranslateService(),
    }).compileComponents();
    const f = TestBed.createComponent(SourcePlaybackDetailsComponent);
    f.componentRef.setInput(
      "summary",
      summarizeSourceEvidence(
        { sourceId: "one", revision: "r", category: "live" },
        [],
        null,
        Date.now(),
      ),
    );
    f.detectChanges();
    expect(f.nativeElement.querySelector("button").disabled).toBe(true);
    expect(f.nativeElement.querySelectorAll(".sample-row").length).toBe(0);
  });
});

it("retains the saved samples when a later discovery attempt has no samples", async () => {
  await TestBed.configureTestingModule({
    imports: [SourcePlaybackDetailsComponent],
    providers: provideTranslateService(),
  }).compileComponents();
  const f = TestBed.createComponent(SourcePlaybackDetailsComponent);
  const key = { sourceId: "one", revision: "r", category: "live" as const };
  const sample = {
    itemId: "1",
    title: "Previously played",
    outcome: "played" as const,
    reason: null,
    elapsedMs: 6500,
    engine: "html5",
    audioOnly: false,
  };
  f.componentRef.setInput(
    "summary",
    summarizeSourceEvidence(
      key,
      [
        {
          checkId: "success",
          key,
          origin: "manual",
          startedAt: 1,
          completedAt: 6501,
          successfulAt: 6501,
          result: "verified",
          samples: [sample],
        },
      ],
      {
        checkId: "offline",
        key,
        origin: "manual",
        startedAt: 7000,
        completedAt: 8000,
        samples: [],
        reason: "network-unknown",
      },
      8000,
    ),
  );
  f.detectChanges();
  expect(f.nativeElement.querySelectorAll(".sample-row").length).toBe(1);
  expect(f.nativeElement.textContent).toContain("Previously played");
  expect(
    f.nativeElement.querySelector('[role="status"]').textContent,
  ).toContain("network-unknown");
});
