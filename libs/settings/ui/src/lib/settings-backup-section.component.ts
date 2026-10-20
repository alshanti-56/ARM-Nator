import { Component, input, output, ViewEncapsulation, ChangeDetectionStrategy } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatProgressSpinnerModule } from "@angular/material/progress-spinner";
import { TranslatePipe } from "@ngx-translate/core";

@Component({
  selector: "app-settings-backup-section",
  imports: [
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    TranslatePipe,
  ],
  templateUrl: "./settings-backup-section.component.html",
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [":host { display: contents; }"],
})
export class SettingsBackupSectionComponent {
  readonly activeSection = input.required<string>();
  readonly isRemovingAllPlaylists = input(false);
  readonly isExportingData = input(false);

  readonly importData = output<void>();
  readonly exportData = output<void>();
}
