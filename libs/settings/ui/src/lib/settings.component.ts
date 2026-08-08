import { CommonModule } from "@angular/common";
import {
  Component,
  computed,
  inject,
  Input,
  OnDestroy,
  OnInit,
  signal,
  ViewEncapsulation,
} from "@angular/core";
import { ReactiveFormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
} from "@angular/material/dialog";
import { MatIconModule } from "@angular/material/icon";
import { Router } from "@angular/router";
import { SettingsContextService } from "@arm-nator/workspace/shell/util";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { RuntimeCapabilitiesService } from "@arm-nator/services";
import { Language, StreamFormat } from "@arm-nator/shared/interfaces";
import { BUILD_COMMIT } from "./build-commit";
import { SettingsAboutSectionComponent } from "./settings-about-section.component";
import { SettingsBackupSectionComponent } from "./settings-backup-section.component";
import { SettingsDashboardSectionComponent } from "./settings-dashboard-section.component";
import { SettingsEmbeddedMpvFacade } from "./settings-embedded-mpv.facade";
import { SettingsFormFacade } from "./settings-form.facade";
import { SettingsGeneralSectionComponent } from "./settings-general-section.component";
import { SettingsSection } from "./settings.models";
import {
  buildSettingsPlayerOptions,
  buildSettingsSectionNavItems,
  SETTINGS_COVER_SIZE_OPTIONS,
  SETTINGS_STARTUP_BEHAVIOR_OPTIONS,
  SETTINGS_THEME_OPTIONS,
} from "./settings-options";

import { SettingsPlaybackSectionComponent } from "./settings-playback-section.component";
import { SettingsResetSectionComponent } from "./settings-reset-section.component";
import { SettingsSectionScrollDirective } from "./settings-section-scroll.directive";
import { SettingsTmdbSectionComponent } from "./settings-tmdb-section.component";
import { SettingsBackupFacade } from "./settings-backup.facade";
import { SettingsPlaylistResetFacade } from "./settings-playlist-reset.facade";
import { SettingsSnackbarService } from "./settings-snackbar.service";

/**
 * Thin coordinator for the settings page. The behaviour of each section lives
 * in a dedicated facade the template binds to directly; what stays here is the
 * page-level wiring: environment capabilities, section navigation, and the
 * save/close flow that spans several facades.
 */
@Component({
  templateUrl: "./settings.component.html",
  styleUrls: ["./settings.component.scss"],
  host: {
    class: "settings-page-host",
  },
  encapsulation: ViewEncapsulation.None,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    ReactiveFormsModule,
    TranslateModule,
    MatDialogModule,
    SettingsAboutSectionComponent,
    SettingsBackupSectionComponent,
    SettingsDashboardSectionComponent,
    SettingsGeneralSectionComponent,
    SettingsPlaybackSectionComponent,
    SettingsResetSectionComponent,
    SettingsSectionScrollDirective,
    SettingsTmdbSectionComponent,
  ],
  providers: [
    SettingsBackupFacade,
    SettingsEmbeddedMpvFacade,
    SettingsFormFacade,
    SettingsPlaylistResetFacade,
    SettingsSnackbarService,
  ],
})
export class SettingsComponent implements OnInit, OnDestroy {
  readonly backup = inject(SettingsBackupFacade);
  readonly embeddedMpv = inject(SettingsEmbeddedMpvFacade);
  readonly form = inject(SettingsFormFacade);
  readonly playlistReset = inject(SettingsPlaylistResetFacade);

  private readonly settingsCtx = inject(SettingsContextService);
  private readonly settingsSnackbar = inject(SettingsSnackbarService);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly matDialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly dialogData = inject<{ isDialog: boolean } | null>(
    MAT_DIALOG_DATA,
    { optional: true },
  );

  @Input() isDialog = this.dialogData?.isDialog ?? false;

  /** List with available languages as enum */
  readonly languageEnum = Language;

  /** List with allowed formats as enum */
  readonly streamFormatEnum = StreamFormat;

