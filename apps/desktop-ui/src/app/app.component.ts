import { Component, effect, HostBinding, inject, OnInit } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { Actions, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { WORKSPACE_SHELL_ACTIONS } from '@arm-nator/workspace/shell/util';
import { PlaylistActions, selectAllPlaylistsMeta } from '@arm-nator/providers/m3u/state';
import { filter, take } from 'rxjs';
import {
    DataService,
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@arm-nator/services';
import {
    AUTO_UPDATE_PLAYLISTS,
    Language,
    Settings,
    STORE_KEY,
    Theme,
    createDevLogger,
} from '@arm-nator/shared/interfaces';
import { SettingsService } from '@arm-nator/settings/data-access';

const debugAppComponent = createDevLogger('AppComponent');

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    imports: [RouterOutlet],
})
export class AppComponent implements OnInit {
    @HostBinding('class.macos-platform') get isMacOS() {
        return this.runtime.isMacOS;
    }
    private actions$ = inject(Actions);
    private dataService = inject(DataService);
    private router = inject(Router);
    private store = inject(Store);
    private translate = inject(TranslateService);
    private settingsService = inject(SettingsService);
    private settingsStore = inject(SettingsStore);
    private runtime = inject(RuntimeCapabilitiesService);
    private readonly workspaceShellActions = inject(WORKSPACE_SHELL_ACTIONS);

    /** Default language as fallback */
    private readonly DEFAULT_LANG = Language.ENGLISH;

    constructor() {
        effect(() => {
            const size = this.settingsStore.coverSize?.() ?? 'medium';
            document.documentElement.dataset.coverSize = size;
        });

        if (this.runtime.isElectron) {
            document.addEventListener('keydown', (event) => {
                if (event.ctrlKey || event.metaKey) {
                    if (event.key === 'r') {
                        event.preventDefault();
                        this.workspaceShellActions.openGlobalRecent();
                    }
                }
            });
        }
    }

    ngOnInit() {
        this.store.dispatch(PlaylistActions.loadPlaylists());
        this.translate.setDefaultLang(this.DEFAULT_LANG);

        this.initSettings();
        this.triggerAutoUpdatePlaylists();
    }

    /**
     * Reads the settings object from local storage and initializes the
     * application based on them
     */
    initSettings(): void {
        this.settingsService
            .getValueFromLocalStorage<Settings>(STORE_KEY.Settings)
            .subscribe((settings: Settings) => {
                if (settings && Object.keys(settings).length > 0) {
                    // No need to send settings to Electron on init
                    // Settings are stored in IndexedDB and loaded by the settings store
                    // Only specific Electron settings (MPV/VLC paths) are sent when changed in settings component

                    const resolvedLang = settings.language ?? this.DEFAULT_LANG;
                    this.translate.use(resolvedLang);
                    // Mirror the active language to localStorage so the next
                    // cold start can read it synchronously in app.config.ts's
                    // getInitialLanguage() and avoid the English-then-localized
                    // flash for non-English users.
                    try {
                        localStorage.setItem(
                            'arm-nator:preferred-language',
                            resolvedLang
                        );
                    } catch {
                        // Ignore quota / privacy mode errors.
                    }

                    if (settings.theme) {
                        this.settingsService.changeTheme(settings.theme);
                    } else {
                        this.detectDarkMode();
                    }
                } else {
                    this.detectDarkMode();
                }
            });
    }

    /**
     * Applies the operating system color scheme when no explicit theme is set
     */
    detectDarkMode(): void {
        this.settingsService.changeTheme(Theme.SystemTheme);
    }

    /**
     * Navigate to the specified route
     * @param route route to navigate to
     */
    navigateToRoute(route: string) {
        this.router.navigateByUrl(route);
    }

    /**
     * Triggers auto-update for playlists that have autoRefresh enabled
     */
    private triggerAutoUpdatePlaylists(): void {
        // Wait for playlists to be loaded successfully
        this.actions$
            .pipe(
                ofType(PlaylistActions.loadPlaylistsSuccess),
                take(1) // Only trigger once on app startup
            )
            .subscribe(() => {
                // Get all playlists from store
                this.store
                    .select(selectAllPlaylistsMeta)
                    .pipe(
                        take(1),
                        filter((playlists) => playlists.length > 0)
                    )
                    .subscribe((playlists) => {
                        // Filter playlists with autoRefresh enabled
                        const playlistsToUpdate = playlists.filter(
                            (playlist) => playlist.autoRefresh === true
                        );

                        // Trigger auto-update if there are playlists to update
                        if (playlistsToUpdate.length > 0) {
                            debugAppComponent(
                                `Auto-updating ${playlistsToUpdate.length} playlist(s) on startup`
                            );
                            this.dataService.sendIpcEvent(
                                AUTO_UPDATE_PLAYLISTS,
                                playlistsToUpdate
                            );
                        }
                    });
            });
    }
}
