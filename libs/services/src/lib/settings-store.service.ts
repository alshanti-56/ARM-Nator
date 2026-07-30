import { inject } from "@angular/core";
import {
  patchState,
  signalStore,
  withHooks,
  withMethods,
  withState,
} from "@ngrx/signals";
import { StorageMap } from "@ngx-pwa/local-storage";
import { firstValueFrom } from "rxjs";import { DEFAULT_DASHBOARD_RAILS_SETTINGS, DEFAULT_DIRECT_PLAY_PREFERENCES, DEFAULT_TMDB_SETTINGS, ElectronBridgeTrustOptions, Language, Settings, StartupBehavior, STORE_KEY, StreamFormat, Theme, VideoPlayer, normalizeDashboardRailsSettings, normalizeDirectPlayPreferences, normalizeVideoPlayer } from "@arm-nator/shared/interfaces";

import { isInlinePlayer } from "@arm-nator/player/core";

const DEFAULT_SETTINGS: Settings = {
  player: VideoPlayer.ArtPlayer,
  directPlay: DEFAULT_DIRECT_PLAY_PREFERENCES,
  playerAmbientMode: false,
  playerUpNextRail: true,
  streamFormat: StreamFormat.AutoStreamFormat,
  openStreamOnDoubleClick: false,
  language: Language.ENGLISH,
  showCaptions: false,
  showDashboard: true,
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
  downloadFolder: "",
  coverSize: "medium",
  dashboardRails: DEFAULT_DASHBOARD_RAILS_SETTINGS,
  trustedInsecureTlsHosts: [],
  tmdb: DEFAULT_TMDB_SETTINGS,
};

let embeddedMpvPrepareScheduled = false;

function scheduleEmbeddedMpvPrepare(): void {
  if (
    embeddedMpvPrepareScheduled ||
    typeof window === "undefined" ||
    !window.electron?.prepareEmbeddedMpv
  ) {
    return;
  }

  embeddedMpvPrepareScheduled = true;
  const prepare = () => {
    void window.electron
      .prepareEmbeddedMpv?.()
      .then((support) => {
        if (!support?.supported) {
          embeddedMpvPrepareScheduled = false;
        }
      })
      .catch((error) => {
        embeddedMpvPrepareScheduled = false;
        console.warn("Failed to prepare embedded MPV.", error);
      });
  };
  const idleWindow = window as typeof window & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number;
  };

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(prepare, { timeout: 5000 });
  } else {
    window.setTimeout(prepare, 2000);
  }
}

