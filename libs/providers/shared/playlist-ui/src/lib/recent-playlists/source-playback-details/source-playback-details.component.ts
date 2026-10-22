import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { MatIcon } from "@angular/material/icon";
import { TranslatePipe } from "@ngx-translate/core";
import { SOURCE_PLAYBACK_FACADE } from "@arm-nator/services";
import type {
  SourceAccountSnapshot,
  SourceEvidenceKey,
  SourcePlaybackSummary,
} from "@arm-nator/shared/interfaces";
@Component({
  selector: "app-source-playback-details",
  imports: [DatePipe, MatIcon, TranslatePipe],
  templateUrl: "./source-playback-details.component.html",
  styleUrl: "./source-playback-details.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourcePlaybackDetailsComponent {
  readonly summary = input.required<SourcePlaybackSummary>();
  readonly account = input<SourceAccountSnapshot | null>(null);
  readonly checkAgain = output<SourceEvidenceKey>();
  readonly checks = inject(SOURCE_PLAYBACK_FACADE, { optional: true });
  readonly displayedEvidence = computed(() => {
    const summary = this.summary();
    return summary.latestAttempt?.samples.length
      ? summary.latestAttempt
      : (summary.latest ?? summary.latestAttempt);
  });
  readonly samples = computed(() => this.displayedEvidence()?.samples ?? []);
  readonly checking = computed(() => {
    const a = this.checks?.activity();
    return (
      a?.key?.sourceId === this.summary().key.sourceId &&
      a.key.category === this.summary().key.category &&
      ["checking", "queued"].includes(a.state)
    );
  });
}
