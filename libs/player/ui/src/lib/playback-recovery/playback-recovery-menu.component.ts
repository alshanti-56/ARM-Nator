import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  viewChild,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatMenu, MatMenuModule } from "@angular/material/menu";
import { TranslatePipe } from "@ngx-translate/core";
import type {
  RecoveryAction,
  RecoveryEngine,
  RecoverySelection,
} from "./playback-recovery-actions";

@Component({
  selector: "app-playback-recovery-menu",
  imports: [MatButtonModule, MatIconModule, MatMenuModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .recovery-label {
        display: flex;
        flex-direction: column;
        white-space: normal;
        line-height: 1.4;
        padding: 8px 0;
      }
      .recovery-reason {
        font-size: 12px;
        opacity: 0.8;
      }
    `,
  ],
  template: `
    @if (showTrigger()) {
    <button
      mat-button
      type="button"
      data-test-id="playback-retry"
      [matMenuTriggerFor]="recoveryMenu"
      [disabled]="busy()"
    >
      <mat-icon>refresh</mat-icon
      >{{ "PLAYBACK_DIAGNOSTICS.ACTION_RETRY" | translate
      }}<mat-icon>arrow_drop_down</mat-icon>
    </button>
    }
    <mat-menu #recoveryMenu="matMenu">
      @for (action of actions(); track action.id) {
        @if (action.id === "engine") {
          <button
            mat-menu-item
            [matMenuTriggerFor]="engineMenu"
            [disabled]="!action.enabled"
          >
            <span class="recovery-label"
              >{{ action.labelKey | translate }}
              @if (action.suggested) {
                <small>{{ "PLAYBACK_RECOVERY.SUGGESTED" | translate }}</small>
              }
              @if (action.reasonKey) {
                <small class="recovery-reason">{{
                  action.reasonKey | translate
                }}</small>
              }
            </span>
          </button>
        } @else if (action.id === "help") {
          <button mat-menu-item [matMenuTriggerFor]="helpMenu">
            {{ action.labelKey | translate }}
          </button>
        } @else {
          <button
            mat-menu-item
            [disabled]="!action.enabled"
            [attr.data-recovery-action]="action.id"
            (click)="selected.emit({ id: action.id })"
          >
            <span class="recovery-label"
              >{{ action.labelKey | translate }}
              @if (action.suggested) {
                <small>{{ "PLAYBACK_RECOVERY.SUGGESTED" | translate }}</small>
              }
              @if (action.reasonKey) {
                <small class="recovery-reason">{{
                  action.reasonKey | translate
                }}</small>
              }
            </span>
          </button>
        }
      }
    </mat-menu>
    <mat-menu #engineMenu="matMenu">
      @for (engine of engines(); track engine.id) {
        <button
          mat-menu-item
          [disabled]="!engine.available"
          (click)="selected.emit({ id: 'engine', engine: engine.id })"
        >
          <span class="recovery-label"
            >{{ engine.labelKey | translate }}
            @if (!engine.available) {
              <small class="recovery-reason">{{ engine.detail }}</small>
            }
          </span>
        </button>
      }
    </mat-menu>
    <mat-menu #helpMenu="matMenu">
      @for (cause of causes; track cause) {
        <button mat-menu-item (click)="helpSelected.emit(cause)">
          <span class="recovery-label">{{
            "PLAYBACK_RECOVERY.CAUSE_" + cause | translate
          }}</span>
        </button>
      }
    </mat-menu>
  `,
})
export class PlaybackRecoveryMenuComponent {
  readonly showTrigger = input(true);
  readonly menu = viewChild<MatMenu>("recoveryMenu");
  readonly actions = input.required<readonly RecoveryAction[]>();
  readonly engines = input<readonly RecoveryEngine[]>([]);
  readonly busy = input(false);
  readonly selected = output<RecoverySelection>();
  readonly helpSelected = output<string>();
  readonly causes = [
    "ACCOUNT",
    "LIMIT",
    "NETWORK",
    "CHALLENGE",
    "LOCATION",
    "CODEC",
  ];
}
