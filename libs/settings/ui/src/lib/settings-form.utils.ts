import { FormBuilder } from "@angular/forms";
import {
  CoverSize,
  DEFAULT_DASHBOARD_RAILS_SETTINGS,
  DEFAULT_MEDIA_COMPANION_SETTINGS,
  DEFAULT_TMDB_SETTINGS,
  Language,
  normalizeDashboardRailsSettings,
  normalizeExternalPlayerArguments,
  normalizeMediaCompanionSettings,
  Settings,
  StartupBehavior,
  StreamFormat,
  Theme,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";

export function createSettingsForm(formBuilder: FormBuilder) {
  return formBuilder.group({
    player: [VideoPlayer.Auto],
    livePlayer: [VideoPlayer.Auto],
    vodPlayer: [VideoPlayer.Auto],
    playerAmbientMode: false,
    playerUpNextRail: true,
    streamFormat: StreamFormat.AutoStreamFormat,
    openStreamOnDoubleClick: false,
    language: Language.ENGLISH,
    showCaptions: false,
    showDashboard: true,
    dashboardRails: formBuilder.group({
      hero: DEFAULT_DASHBOARD_RAILS_SETTINGS.hero,
      continueWatching: DEFAULT_DASHBOARD_RAILS_SETTINGS.continueWatching,
      liveFavorites: DEFAULT_DASHBOARD_RAILS_SETTINGS.liveFavorites,
      recentlyWatchedLive: DEFAULT_DASHBOARD_RAILS_SETTINGS.recentlyWatchedLive,
      favoriteMoviesAndSeries:
        DEFAULT_DASHBOARD_RAILS_SETTINGS.favoriteMoviesAndSeries,
      recentSources: DEFAULT_DASHBOARD_RAILS_SETTINGS.recentSources,
      xtreamRecentlyAdded: DEFAULT_DASHBOARD_RAILS_SETTINGS.xtreamRecentlyAdded,
      tmdbTrending: DEFAULT_DASHBOARD_RAILS_SETTINGS.tmdbTrending,
    }),
    startupBehavior: StartupBehavior.FirstView,
    showExternalPlaybackBar: true,
    stripCountryPrefix: false,
    theme: Theme.SystemTheme,
    mpvPlayerPath: "",
    mpvPlayerArguments: "",
    mpvReuseInstance: false,
    vlcPlayerPath: "",
    vlcPlayerArguments: "",
    vlcReuseInstance: false,
    coverSize: "medium" as CoverSize,
    tmdb: formBuilder.group({
      enabled: DEFAULT_TMDB_SETTINGS.enabled,
      apiKey: DEFAULT_TMDB_SETTINGS.apiKey ?? "",
    }),
    mediaCompanion: formBuilder.group({
      enabled: DEFAULT_MEDIA_COMPANION_SETTINGS.enabled,
      baseUrl: DEFAULT_MEDIA_COMPANION_SETTINGS.baseUrl,
      allowConversion: DEFAULT_MEDIA_COMPANION_SETTINGS.allowConversion,
    }),
  });
}

export type SettingsForm = ReturnType<typeof createSettingsForm>;

export function createSettingsFromFormValue(
  settingsForm: SettingsForm,
  currentSettings: Settings,
): Settings {
  const value = settingsForm.getRawValue();

  return {
    player: value.vodPlayer ?? value.player ?? VideoPlayer.ArtPlayer,
    livePlayer: value.livePlayer ?? value.player ?? VideoPlayer.ArtPlayer,
    vodPlayer: value.vodPlayer ?? value.player ?? VideoPlayer.ArtPlayer,
    playerAmbientMode: value.playerAmbientMode ?? false,
    playerUpNextRail: value.playerUpNextRail ?? true,
    streamFormat: value.streamFormat ?? StreamFormat.AutoStreamFormat,
    openStreamOnDoubleClick: value.openStreamOnDoubleClick ?? false,
    language: Language.ENGLISH,
    showCaptions: value.showCaptions ?? false,
    showDashboard: value.showDashboard ?? true,
    dashboardRails: normalizeDashboardRailsSettings(value.dashboardRails),
    startupBehavior: value.startupBehavior ?? StartupBehavior.FirstView,
    showExternalPlaybackBar: value.showExternalPlaybackBar ?? true,
    stripCountryPrefix: value.stripCountryPrefix ?? false,
    theme: value.theme ?? Theme.SystemTheme,
    mpvPlayerPath: normalizeExternalPlayerPath(value.mpvPlayerPath),
    mpvPlayerArguments: normalizeExternalPlayerArguments(
      value.mpvPlayerArguments,
    ),
    mpvReuseInstance: value.mpvReuseInstance ?? false,
    vlcPlayerPath: normalizeExternalPlayerPath(value.vlcPlayerPath),
    vlcPlayerArguments: normalizeExternalPlayerArguments(
      value.vlcPlayerArguments,
    ),
    vlcReuseInstance: value.vlcReuseInstance ?? false,
    coverSize: value.coverSize ?? "medium",
    trustedInsecureTlsHosts: currentSettings.trustedInsecureTlsHosts ?? [],
    tmdb: {
      enabled: value.tmdb?.enabled ?? DEFAULT_TMDB_SETTINGS.enabled,
      apiKey: value.tmdb?.apiKey?.trim() ?? "",
    },
    mediaCompanion: normalizeMediaCompanionSettings(value.mediaCompanion),
  };
}

function normalizeExternalPlayerPath(
  playerPath: string | null | undefined,
): string {
  return playerPath?.trim() ?? "";
}
