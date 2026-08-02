import { BrowserWindow, ipcMain } from 'electron';
import type {
    BrowserViewBounds,
    BrowserViewBoundsTarget,
    BrowserViewCommand,
    BrowserViewEmbeddedCommand,
    BrowserViewMode,
} from '@arm-nator/shared/interfaces';
import {
    BROWSER_VIEW_CLOSE,
    BROWSER_VIEW_COMMAND,
    BROWSER_VIEW_EMBEDDED_COMMAND,
    BROWSER_VIEW_OPEN,
    BROWSER_VIEW_SET_BOUNDS,
} from '@arm-nator/shared/interfaces';
import App from '../app';
import { browserViewService } from '../services/browser-view.service';

function getSenderWindow(
    event: Electron.IpcMainInvokeEvent
): Electron.BrowserWindow | null {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && window === App.mainWindow && !window.isDestroyed()
        ? window
        : null;
}

export default class BrowserEvents {
    static bootstrapBrowserEvents(): Electron.IpcMain {
        ipcMain.handle(
            BROWSER_VIEW_OPEN,
            (event, mode: BrowserViewMode, url?: string) => {
                const window = getSenderWindow(event);
                if (!window) {
                    throw new Error('The browser is not available.');
                }
                return browserViewService.open(window, mode, url);
            }
        );
        ipcMain.handle(
            BROWSER_VIEW_SET_BOUNDS,
            (
                event,
                bounds: BrowserViewBounds,
                target?: BrowserViewBoundsTarget
            ) => {
                const window = getSenderWindow(event);
                if (window) {
                    browserViewService.setBounds(window, bounds, target);
                }
            }
        );
        ipcMain.handle(
            BROWSER_VIEW_COMMAND,
            (event, command: BrowserViewCommand) => {
                const window = getSenderWindow(event);
                return window
                    ? browserViewService.execute(window, command)
                    : null;
            }
        );
        ipcMain.handle(
            BROWSER_VIEW_CLOSE,
            (event, mode?: BrowserViewMode, terminate?: boolean) => {
                const window = getSenderWindow(event);
                if (window) {
                    browserViewService.close(window, mode, terminate);
                }
            }
        );
        ipcMain.on(
            BROWSER_VIEW_EMBEDDED_COMMAND,
            (event, command: BrowserViewEmbeddedCommand) => {
                void browserViewService.executeEmbeddedCommand(
                    event.sender,
                    command
                );
            }
        );
        return ipcMain;
    }
}

export function shutdownBrowserView(): void {
    browserViewService.shutdown();
}