  /** Flag that indicates whether the app runs in electron environment */
  readonly isDesktop = this.runtime.isElectron;
  readonly supportsDesktopFileSave = this.runtime.supportsDesktopFileSave;
  readonly supportsManagedExternalPlayers =
    this.runtime.supportsManagedExternalPlayers;
  readonly supportsExternalPlayerPathSettings =
    this.runtime.supportsExternalPlayerPathSettings;
  private readonly ksPlayerMetalSupported = signal(false);
  readonly supportsKsPlayerMetal = this.ksPlayerMetalSupported.asReadonly();

  readonly activeSection = this.settingsCtx.activeSection;

  /** Settings form object */
  readonly settingsForm = this.form.form;

  /** Player options */
  readonly players = computed(() =>
    buildSettingsPlayerOptions({
      supportsEmbeddedMpv: this.embeddedMpv.supported(),
      supportsKsPlayerMetal: this.ksPlayerMetalSupported(),
      supportsManagedExternalPlayers: this.supportsManagedExternalPlayers,
    }),
  );

  /** Git commit the app was built from (CI builds only) */
  readonly buildCommit = BUILD_COMMIT;

  readonly themeOptions = SETTINGS_THEME_OPTIONS;
  readonly coverSizeOptions = SETTINGS_COVER_SIZE_OPTIONS;
  readonly startupBehaviorOptions = SETTINGS_STARTUP_BEHAVIOR_OPTIONS;

  readonly sectionNavItems: SettingsSection[] = buildSettingsSectionNavItems();

  get sectionNav(): SettingsSection[] {
    return this.sectionNavItems.filter((section) => section.visible);
  }

  /**
   * Reads the config object from the browsers
   * storage (indexed db)
   */
  async ngOnInit(): Promise<void> {
    // Wait for settings to load before setting the form
    await this.form.loadSettings();
    this.form.hydrateFromStore();
    this.form.bindDashboardControlsEnabledState();
    void this.embeddedMpv.load();
    void this.loadKsPlayerMetalSupport();
    if (!this.isDialog) {
      this.settingsCtx.setSections(this.sectionNav);
    }
  }

  ngOnDestroy(): void {
    this.settingsCtx.reset();
  }

  /**
   * Triggers on form submit and saves the config object to
   * the indexed db store
   */
  onSubmit(): void {
    void this.form.save(() => this.applyChangedSettings());

    if (this.isDialog) {
      this.matDialog.closeAll();
    }
  }

  /**
   * Applies the changed settings to the app
   */
  applyChangedSettings(): void {
    this.form.applySavedSettings();
    this.settingsSnackbar.open(
      this.translate.instant("SETTINGS.SETTINGS_SAVED"),
    );
  }

  /**
   * Navigates back to the applications homepage
   */
  backToHome(): void {
    if (this.isDialog) {
      this.matDialog.closeAll();
    } else {
      this.router.navigateByUrl("/");
    }
  }

  async exportData(): Promise<void> {
    await this.backup.exportData(() => this.waitForUiFeedbackFrame());
  }

  importData(): void {
    this.backup.importData(() => this.form.hydrateFromStore());
  }

  removeAll(): void {
    this.playlistReset.confirmAndRemoveAll(() => this.waitForUiFeedbackFrame());
  }

  /**
   * Lets the browser paint the pending busy state before a long running
   * task blocks the main thread.
   */
  private async waitForUiFeedbackFrame(): Promise<void> {
    if (typeof window.requestAnimationFrame !== "function") {
      await Promise.resolve();
      return;
    }

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  private async loadKsPlayerMetalSupport(): Promise<void> {
    if (!this.runtime.isElectron || typeof window === "undefined") {
      this.ksPlayerMetalSupported.set(false);
      return;
    }

    if (typeof window.electron?.getKsPlayerMetalSupport !== "function") {
      this.ksPlayerMetalSupported.set(false);
      return;
    }

    try {
      const support = await window.electron.getKsPlayerMetalSupport();
      this.ksPlayerMetalSupported.set(support.supported === true);
    } catch {
      this.ksPlayerMetalSupported.set(false);
    }
  }
}
