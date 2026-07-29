import { Component, computed, input, ViewEncapsulation } from "@angular/core";
import { MatIconModule } from "@angular/material/icon";
import { TranslateModule } from "@ngx-translate/core";

@Component({
  selector: "app-settings-about-section",
  imports: [MatIconModule, TranslateModule],
  templateUrl: "./settings-about-section.component.html",
  encapsulation: ViewEncapsulation.None,
  styles: [
    ":host { display: contents; }",
    ".version-block .build-commit { opacity: 0.65; font-size: 0.85em; }",
  ],
})
export class SettingsAboutSectionComponent {
  readonly activeSection = input.required<string>();
  readonly isDesktop = input(false);
  readonly version = input<string | undefined>();
  readonly buildCommit = input<string | undefined>();

  readonly buildCommitShort = computed(() => {
    const commit = this.buildCommit()?.trim();
    return commit ? commit.slice(0, 7) : undefined;
  });
}