export const SettingsStore = signalStore(
  { providedIn: "root" },
  withState<Settings>(DEFAULT_SETTINGS),
  withMethods((store, storage = inject(StorageMap)) => {
    let settingsLoadPromise: Promise<void> | undefined;

    return {
      loadSettings() {
        if (settingsLoadPromise) {
          return settingsLoadPromise;
        }

        settingsLoadPromise = (async () => {
          const stored = await firstValueFrom(storage.get(STORE_KEY.Settings));
          if (stored) {
            const storedSettings = stored as Partial<Settings>;
            patchState(store, {
              ...DEFAULT_SETTINGS,
              ...storedSettings,
              player: normalizeVideoPlayer(storedSettings.player),
              directPlay: normalizeDirectPlayPreferences(
                storedSettings.directPlay,
              ),
              dashboardRails: normalizeDashboardRailsSettings(
                storedSettings.dashboardRails,
              ),
            });
            void this.sanitizeEmbeddedMpvSelection().catch((error) => {
              console.warn(
                "Failed to verify embedded MPV support while loading settings.",
                error,
              );
            });
          }
        })().catch((error) => {
          settingsLoadPromise = undefined;
          console.error("Failed to load settings:", error);
          // Keep default settings if loading fails
        });

        return settingsLoadPromise;
      },

      async updateSettings(settings: Partial<Settings>) {
        patchState(store, {
          ...settings,
          ...(settings.dashboardRails !== undefined
            ? {
                dashboardRails: normalizeDashboardRailsSettings(
                  settings.dashboardRails,
                ),
              }
            : {}),
          ...(settings.directPlay !== undefined
            ? {
                directPlay: normalizeDirectPlayPreferences(settings.directPlay),
              }
            : {}),
        });
        // Save the complete settings object, not just the partial update
        const completeSettings = this.getSettings();
        try {
          await firstValueFrom(
            storage.set(STORE_KEY.Settings, completeSettings),
          );
          if (completeSettings.player === VideoPlayer.EmbeddedMpv) {
            scheduleEmbeddedMpvPrepare();
          }
        } catch (error) {
          console.error("Failed to save settings:", error);
          throw error;
        }
      },

      getSettings() {
        return {
          player: store.player(),
          directPlay: normalizeDirectPlayPreferences(store.directPlay?.()),
          playerAmbientMode:
            store.playerAmbientMode?.() ?? DEFAULT_SETTINGS.playerAmbientMode,
          playerUpNextRail:
            store.playerUpNextRail?.() ?? DEFAULT_SETTINGS.playerUpNextRail,
          streamFormat: store.streamFormat(),
          openStreamOnDoubleClick: store.openStreamOnDoubleClick(),
          language: store.language(),
          showCaptions: store.showCaptions(),
          showDashboard: store.showDashboard(),
          startupBehavior: store.startupBehavior(),
          showExternalPlaybackBar:
            store.showExternalPlaybackBar?.() ??
            DEFAULT_SETTINGS.showExternalPlaybackBar,
          stripCountryPrefix:
            store.stripCountryPrefix?.() ?? DEFAULT_SETTINGS.stripCountryPrefix,
          theme: store.theme(),
          mpvPlayerPath: store.mpvPlayerPath(),
          mpvPlayerArguments: store.mpvPlayerArguments(),
          mpvReuseInstance: store.mpvReuseInstance(),
          vlcPlayerPath: store.vlcPlayerPath(),
          vlcPlayerArguments: store.vlcPlayerArguments(),
          vlcReuseInstance: store.vlcReuseInstance(),
          downloadFolder:
            store.downloadFolder?.() ?? DEFAULT_SETTINGS.downloadFolder,
          coverSize: store.coverSize?.() ?? DEFAULT_SETTINGS.coverSize,
          dashboardRails: normalizeDashboardRailsSettings(
            store.dashboardRails?.(),
          ),
          trustedInsecureTlsHosts:
            store.trustedInsecureTlsHosts?.() ??
            DEFAULT_SETTINGS.trustedInsecureTlsHosts,
          tmdb: store.tmdb?.() ?? DEFAULT_SETTINGS.tmdb,
        };
      },

      getDownloadFolder() {
        return store.downloadFolder?.() ?? DEFAULT_SETTINGS.downloadFolder;
      },

      getTrustOptions(): ElectronBridgeTrustOptions {
        const settings = this.getSettings();
        return {
          trustedInsecureTlsHosts: settings.trustedInsecureTlsHosts ?? [],
        };
      },

      getPlayer() {
        return store.player();
      },

      isEmbeddedPlayer() {
        return isInlinePlayer(store.player());
      },

      async sanitizeEmbeddedMpvSelection() {
        if (store.player() !== VideoPlayer.EmbeddedMpv) {
          return;
        }

        if (
          typeof window === "undefined" ||
          !window.electron?.getEmbeddedMpvSupport
        ) {
          await this.updateSettings({
            player: DEFAULT_SETTINGS.player,
          });
          return;
        }

        try {
          const support = await window.electron.getEmbeddedMpvSupport();
          if (!support.supported) {
            await this.updateSettings({
              player: DEFAULT_SETTINGS.player,
            });
            return;
          }

          scheduleEmbeddedMpvPrepare();
        } catch (error) {
          console.warn(
            "Failed to verify embedded MPV support; reverting to the default inline player.",
            error,
          );
          await this.updateSettings({
            player: DEFAULT_SETTINGS.player,
          });
        }
      },
    };
  }),
  withHooks({
    onInit(store) {
      store.loadSettings();
    },
  }),
);
