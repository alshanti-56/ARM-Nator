import { OverlayContainer, FullscreenOverlayContainer } from '@angular/cdk/overlay';
import { AppPortalDiscoveryService } from './services/portal-discovery.service';
import { PORTAL_DISCOVERY_ADAPTER } from '@arm-nator/providers/shared/util';
import {
  provideHttpClient,
  withInterceptorsFromDi,
  withXhr
} from '@angular/common/http';
import {
    ApplicationConfig,
    inject,
    importProvidersFrom,
    provideAppInitializer,
    provideZoneChangeDetection,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideEffects } from '@ngrx/effects';
import { provideRouterStore, routerReducer } from '@ngrx/router-store';
import { provideStore } from '@ngrx/store';
import { provideStoreDevtools } from '@ngrx/store-devtools';
import { TranslateService, provideTranslateService } from '@ngx-translate/core';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { PlaylistEffects, playlistReducer } from '@arm-nator/providers/shared/playlist-state';
import { NgxIndexedDBModule } from 'ngx-indexed-db';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import {
    PORTAL_EXTERNAL_PLAYBACK,
    PORTAL_PLAYER,
} from '@arm-nator/providers/shared/util';
import { PLAYLIST_PLAYER_ACTIONS } from '@arm-nator/providers/shared/playlist-util';
import { provideXtreamDataSource } from '@arm-nator/providers/xtream/data-access';
import { DataService } from '@arm-nator/services';
import { dbConfig, Language } from '@arm-nator/shared/interfaces';
import { AppConfig } from '../environments/environment';
import { routes } from './app.routes';
import { ElectronService } from './services/electron.service';
import { ExternalPlaybackService } from './services/external-playback.service';
import { PlayerService } from './services/player.service';
import { installWebElectronBridge } from './services/web-electron-bridge';
import {
    AppPortalNavigationActionsService,
    providePortalNavigationActions,
} from './services/portal-navigation-actions.service';
import { providePortalPlaybackPositions } from './services/portal-playback-positions.service';
import { provideWorkspaceShellActions } from './services/workspace-shell-actions.service';

/**
 * Synchronously read the user's preferred language from localStorage. English
 * is currently the only bundled application locale.
 *
 * The hint is written by AppComponent.initSettings() whenever the saved
 * settings resolve, so first-ever boots and unsupported saved preferences
 * fall back to English.
 */
const SUPPORTED_LANGS = new Set(['en']);
export const PREFERRED_LANGUAGE_STORAGE_KEY = 'arm-nator:preferred-language';
export function getInitialLanguage(): string {
    try {
        const saved = localStorage.getItem(PREFERRED_LANGUAGE_STORAGE_KEY);
        if (saved && SUPPORTED_LANGS.has(saved)) {
            return saved;
        }
    } catch {
        // localStorage may throw in privacy modes; fall through to default.
    }
    return 'en';
}

// Electron exposes the native bridge from preload. A normal browser does not,
// so install a compatible HTTP-backed bridge before Angular creates services
// that talk to the database or Xtream provider.
installWebElectronBridge();

export const appConfig: ApplicationConfig = {
    providers: [
        { provide: OverlayContainer, useClass: FullscreenOverlayContainer },
        provideZoneChangeDetection({ eventCoalescing: true }),
        provideRouter(routes, withComponentInputBinding()),
        provideAnimations(),
        provideHttpClient(withXhr(), withInterceptorsFromDi()),
        provideStore({
            router: routerReducer,
            playlistState: playlistReducer,
        }),
        provideEffects([PlaylistEffects]),
        provideRouterStore(),
        ...(AppConfig.production ? [] : [provideStoreDevtools({ maxAge: 25 })]),
        importProvidersFrom(
            NgxIndexedDBModule.forRoot(dbConfig),
            NgxSkeletonLoaderModule.forRoot({
                animation: 'pulse',
                loadingText: 'This item is actually loading...',
            })
        ),
        provideTranslateService({
            // Always resolve missing keys from English, regardless of the
            // user's active language. Keep loader failures fatal, matching
            // ngx-translate v17 behavior for missing translation files.
            fallbackLang: Language.ENGLISH,
            loader: provideTranslateHttpLoader({
                prefix: './assets/i18n/',
                suffix: '.json',
                failOnError: true,
            }),
        }),
        provideAppInitializer(() =>
            inject(TranslateService).use(getInitialLanguage())
        ),
        {
            provide: DataService,
            useExisting: ElectronService,
        },
        {
            provide: PORTAL_PLAYER,
            useExisting: PlayerService,
        },
        {
            provide: PORTAL_EXTERNAL_PLAYBACK,
            useExisting: ExternalPlaybackService,
        },
        ...providePortalPlaybackPositions(),
        { provide: PORTAL_DISCOVERY_ADAPTER, useExisting: AppPortalDiscoveryService },
        ...providePortalNavigationActions(),
        {
            provide: PLAYLIST_PLAYER_ACTIONS,
            useExisting: AppPortalNavigationActionsService,
        },
        ...provideWorkspaceShellActions(),
        ...provideXtreamDataSource(),
        {
            provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
            useValue: { appearance: 'outline', subscriptSizing: 'dynamic' },
        },
    ],
};
