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
