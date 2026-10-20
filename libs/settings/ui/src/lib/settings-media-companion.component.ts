import { CommonModule } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
} from "@angular/core";
import { FormGroup, ReactiveFormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatInputModule } from "@angular/material/input";
import {
  MediaCompanionClient,
  MediaCompanionCapabilities,
  MediaCompanionError,
  mediaCompanionCredentials,
} from "@arm-nator/player/core";

@Component({
  selector: "app-settings-media-companion",
  imports: [
    CommonModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule,
  ],
  template: `
    <div class="settings-media-companion" [formGroup]="form()">
    <div class="setting-item" data-test-id="media-companion-enabled-setting">
      <div class="setting-item__meta">
        <h4>Media companion</h4>
        <p>Use a paired media companion for optional playback preparation.</p>
      </div>
      <div class="setting-item__control setting-item__toggle">
        <mat-checkbox
          aria-label="Enable media companion"
          formControlName="enabled"
          data-test-id="media-companion-enabled"
        ></mat-checkbox>
      </div>
    </div>

    <div class="setting-item" data-test-id="media-companion-endpoint-setting">
      <div class="setting-item__meta">
        <h4>Companion address</h4>
        <p>Enter the address of the media companion service.</p>
      </div>
      <div class="setting-item__control">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>HTTP or HTTPS address</mat-label>
          <input
            matInput
            type="url"
            formControlName="baseUrl"
            autocomplete="url"
            data-test-id="media-companion-base-url"
          />
        </mat-form-field>
      </div>
    </div>

    <div class="setting-item" data-test-id="media-companion-conversion-setting">
      <div class="setting-item__meta">
        <h4>Allow conversion</h4>
        <p>Permit conversion when direct playback and remuxing are unavailable.</p>
      </div>
      <div class="setting-item__control setting-item__toggle">
        <mat-checkbox
          aria-label="Allow media companion conversion"
          formControlName="allowConversion"
          data-test-id="media-companion-allow-conversion"
        ></mat-checkbox>
      </div>
    </div>

    <div class="setting-item" data-test-id="media-companion-pairing-setting">
      <div class="setting-item__meta">
        <h4>Session pairing</h4>
        <p>The token is held for this app session and is not saved with settings.</p>
      </div>
      <div class="setting-item__control media-companion-pairing">
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Session token</mat-label>
          <input
            matInput
            type="password"
            autocomplete="new-password"
            [value]="token()"
            (input)="updateToken($event)"
            data-test-id="media-companion-session-token"
          />
        </mat-form-field>
        <button
          mat-flat-button
          type="button"
          [disabled]="testing()"
          (click)="pairAndTest()"
          data-test-id="media-companion-pair-test"
        >
          {{ testing() ? 'Testing…' : 'Pair / Test' }}
        </button>
      </div>
      @if (status()) {
        <p class="media-companion-pairing__status" role="status" aria-live="polite">
          {{ status() }}
        </p>
      }
    </div>
    </div>
  `,
  styles: [
    `
      .media-companion-pairing {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.75rem;
      }
      .media-companion-pairing mat-form-field {
        flex: 1 1 16rem;
      }
      .media-companion-pairing__status {
        flex-basis: 100%;
        grid-column: 1 / -1;
        width: 100%;
        margin: 0;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsMediaCompanionComponent {
  readonly form = input.required<FormGroup>();
  readonly token = signal("");
  readonly status = signal("");
  readonly testing = signal(false);

  updateToken(event: Event): void {
    this.token.set((event.target as HTMLInputElement).value);
    this.status.set("");
  }

  async pairAndTest(): Promise<void> {
    const token = this.token().trim();
    const baseUrl = String(this.form().get("baseUrl")?.value ?? "").trim();
    if (!token) {
      this.status.set("Enter a session token to pair.");
      return;
    }

    this.testing.set(true);
    this.status.set("");
    try {
      const client = new MediaCompanionClient({ baseUrl, token });
      const capabilities = await client.getCapabilities();
      mediaCompanionCredentials.pair(baseUrl, token);
      this.token.set("");
      this.status.set(capabilitySummary(capabilities));
    } catch (error) {
      this.status.set(
        error instanceof MediaCompanionError
          ? error.message
          : "Could not connect to the media companion.",
      );
    } finally {
      this.testing.set(false);
    }
  }
}

function capabilitySummary(capabilities: MediaCompanionCapabilities): string {
  const modes = capabilities['modes'];
  if (!modes || typeof modes !== 'object' || Array.isArray(modes)) return 'Paired successfully.';
  const entries = Object.entries(modes as Record<string, { available?: boolean; reason?: string }>);
  const available = entries.filter(([,value]) => value?.available).map(([name]) => name).join(', ');
  const conversion = (modes as Record<string, { available?: boolean; reason?: string }>)['convert'];
  const reasons: Record<string,string> = {
    disabled: 'Conversion is disabled on the companion.',
    ffprobe_unavailable: 'Conversion requires ffprobe on the companion.',
    ffmpeg_unavailable: 'Processing requires FFmpeg on the companion.',
    software_too_slow: 'Software encoding cannot sustain playback on this companion.',
  };
  return `Paired successfully. Available: ${available || 'none'}.${conversion?.available ? '' : ' ' + (reasons[conversion?.reason ?? ''] ?? 'Conversion is unavailable on this companion.')}`;
}
