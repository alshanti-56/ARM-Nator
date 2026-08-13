import {
    HttpClient,
    provideHttpClient,
    withInterceptorsFromDi,
} from '@angular/common/http';
import {
    ApplicationConfig,
    importProvidersFrom,
    provideZoneChangeDetection,
} from '@angular/core';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideEffects } from '@ngrx/effects';
import { provideRouterStore, routerReducer } from '@ngrx/router-store';
import { provideStore } from '@ngrx/store';
import { provideStoreDevtools } from '@ngrx/store-devtools';
import { TranslateLoader, TranslateModule } from '@ngx-translate/core';
import { TranslateHttpLoader } from '@ngx-translate/http-loader';
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
import { dbConfig } from '@arm-nator/shared/interfaces';
import { AppConfig } from '../environments/environment';
import { routes } from './app.routes';
import { ElectronService } from './services/electron.service';
import { ExternalPlaybackService } from './services/external-playback.service';
import { PlayerService } from './services/player.service';
import {
    AppPortalNavigationActionsService,
    providePortalNavigationActions,
} from './services/portal-navigation-actions.service';
import { providePortalPlaybackPositions } from './services/portal-playback-positions.service';
import { provideWorkspaceShellActions } from './services/workspace-shell-actions.service';

// AoT requires an exported function for factories
export function HttpLoaderFactory(http: HttpClient): TranslateHttpLoader {
    return new TranslateHttpLoader(http, './assets/i18n/', '.json');
}

/**
 * Synchronously read the user's preferred language from localStorage so the
 * very first render uses the right locale instead of flashing English first
 * and re-rendering once the IDB-backed settings finish loading.
 *
 * The hint is written by AppComponent.initSettings() whenever the saved
 * settings resolve, so first-ever boots fall back to English (no hint
 * present yet) and every subsequent boot uses the saved language.
 */
const SUPPORTED_LANGS = new Set([
    'ar',
    'ary',
    'by',
    'de',
    'el',
    'en',
    'es',
    'fr',
    'hu',
    'it',
    'ja',
    'ko',
    'nl',
    'pl',
    'pt',
    'ru',
    'tr',
    'zh',
    'zhtw',
]);
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

export const appConfig: ApplicationConfig = {
    providers: [
        provideZoneChangeDetection({ eventCoalescing: true }),
        provideRouter(routes, withComponentInputBinding()),
        provideAnimations(),
        provideHttpClient(withInterceptorsFromDi()),
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
            }),
            TranslateModule.forRoot({
                defaultLanguage: getInitialLanguage(),
                loader: {
                    provide: TranslateLoader,
                    useFactory: HttpLoaderFactory,
                    deps: [HttpClient],
                },
            })
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
