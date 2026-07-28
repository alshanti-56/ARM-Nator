/**
 * This module is responsible on handling all the inter process communications
 * between the frontend to the electron backend.
 */

import { app, ipcMain } from 'electron';
import { environment } from '../../environments/environment';
import {
    DEBUG_TRACE_EVENT_CHANNEL,
    isRendererApiTraceEnabled,
    trace,
} from '../services/debug-trace';

export default class ElectronEvents {
  static bootstrapElectronEvents(): Electron.IpcMain {
    return ipcMain;
  }
}

// Retrieve app version
ipcMain.handle('get-app-version', (event) => {
  console.log(`Fetching application version... [v${environment.version}]`);

  return environment.version;
});

// Handle App termination
ipcMain.on('quit', (event, code) => {
  app.exit(code);
});

ipcMain.on(DEBUG_TRACE_EVENT_CHANNEL, (event, payload) => {
  if (!isRendererApiTraceEnabled()) {
    return;
  }

  trace('renderer-api', 'event', {
    payload,
    senderId: event.sender.id,
    url: event.sender.getURL(),
  });
});
