import { app, BrowserWindow, ipcMain } from 'electron';
import { createWebVideoFrameCapture } from './app/services/web-video-frame-capture';
import { getElectronUserDataPath } from '@arm-nator/database';
import fixPath from 'fix-path';
import App from './app/app';
import { PlaybackExitCoordinator } from './app/services/playback-exit-coordinator';
import { authorizePlaybackQuit, requestRendererPlaybackFlush } from './app/services/playback-exit-flush.service';
import { initDatabase } from './app/database/connection';
import DatabaseEvents from './app/events/database.events';
import ElectronEvents, { recordStartupMilestone } from './app/events/electron.events';
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
import SettingsEvents from './app/events/settings.events';
import SharedEvents from './app/events/shared.events';
import { isStartupTraceEnabled, trace } from './app/services/debug-trace';
import { registerStaticHeaderShims } from './app/services/request-header-overrides.service';
import { hlsPlaybackProxy } from './app/services/hls-playback-proxy.service';
import { databaseWorkerClient } from './app/services/database-worker-client';
import WindowEvents from './app/events/window.events';
import BrowserEvents, {
    shutdownBrowserView,
} from './app/events/browser.events';
import XtreamEvents from './app/events/xtream.events';
import StalkerEvents from './app/events/stalker.events';
import CredentialTesterEvents, {
    shutdownCredentialTesterBatches,
} from './app/events/credential-tester.events';
import { runEmbeddedMpvRuntimeDiagnosticOrContinue } from './app/services/embedded-mpv-runtime-diagnostic';
import { startWebApi, stopWebApi } from './app/services/web-api.service';
import { playbackDiagnostics } from './app/services/playback-diagnostics.service';

function installBrokenPipeHandlers(): void {
    for (const stream of [process.stdout, process.stderr]) {
        stream.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EPIPE') {
                return;
            }

            // Preserve the normal crash behavior for unexpected stream errors
            // without attempting to write another message to the broken stream.
            process.nextTick(() => {
                throw error;
            });
        });
    }
}

installBrokenPipeHandlers();

app.setName('arm-nator');

// A browser UI can run against the same database and provider proxy without
// opening an Electron window. This is the optional loopback web API mode.
const webApiOnly = process.argv.includes('--web-api-only');

const electronUserDataPath = getElectronUserDataPath();

if (electronUserDataPath) {
    app.setPath('userData', electronUserDataPath);
}
recordStartupMilestone('main-entry');

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

        if (webApiOnly) {
            await initDatabase();
            await databaseWorkerClient.request('DB_GET_APP_PLAYLIST_METAS', {});
            await startWebApi();
            console.log('[web-api] Database API listening on http://127.0.0.1:4310/api');
            return;
        }

        registerStaticHeaderShims();
        ElectronEvents.bootstrapElectronEvents();
        WindowEvents.bootstrapWindowEvents();
        BrowserEvents.bootstrapBrowserEvents();
        ipcMain.handle('PLAYER:CAPTURE_WEB_FRAME', createWebVideoFrameCapture(() => App.mainWindow));
        EmbeddedMpvEvents.bootstrapEmbeddedMpvEvents();
        KsPlayerMetalEvents.bootstrapKsPlayerMetalEvents();
        SharedEvents.bootstrapSharedEvents();
        PlayerEvents.bootstrapPlayerEvents();
        OpenSubtitlesEvents.bootstrapOpenSubtitlesEvents();
        SettingsEvents.bootstrapSettingsEvents();
        XtreamEvents.bootstrapXtreamEvents();
        StalkerEvents.bootstrapStalkerEvents();
        CredentialTesterEvents.bootstrapCredentialTesterEvents();
        DatabaseEvents.bootstrapDatabaseEvents();

        // Load the renderer only after IPC handlers are registered.
        recordStartupMilestone('before-renderer-load');
        await App.loadMainWindow();
        recordStartupMilestone('renderer-loaded');

        // Browser and YouTube views are created by their open actions. Loading
        // a remote page here competes with the cached dashboard and retains
        // several idle renderer processes before either feature is used.

        // Initialize the database after the first renderer load is underway.
        // IPC handlers call getDatabase() lazily and share the same promise.
        await initDatabase();
        recordStartupMilestone('database-ready');

        // Touch the worker before declaring startup healthy. This catches a
        // stale Electron-native SQLite binary at launch instead of allowing
        // the renderer to appear empty until its first database request.
        try {
            await databaseWorkerClient.request(
                'DB_GET_APP_PLAYLIST_METAS',
                {},
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const startupError = new Error(
                `Database worker initialization failed: ${message}`,
            );
            (startupError as Error & { cause?: unknown }).cause = error;
            throw startupError;
        }

        recordStartupMilestone('worker-ready');
        await startWebApi();

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

    const bootstrap = () => {
        recordStartupMilestone('before-window-bootstrap');
        // bootstrap app
        if (!webApiOnly) {
            Main.bootstrapApp();
        }
        recordStartupMilestone('after-window-bootstrap');

        // Bootstrap app events after Electron app is ready
        app.whenReady().then(async () => {
            recordStartupMilestone('electron-ready');
            playbackDiagnostics.record({
                event: 'app-start',
                transport: 'electron-main',
                details: `Electron ${process.versions.electron}; Node ${process.versions.node}; ${process.platform}-${process.arch}`,
            });
            if (isStartupTraceEnabled()) {
                trace('startup', 'app.whenReady');
            }
            try {
                await Main.bootstrapAppEvents();
            } catch (error) {
                console.error('ARM-Nator startup failed:', error);
                app.quit();
            }
        });

        const exitCoordinator = new PlaybackExitCoordinator(() => requestRendererPlaybackFlush(App.mainWindow?.webContents), { onError: error => console.error('Exit progress flush failed:', error) });
        app.on('before-quit', event => {
            if (exitCoordinator.deferQuit(event, () => { authorizePlaybackQuit(); app.quit(); })) return;
            void stopWebApi();
            void hlsPlaybackProxy.shutdown();
            void shutdownCredentialTesterBatches();
            shutdownBrowserView();
            shutdownKsPlayerMetal();
            shutdownEmbeddedMpv();
            shutdownMpvSession();
            shutdownVlcSession();
            void databaseWorkerClient.shutdown();
        });
    };

    if (webApiOnly) {
        // On macOS Electron remains alive without windows for the local API.
        bootstrap();
    } else {
        runEmbeddedMpvRuntimeDiagnosticOrContinue(process.argv, bootstrap);
    }
}
// trigger rebuild
