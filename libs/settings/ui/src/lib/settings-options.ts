import {
  CoverSize,
  type PlayerEngineAvailability,
  StartupBehavior,
  Theme,
} from "@arm-nator/shared/interfaces";

import { getAvailablePlayerEngines } from "@arm-nator/player/core";
import {
  CoverSizeOption,
  SettingsPlayerOption,
  SettingsSection,
  StartupBehaviorOption,
  ThemeOption,
} from "./settings.models";

export const SETTINGS_THEME_OPTIONS: ThemeOption[] = [
  {
    value: Theme.LightTheme,
    icon: "light_mode",
    labelKey: "THEMES.LIGHT_THEME",
  },
  {
    value: Theme.DarkTheme,
    icon: "dark_mode",
    labelKey: "THEMES.DARK_THEME",
  },
  {
    value: Theme.SystemTheme,
    icon: "desktop_windows",
    labelKey: "THEMES.SYSTEM_THEME",
  },
];

export const SETTINGS_COVER_SIZE_OPTIONS: CoverSizeOption[] = [
  {
    value: "small" satisfies CoverSize,
    icon: "view_module",
    labelKey: "SETTINGS.COVER_SIZE_SMALL",
  },
  {
    value: "medium" satisfies CoverSize,
    icon: "view_comfy",
    labelKey: "SETTINGS.COVER_SIZE_MEDIUM",
  },
  {
    value: "large" satisfies CoverSize,
    icon: "view_quilt",
    labelKey: "SETTINGS.COVER_SIZE_LARGE",
  },
];

export const SETTINGS_STARTUP_BEHAVIOR_OPTIONS: StartupBehaviorOption[] = [
  {
    value: StartupBehavior.FirstView,
    labelKey: "SETTINGS.STARTUP_BEHAVIOR_FIRST_VIEW",
  },
  {
    value: StartupBehavior.RestoreLastView,
    labelKey: "SETTINGS.STARTUP_BEHAVIOR_RESTORE_LAST_VIEW",
  },
];

export interface SettingsPlayerAvailability {
  supportsEmbeddedMpv: boolean;
  supportsKsPlayerMetal: boolean;
  supportsManagedExternalPlayers: boolean;
  externalPlayerAvailability?: readonly PlayerEngineAvailability[] | null;
}

/**
 * Built-in web players are always offered; the OS-backed ones only show up
 * when the current runtime can actually launch them.
 */
export function buildSettingsPlayerOptions({
  supportsEmbeddedMpv,
  supportsKsPlayerMetal,
  supportsManagedExternalPlayers,
  externalPlayerAvailability,
}: SettingsPlayerAvailability): SettingsPlayerOption[] {
  return getAvailablePlayerEngines({
    supportsEmbeddedMpv,
    supportsKsPlayerMetal,
    supportsManagedExternalPlayers,
  }).map(({ id, kind, labelKey }) => {
    const option: SettingsPlayerOption = { id, labelKey };
    if (kind === "automatic") {
      option.available = true;
      option.detail = "Selects a compatible player and recovers automatically";
    }
    if (
      kind === "managed-external" &&
      externalPlayerAvailability !== undefined &&
      externalPlayerAvailability !== null
    ) {
      const availability = externalPlayerAvailability?.find(
        (item) => item.engine === id,
      );
      option.available = availability?.available === true;
      option.detail =
        availability?.path ??
        availability?.reason ??
        "Optional external player is unavailable";
    }
    return option;
  });
}

export function buildSettingsSectionNavItems(): SettingsSection[] {
  return [
    {
      id: "general",
      label: "SETTINGS.NAV_GENERAL",
      icon: "tune",
      visible: true,
    },
    {
      id: "playback",
      label: "SETTINGS.NAV_PLAYBACK",
      icon: "play_circle",
      visible: true,
    },
    {
      id: "dashboard",
      label: "SETTINGS.NAV_DASHBOARD",
      icon: "dashboard",
      visible: true,
    },
    {
      id: "tmdb",
      label: "SETTINGS.NAV_TMDB",
      icon: "movie",
      visible: true,
    },
    {
      id: "backup",
      label: "SETTINGS.NAV_BACKUP",
      icon: "backup",
      visible: true,
    },
    {
      id: "reset",
      label: "SETTINGS.NAV_RESET",
      icon: "delete_sweep",
      visible: true,
    },
    {
      id: "about",
      label: "SETTINGS.NAV_ABOUT",
      icon: "info",
      visible: true,
    },
  ];
}
