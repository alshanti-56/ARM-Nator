import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from "@angular/core";
import { DatePipe } from "@angular/common";
import { Router } from "@angular/router";
import { MatIcon } from "@angular/material/icon";
import { MatTooltip } from "@angular/material/tooltip";
import { TranslateService, TranslatePipe } from "@ngx-translate/core";
import { normalizeDateLocale } from "@arm-nator/pipes";
import { SourcePlaybackStoreService } from "@arm-nator/services";
import type {
  SourcePlaybackCategory,
  SourcePlaybackSummary,
} from "@arm-nator/shared/interfaces";
@Component({
  selector: "app-source-playback-compact",
  imports: [MatIcon, MatTooltip, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="compact-results">
    @for (summary of summaries(); track summary.key.category) {
      <button
        type="button"
        [attr.data-result]="summary.result"
        [class.stale]="summary.stale"
        [attr.aria-label]="label(summary)"
        [matTooltip]="label(summary)"
        (click)="openResult($event, summary.key.category)"
      >
        <mat-icon aria-hidden="true">{{
          summary.result === "verified"
            ? "check_circle"
            : summary.result === "failed"
              ? "cancel"
              : summary.result === "untested"
                ? "help_outline"
                : "warning"
        }}</mat-icon>
        <span>{{
          "WORKSPACE.SOURCES.PLAYBACK.CATEGORY_" +
            summary.key.category.toUpperCase() | translate
        }}</span>
        @if (summary.stale) {
          <span aria-hidden="true">·</span>
        }
      </button>
    }
  </div>`,
  styles: [
    `
      :host {
        display: block;
        margin-top: 5px;
      }
      .compact-results {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      button {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        min-height: 24px;
        padding: 2px 5px;
        border: 1px solid color-mix(in srgb, currentColor 24%, transparent);
        border-radius: 6px;
        background: color-mix(in srgb, currentColor 7%, transparent);
        color: var(--mat-sys-on-surface-variant);
        font: inherit;
        font-size: 10px;
        white-space: nowrap;
        cursor: pointer;
      }
      mat-icon {
        height: 12px;
        width: 12px;
        font-size: 12px;
      }
      button[data-result="verified"] {
        color: var(--app-success-color, #72cd96);
      }
      button[data-result="failed"] {
        color: var(--mat-sys-error);
      }
      button[data-result="mixed"],
      button[data-result="unstable"] {
        color: var(--app-rating-color, #e8bb62);
      }
      button.stale {
        opacity: 0.65;
      }
      button:focus-visible {
        outline: 2px solid var(--app-selection-color);
        outline-offset: 2px;
      }
    `,
  ],
})
export class SourcePlaybackCompactComponent {
  readonly sourceId = input.required<string>();
  readonly title = input.required<string>();
  readonly resultOpened = output<void>();
  private readonly evidence = inject(SourcePlaybackStoreService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  readonly summaries = computed(() =>
    this.evidence.summariesFor(this.sourceId()),
  );
  categoryLabel(category: SourcePlaybackCategory): string {
    return this.translate.instant(
      "WORKSPACE.SOURCES.PLAYBACK.CATEGORY_" + category.toUpperCase(),
    );
  }
  label(summary: SourcePlaybackSummary): string {
    const prefix = "WORKSPACE.SOURCES.PLAYBACK.";
    const checked =
      summary.latestAttempt?.completedAt ?? summary.latest?.completedAt;
    return [
      this.categoryLabel(summary.key.category),
      this.translate.instant(prefix + "RESULT_" + summary.result.toUpperCase()),
      summary.stale ? this.translate.instant(prefix + "STALE") : null,
      checked
        ? new DatePipe(
            normalizeDateLocale(this.translate.getCurrentLang() || "en"),
          ).transform(checked, "short")
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  openResult(event: Event, category: SourcePlaybackCategory): void {
    event.stopPropagation();
    this.evidence.setFilter({ category, result: "any" });
    void this.router.navigate(["/workspace/sources"], {
      queryParams: { q: this.title() },
    });
    this.resultOpened.emit();
  }
}
