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
import { shutdownMpvSession } from './app/events/mpv-session.service';
import PlayerEvents from './app/events/player.events';
import { shutdownVlcSession } from './app/events/vlc-session.service';
import PlaylistEvents from './app/events/playlist.events';
import SettingsEvents from './app/events/settings.events';
import SharedEvents from './app/events/shared.events';
import { isStartupTraceEnabled, trace } from './app/services/debug-trace';
import { registerStaticHeaderShims } from './app/services/request-header-overrides.service';
import { databaseWorkerClient } from './app/services/database-worker-client';
import WindowEvents from './app/events/window.events';
import XtreamEvents from './app/events/xtream.events';
import {
    isFrameCopyRuntimeUsable,
    shouldPromotePersistedFrameCopyOptIn,
} from './app/services/embedded-mpv-frame-copy-platform.util';
import { isEmbeddedMpvFeatureEnabled } from './app/services/embedded-mpv-runtime-policy.util';
import { runEmbeddedMpvRuntimeDiagnosticOrContinue } from './app/services/embedded-mpv-runtime-diagnostic';
import { EMBEDDED_MPV_FRAME_COPY, store } from './app/services/store.service';

app.setName('arm-nator');

const electronUserDataPath = getElectronUserDataPath();

if (electronUserDataPath) {
    app.setPath('userData', electronUserDataPath);
}

// The frame-copy embedded MPV engine must be decided before the main window
// exists: it relaxes the window sandbox for the preload frame pump, and
// webPreferences are fixed at window creation. The Settings toggle persists
// to the main-process config store; an explicitly set env var (including
// '0') always wins so dev/CI behavior stays scriptable.
if (
    isEmbeddedMpvFeatureEnabled() &&
    shouldPromotePersistedFrameCopyOptIn(
        store.get(EMBEDDED_MPV_FRAME_COPY, false),
        process.env.ARM_NATOR_ENABLE_EMBEDDED_MPV_FRAME_COPY,
        isFrameCopyRuntimeUsable
    )
) {
    process.env.ARM_NATOR_ENABLE_EMBEDDED_MPV_FRAME_COPY = '1';
}

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
        EmbeddedMpvEvents.bootstrapEmbeddedMpvEvents();
        PlaylistEvents.bootstrapPlaylistEvents();
        SharedEvents.bootstrapSharedEvents();
        PlayerEvents.bootstrapPlayerEvents();
        SettingsEvents.bootstrapSettingsEvents();
        XtreamEvents.bootstrapXtreamEvents();
        DatabaseEvents.bootstrapDatabaseEvents();

        // Load the renderer only after IPC handlers are registered.
        await App.loadMainWindow();

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
        shutdownEmbeddedMpv();
        shutdownMpvSession();
        shutdownVlcSession();
        void databaseWorkerClient.shutdown();
    });
});
