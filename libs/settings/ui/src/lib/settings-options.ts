import {
  CoverSize,
  EpgViewMode,
  StartupBehavior,
  Theme,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import { getAvailablePlayerEngines } from "@arm-nator/player/core";
import {
  CoverSizeOption,
  EpgViewModeOption,
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

export const SETTINGS_EPG_VIEW_MODE_OPTIONS: EpgViewModeOption[] = [
  {
    value: "timeline" satisfies EpgViewMode,
    icon: "view_timeline",
    labelKey: "SETTINGS.EPG_VIEW_MODE_TIMELINE",
  },
  {
    value: "list" satisfies EpgViewMode,
    icon: "view_list",
    labelKey: "SETTINGS.EPG_VIEW_MODE_LIST",
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
  supportsManagedExternalPlayers: boolean;
}

/**
 * Built-in web players are always offered; the OS-backed ones only show up
 * when the current runtime can actually launch them.
 */
export function buildSettingsPlayerOptions({
  supportsEmbeddedMpv,
  supportsManagedExternalPlayers,
}: SettingsPlayerAvailability): SettingsPlayerOption[] {
  return getAvailablePlayerEngines({
    supportsEmbeddedMpv,
    supportsManagedExternalPlayers,
  }).map(({ id, labelKey }) => ({ id, labelKey }));
}

export interface SettingsSectionVisibility {
  supportsEpg: boolean;
}

export function buildSettingsSectionNavItems({
  supportsEpg,
}: SettingsSectionVisibility): SettingsSection[] {
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
      id: "epg",
      label: "SETTINGS.NAV_EPG",
      icon: "calendar_month",
      visible: supportsEpg,
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
