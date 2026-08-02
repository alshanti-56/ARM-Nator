import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MAT_DIALOG_DATA, MatDialogModule } from "@angular/material/dialog";
import { MatIconModule } from "@angular/material/icon";
import { TranslatePipe } from "@ngx-translate/core";
import { MetadataDisplayEntry } from "@arm-nator/shared/interfaces";

export interface ContentMetadataDialogData {
  title: string;
  entries: MetadataDisplayEntry[];
}

@Component({
  selector: "app-content-metadata-dialog",
  imports: [MatButtonModule, MatDialogModule, MatIconModule, TranslatePipe],
  templateUrl: "./content-metadata-dialog.component.html",
  styleUrl: "./content-metadata-dialog.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContentMetadataDialogComponent {
  readonly data = inject<ContentMetadataDialogData>(MAT_DIALOG_DATA);
}
