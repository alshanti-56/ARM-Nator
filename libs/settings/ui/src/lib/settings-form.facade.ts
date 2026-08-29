import { DestroyRef, inject, Injectable } from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { FormBuilder } from "@angular/forms";
import { RuntimeCapabilitiesService } from "@arm-nator/services";
import { CoverSize, Language, Theme } from "@arm-nator/shared/interfaces";

import { TranslateService } from "@ngx-translate/core";
import { SettingsStore } from "@arm-nator/services";
import { SettingsService } from "@arm-nator/settings/data-access";
import {
  createSettingsForm,
  createSettingsFromFormValue,
  SettingsForm,
} from "./settings-form.utils";

type SettingsFormPatch = Parameters<SettingsForm["patchValue"]>[0];

/**
 * Owns the settings form: creation, hydration from the store, the small
 * mutations the section components trigger, and persisting on submit.
 */
@Injectable()
export class SettingsFormFacade {
  private readonly destroyRef = inject(DestroyRef);
  private readonly formBuilder = inject(FormBuilder);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly settingsService = inject(SettingsService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly translate = inject(TranslateService);

  /** Settings form object */
  readonly form = createSettingsForm(this.formBuilder);

  /** Waits for the persisted settings to be available */
  loadSettings(): Promise<void> {
    return this.settingsStore.loadSettings();
  }

  /**
   * Sets saved settings from the indexed db store
   */
  hydrateFromStore(): void {
    const currentSettings = this.settingsStore.getSettings();
    this.form.patchValue({
      ...currentSettings,
      language: Language.ENGLISH,
    });
    this.syncDashboardControlsEnabledState(
      currentSettings.showDashboard ?? true,
    );

  }

  bindDashboardControlsEnabledState(): void {
    this.form
      .get("showDashboard")
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((showDashboard) =>
        this.syncDashboardControlsEnabledState(showDashboard ?? true),
      );
  }

  selectTheme(theme: Theme): void {
    if (this.form.value.theme === theme) {
      return;
    }

    this.patchAndMarkDirty({ theme }, "theme");
    this.settingsService.changeTheme(theme);
  }

  selectCoverSize(coverSize: CoverSize): void {
    if (this.form.value.coverSize === coverSize) {
      return;
    }

    this.patchAndMarkDirty({ coverSize }, "coverSize");
    void this.settingsStore.updateSettings({ coverSize });
  }

  /**
   * Persists the form to the settings store and mirrors the result to the
   * desktop backend.
   * @param onSaved runs after the store write, before the backend is
   * notified, so the UI confirmation is not delayed by IPC
   */
  async save(onSaved: () => void): Promise<void> {
    const settings = createSettingsFromFormValue(
      this.form,
      this.settingsStore.getSettings(),
    );

    await this.settingsStore.updateSettings(settings);
    onSaved();

    if (!window.electron) {
      return;
    }

    window.electron.updateSettings(settings);

    if (this.runtime.supportsExternalPlayerPathSettings) {
      window.electron.setMpvPlayerPath(settings.mpvPlayerPath);
      window.electron.setVlcPlayerPath(settings.vlcPlayerPath);
    }
  }

  /** Applies the saved language/theme and resets the dirty state */
  applySavedSettings(): void {
    this.form.markAsPristine();
    this.translate.use(Language.ENGLISH);
    this.settingsService.changeTheme(
      this.form.value.theme ?? Theme.SystemTheme,
    );
  }

  private patchAndMarkDirty(
    value: SettingsFormPatch,
    controlName: string,
  ): void {
    this.form.patchValue(value);
    this.form.get(controlName)?.markAsDirty();
    this.form.markAsDirty();
  }

  private syncDashboardControlsEnabledState(showDashboard: boolean): void {
    const dashboardRails = this.form.get("dashboardRails");
    if (!dashboardRails) {
      return;
    }

    if (showDashboard) {
      dashboardRails.enable({ emitEvent: false });
    } else {
      dashboardRails.disable({ emitEvent: false });
    }
  }
}
