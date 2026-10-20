import { BrowserGuestHostComponent } from './browser-guest-host.component';
import { Component, effect, HostBinding, inject, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { WORKSPACE_SHELL_ACTIONS } from '@arm-nator/workspace/shell/util';
import { PlaylistActions } from '@arm-nator/providers/shared/playlist-state';
import {
    RuntimeCapabilitiesService,
    SettingsStore,
} from '@arm-nator/services';
import {
    Language,
    Settings,
    STORE_KEY,
    Theme,
} from '@arm-nator/shared/interfaces';
import { SettingsService } from '@arm-nator/settings/data-access';
import { isTypingInInput } from '@arm-nator/providers/shared/util';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [RouterOutlet, TranslatePipe, BrowserGuestHostComponent],
})
export class AppComponent implements OnInit {
    @HostBinding('class.macos-platform') get isMacOS() {
        return this.runtime.isMacOS;
    }
    private router = inject(Router);
    private store = inject(Store);
    private translate = inject(TranslateService);
    private settingsService = inject(SettingsService);
    private settingsStore = inject(SettingsStore);
    private runtime = inject(RuntimeCapabilitiesService);
    private readonly workspaceShellActions = inject(WORKSPACE_SHELL_ACTIONS);
    readonly bundledKsPlayerWarning = signal<string | null>(null);

    /** Default language as fallback */
    private readonly DEFAULT_LANG = Language.ENGLISH;

    constructor() {
        effect(() => {
            const size = this.settingsStore.coverSize?.() ?? 'medium';
            document.documentElement.dataset.coverSize = size;
        });

        if (this.runtime.isElectron) {
            document.addEventListener('keydown', (event) => {
                if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'r') return;
                // Suppress Chromium reload even when an editor owns focus.
                event.preventDefault();
                if (event.isComposing || event.altKey || event.shiftKey || isTypingInInput(event)) return;
                this.workspaceShellActions.openGlobalRecent();
            });
        }
    }

    ngOnInit() {
        this.store.dispatch(PlaylistActions.loadPlaylists());
        this.initSettings();
        void this.loadBundledKsPlayerSupport();
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

                    const resolvedLang = this.DEFAULT_LANG;
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

    private async loadBundledKsPlayerSupport(): Promise<void> {
        if (!this.runtime.isElectron || typeof window === 'undefined') {
            return;
        }

        if (typeof window.electron?.getKsPlayerMetalSupport !== 'function') {
            this.bundledKsPlayerWarning.set(
                'The bundled KS Player runtime is unavailable in this build.'
            );
            return;
        }

        try {
            const support = await window.electron.getKsPlayerMetalSupport();
            if (!support.supported) {
                this.bundledKsPlayerWarning.set(
                    support.reason ??
                        'The bundled KS Player runtime could not be loaded.'
                );
            }
        } catch (error) {
            this.bundledKsPlayerWarning.set(
                error instanceof Error
                    ? error.message
                    : 'The bundled KS Player runtime could not be loaded.'
            );
        }
    }

    /**
     * Navigate to the specified route
     * @param route route to navigate to
     */
    navigateToRoute(route: string) {
        this.router.navigateByUrl(route);
    }

}
