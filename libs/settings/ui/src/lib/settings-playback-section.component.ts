import { CommonModule } from "@angular/common";
import { Component, input, ViewEncapsulation } from "@angular/core";
import { FormGroup, ReactiveFormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatCheckboxModule } from "@angular/material/checkbox";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatInputModule } from "@angular/material/input";
import { MatSelectModule } from "@angular/material/select";
import { TranslateModule } from "@ngx-translate/core";
import { StreamFormat, VideoPlayer } from "@arm-nator/shared/interfaces";
import { isManagedExternalPlayer, isWebPlayer } from "@arm-nator/player/core";
import { SettingsPlayerOption } from "./settings.models";

@Component({
  selector: "app-settings-playback-section",
  imports: [
    CommonModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    ReactiveFormsModule,
    TranslateModule,
  ],
  templateUrl: "./settings-playback-section.component.html",
  encapsulation: ViewEncapsulation.None,
  styles: [":host { display: contents; }"],
})
export class SettingsPlaybackSectionComponent {
  readonly mpvPlayerArgumentsPlaceholder = [
    "--ontop",
    "--autofit=640x360",
    "--geometry=+80+80",
  ].join("\n");
  readonly vlcPlayerArgumentsPlaceholder = [
    "--video-on-top",
    "--width=640",
    "--height=360",
  ].join("\n");

  readonly form = input.required<FormGroup>();
  readonly activeSection = input.required<string>();
  readonly players = input.required<SettingsPlayerOption[]>();
  readonly streamFormatEnum = input.required<typeof StreamFormat>();
  readonly isDesktop = input(false);
  /** Frame-copy embedded MPV engine is possible on this machine */
  readonly frameCopyAvailable = input(false);
  /** Frame-copy engine is what the current app run actually uses */
  readonly frameCopyActive = input(false);
  readonly supportsManagedExternalPlayers = input(false);
  readonly supportsExternalPlayerPathSettings = input(false);

  isWebPlayerSelected(): boolean {
    return isWebPlayer(this.form().value.player ?? VideoPlayer.ArtPlayer);
  }

  isExternalPlayerSelected(): boolean {
    return isManagedExternalPlayer(
      this.form().value.player ?? VideoPlayer.ArtPlayer,
    );
  }
}
