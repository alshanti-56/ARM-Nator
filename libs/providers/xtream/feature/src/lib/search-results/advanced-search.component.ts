import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { CdkConnectedOverlay, CdkOverlayOrigin } from "@angular/cdk/overlay";
import { CdkTrapFocus } from "@angular/cdk/a11y";
import { MatIcon } from "@angular/material/icon";
import {
  STRUCTURED_SEARCH_GENRE_OPTIONS,
  structuredSearchYearOptions,
} from "./structured-search.util";

export interface AdvancedSearchFields {
  title: string;
  actor: string;
  year: string;
  genre: string;
}
const emptyFields = (): AdvancedSearchFields => ({
  title: "",
  actor: "",
  year: "",
  genre: "",
});

@Component({
  selector: "app-advanced-search",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    CdkTrapFocus,
    MatIcon,
  ],
  template: ` <button
      #trigger
      cdkOverlayOrigin
      #origin="cdkOverlayOrigin"
      type="button"
      class="advanced-trigger"
      [class.active]="active()"
      [attr.aria-expanded]="opened()"
      aria-haspopup="dialog"
      (click)="toggle()"
    >
      <mat-icon>tune</mat-icon> Advanced search
    </button>
    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOrigin]="origin"
      [cdkConnectedOverlayOpen]="opened()"
      [cdkConnectedOverlayHasBackdrop]="true"
      cdkConnectedOverlayBackdropClass="cdk-overlay-transparent-backdrop"
      [cdkConnectedOverlayPush]="true"
      [cdkConnectedOverlayViewportMargin]="16"
      [cdkConnectedOverlayOffsetY]="12"
      [cdkConnectedOverlayPositions]="positions"
      (backdropClick)="close()"
      (overlayKeydown)="onKey($event)"
    >
      <section
        class="advanced-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="advanced-heading"
        cdkTrapFocus
        [cdkTrapFocusAutoCapture]="true"
      >
        <div class="advanced-heading">
          <h2 id="advanced-heading">Advanced search</h2>
          <button
            type="button"
            class="close-button"
            aria-label="Close Advanced search"
            (click)="close()"
          >
            <mat-icon>close</mat-icon>
          </button>
        </div>
        <p>
          Find movies and series by title, actor, year or genre. TMDB matches
          are checked against your sources.
        </p>
        <form class="advanced-search-form" (ngSubmit)="submit()">
          <div class="advanced-fields">
            <label
              >Title<input
                name="advanced-title"
                cdkFocusInitial
                placeholder="Movie or series title"
                [(ngModel)]="draft.title"
            /></label>
            <label
              >Actor<input
                name="advanced-actor"
                placeholder="Actor’s name"
                [(ngModel)]="draft.actor"
            /></label>
            <label
              >Year<select name="advanced-year" [(ngModel)]="draft.year">
                <option value="">Any year</option>
                @for (year of years; track year) {
                  <option [value]="year">{{ year }}</option>
                }
              </select></label
            >
            <label
              >Genre<select name="advanced-genre" [(ngModel)]="draft.genre">
                <option value="">Any genre</option>
                @for (genre of genres; track genre.value) {
                  <option [value]="genre.value">{{ genre.label }}</option>
                }
              </select></label
            >
          </div>
          <p class="advanced-hint">
            Enter at least two characters in Title or Actor. Portal searching
            remains a separate action.
          </p>
          <div class="advanced-actions">
            <button type="button" (click)="clear()">Clear</button>
            <button
              type="submit"
              class="primary"
              [disabled]="
                draft.title.trim().length < 2 && draft.actor.trim().length < 2
              "
            >
              Search sources
            </button>
          </div>
        </form>
      </section>
    </ng-template>`,
  styles: [
    `
      :host {
        display: inline-block;
      }
      button,
      input,
      select {
        font: inherit;
      }
      button {
        cursor: pointer;
      }
      .advanced-trigger {
        display: flex;
        align-items: center;
        gap: 7px;
        border: 1px solid var(--app-separator, #dce0e7);
        border-radius: 9px;
        background: var(--app-widget-bg, #fff);
        color: var(--app-on-surface, #1a1d23);
        padding: 10px 13px;
        font-size: 13px;
        white-space: nowrap;
      }
      .advanced-trigger.active {
        color: var(--app-selection-color, #2f7bff);
        border-color: var(--app-selection-color, #2f7bff);
      }
      mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }
      .advanced-panel {
        box-sizing: border-box;
        width: min(490px, calc(100vw - 32px));
        padding: 24px;
        border-radius: 14px;
        border: 1px solid var(--app-separator, #dce0e7);
        background: var(
          --mat-sys-surface-container-lowest,
          var(--app-widget-bg, #fff)
        );
        color: var(--app-on-surface, #1a1d23);
        box-shadow: 0 14px 48px #0003;
      }
      .advanced-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      h2 {
        font-size: 20px;
        margin: 0;
        font-weight: 650;
      }
      .close-button {
        border: 0;
        background: transparent;
        color: inherit;
        padding: 6px;
        display: flex;
        border-radius: 6px;
      }
      p {
        font-size: 13px;
        line-height: 1.6;
        color: var(--app-body-color, #4a5060);
        margin: 10px 0 20px;
      }
      .advanced-fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px 16px;
      }
      label {
        font-size: 13px;
        font-weight: 600;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      input,
      select {
        box-sizing: border-box;
        width: 100%;
        border: 1px solid var(--app-separator, #dce0e7);
        border-radius: 8px;
        padding: 11px;
        background: var(--app-widget-bg, #fff);
        color: inherit;
        min-width: 0;
        font-size: 13px;
      }
      .advanced-hint {
        font-size: 11px;
        margin-bottom: 18px;
      }
      .advanced-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        border-top: 1px solid var(--app-separator, #dce0e7);
        padding-top: 18px;
      }
      .advanced-actions button {
        border: 1px solid var(--app-separator, #dce0e7);
        background: transparent;
        color: inherit;
        padding: 10px 16px;
        border-radius: 8px;
        font-size: 13px;
      }
      .advanced-actions .primary {
        background: var(--app-selection-color, #2f7bff);
        color: var(--app-selection-on-color, #fff);
        border-color: transparent;
      }
      button:disabled {
        opacity: 0.5;
        cursor: default;
      }
      :is(button, input, select):focus-visible {
        outline: 2px solid var(--app-selection-color, #2f7bff);
        outline-offset: 3px;
      }
      @media (max-width: 480px) {
        .advanced-panel {
          padding: 18px;
        }
        .advanced-fields {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class AdvancedSearchComponent {
  readonly value = input<AdvancedSearchFields>(emptyFields());
  readonly active = input(false);
  readonly submitted = output<AdvancedSearchFields>();
  readonly opened = signal(false);
  readonly trigger = viewChild<ElementRef<HTMLButtonElement>>("trigger");
  readonly years = structuredSearchYearOptions();
  readonly genres = STRUCTURED_SEARCH_GENRE_OPTIONS;
  readonly positions = [
    {
      originX: "end" as const,
      originY: "bottom" as const,
      overlayX: "end" as const,
      overlayY: "top" as const,
    },
    {
      originX: "end" as const,
      originY: "top" as const,
      overlayX: "end" as const,
      overlayY: "bottom" as const,
    },
  ];
  draft = emptyFields();
  toggle(): void {
    if (this.opened()) this.close();
    else {
      this.draft = { ...this.value() };
      this.opened.set(true);
    }
  }
  close(): void {
    this.opened.set(false);
    this.trigger()?.nativeElement.focus();
  }
  clear(): void {
    this.draft = emptyFields();
  }
  submit(): void {
    if (
      this.draft.title.trim().length < 2 &&
      this.draft.actor.trim().length < 2
    )
      return;
    this.submitted.emit({ ...this.draft });
    this.close();
  }
  onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }
}
