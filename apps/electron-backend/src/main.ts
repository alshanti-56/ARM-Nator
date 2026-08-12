import { app, BrowserWindow } from 'electron';
import { getElectronUserDataPath } from '@arm-nator/database';
import fixPath from 'fix-path';
import App from './app/app';
import { initDatabase } from './app/database/connection';
import DatabaseEvents from './app/events/database.events';
import ElectronEvents from './app/events/electron.events';
import EmbeddedMpvEvents, {
    shutdownEmbeddedMpv,
} from './app/events/embedded-mpv.events';
import KsPlayerMetalEvents, {
    shutdownKsPlayerMetal,
} from './app/events/ksplayer-metal.events';
import { shutdownMpvSession } from './app/events/mpv-session.service';
import PlayerEvents from './app/events/player.events';
import OpenSubtitlesEvents from './app/events/open-subtitles.events';
import { shutdownVlcSession } from './app/events/vlc-session.service';
import PlaylistEvents from './app/events/playlist.events';
import SettingsEvents from './app/events/settings.events';
import SharedEvents from './app/events/shared.events';
import { isStartupTraceEnabled, trace } from './app/services/debug-trace';
import { registerStaticHeaderShims } from './app/services/request-header-overrides.service';
import { databaseWorkerClient } from './app/services/database-worker-client';
import WindowEvents from './app/events/window.events';
import BrowserEvents, {
    shutdownBrowserView,
} from './app/events/browser.events';
import { browserViewService } from './app/services/browser-view.service';
import XtreamEvents from './app/events/xtream.events';
import StalkerEvents from './app/events/stalker.events';
import CredentialTesterEvents, {
    shutdownCredentialTesterBatches,
} from './app/events/credential-tester.events';
import { runEmbeddedMpvRuntimeDiagnosticOrContinue } from './app/services/embedded-mpv-runtime-diagnostic';

app.setName('arm-nator');

const electronUserDataPath = getElectronUserDataPath();

if (electronUserDataPath) {
    app.setPath('userData', electronUserDataPath);
}

// Keep development and packaged launches single-instance for this app's
// user-data directory. A generic Electron shell from another checkout uses a
// different user-data directory and is not the ARM-Nator app.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

let fixPathScheduled = false;

/**
 * Update process.env.PATH from the user's interactive login shell so that
 * spawned external players (MPV/VLC) can be resolved by binary name.
 *
 * Runs after window creation + IPC handler registration so the 50-300 ms
 * shell-spawn cost (bash/zsh -ilc env) doesn't block startup. Idempotent:
 * subsequent calls are no-ops.
 */
function scheduleDeferredFixPath(): void {
    if (fixPathScheduled) {
        return;
    }

    fixPathScheduled = true;
    setImmediate(() => {
        try {
            fixPath();
            if (isStartupTraceEnabled()) {
                trace('startup', 'fix-path:done');
            }
        } catch (error) {
            console.warn('fix-path failed:', error);
        }
    });
}

export default class Main {
    static bootstrapApp() {
        if (isStartupTraceEnabled()) {
            trace('startup', 'bootstrap-app');
        }
        App.main(app, BrowserWindow);
    }

    static async bootstrapAppEvents() {
        if (isStartupTraceEnabled()) {
            trace('startup', 'bootstrap-events:start');
        }

        registerStaticHeaderShims();
        ElectronEvents.bootstrapElectronEvents();
        WindowEvents.bootstrapWindowEvents();
        BrowserEvents.bootstrapBrowserEvents();
        EmbeddedMpvEvents.bootstrapEmbeddedMpvEvents();
        KsPlayerMetalEvents.bootstrapKsPlayerMetalEvents();
        PlaylistEvents.bootstrapPlaylistEvents();
        SharedEvents.bootstrapSharedEvents();
        PlayerEvents.bootstrapPlayerEvents();
        OpenSubtitlesEvents.bootstrapOpenSubtitlesEvents();
        SettingsEvents.bootstrapSettingsEvents();
        XtreamEvents.bootstrapXtreamEvents();
        StalkerEvents.bootstrapStalkerEvents();
        CredentialTesterEvents.bootstrapCredentialTesterEvents();
        DatabaseEvents.bootstrapDatabaseEvents();

        // Load the renderer only after IPC handlers are registered.
        await App.loadMainWindow();

        if (App.mainWindow && !App.mainWindow.isDestroyed()) {
            void browserViewService
                .preloadYoutube(App.mainWindow)
                .catch((error) => {
                    console.warn('YouTube preload failed:', error);
                });
        }

        // Initialize the database after the first renderer load is underway.
        // IPC handlers call getDatabase() lazily and share the same promise.
        await initDatabase();

        if (isStartupTraceEnabled()) {
            trace('startup', 'init-database:done');
        }

        if (isStartupTraceEnabled()) {
            trace('startup', 'bootstrap-events:done');
        }

        // Hydrate process.env.PATH from the user's login shell now — after
        // the window has loaded and IPC handlers are live. Fire-and-forget
        // (setImmediate) so it doesn't gate any user-visible work. Worst
        // case: the user clicks an external player within the ~100 ms it
        // takes to complete; the spawn would still find MPV/VLC at any of
        // the well-known paths checked by getDefault*Path before falling
        // back to bare-name PATH lookup.
        scheduleDeferredFixPath();
    }
}

if (!hasSingleInstanceLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const window = App.mainWindow;
        if (!window || window.isDestroyed()) {
            return;
        }
        if (window.isMinimized()) {
            window.restore();
        }
        window.show();
        window.focus();
    });

    runEmbeddedMpvRuntimeDiagnosticOrContinue(process.argv, () => {
        // bootstrap app
        Main.bootstrapApp();

        // Bootstrap app events after Electron app is ready
        app.whenReady().then(async () => {
            if (isStartupTraceEnabled()) {
                trace('startup', 'app.whenReady');
            }
            await Main.bootstrapAppEvents();
        });

        app.on('before-quit', () => {
            void shutdownCredentialTesterBatches();
            shutdownBrowserView();
            shutdownKsPlayerMetal();
            shutdownEmbeddedMpv();
            shutdownMpvSession();
            shutdownVlcSession();
            void databaseWorkerClient.shutdown();
        });
    });
}
