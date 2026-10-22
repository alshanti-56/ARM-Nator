import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
} from "@angular/core";
import { TranslatePipe } from "@ngx-translate/core";
import type { ContentMetadataSource } from "@arm-nator/shared/interfaces";

@Component({
  selector: "app-metadata-source-toggle",
  imports: [TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="source-label">{{ "XTREAM.METADATA.SOURCE" | translate }}</span>
    <div
      class="source-options"
      role="group"
      [attr.aria-label]="'XTREAM.METADATA.SOURCE' | translate"
    >
      <button
        type="button"
        [attr.aria-pressed]="active() === 'tmdb'"
        [disabled]="!hasTmdb()"
        (click)="source.set('tmdb')"
      >
        TMDB
      </button>
      <button
        type="button"
        [attr.aria-pressed]="active() === 'provider'"
        (click)="source.set('provider')"
      >
        {{ "XTREAM.METADATA.PROVIDER" | translate }}
      </button>
    </div>
    @if (!hasTmdb()) {
      <small>{{ "XTREAM.METADATA.PROVIDER_ONLY" | translate }}</small>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        flex: 1 0 100%;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin: 0 0 6px;
        font-size: 0.75rem;
      }
      .source-label,
      small {
        color: var(--app-muted-color);
      }
      .source-options {
        display: inline-flex;
        padding: 3px;
        gap: 2px;
        border: 1px solid var(--app-search-border);
        border-radius: 9px;
        background: var(--app-search-bg);
      }
      button {
        font: inherit;
        font-weight: 500;
        color: var(--app-body-color);
        background: transparent;
        border: 1px solid transparent;
        border-radius: 6px;
        min-height: 30px;
        padding: 4px 12px;
        cursor: pointer;
      }
      button[aria-pressed="true"] {
        color: var(--app-selection-color);
        background: var(--app-selection-surface);
        border-color: var(--app-selection-border);
      }
      button:hover:not(:disabled) {
        background: var(--app-selection-surface);
      }
      button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      button:focus-visible {
        outline: 2px solid var(--app-selection-color);
        outline-offset: 2px;
      }
      @media (pointer: coarse) {
        button {
          min-height: 44px;
        }
      }
    `,
  ],
})
export class MetadataSourceToggleComponent {
  readonly source = model.required<ContentMetadataSource>();
  readonly hasTmdb = input(false);
  readonly active = computed(() =>
    this.hasTmdb() && this.source() === "tmdb" ? "tmdb" : "provider",
  );
}
