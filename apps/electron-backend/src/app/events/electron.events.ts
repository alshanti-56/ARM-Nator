/**
 * This module is responsible on handling all the inter process communications
 * between the frontend to the electron backend.
 */

import { app, ipcMain } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from '../../environments/environment';
import {
    DEBUG_TRACE_EVENT_CHANNEL,
    isRendererApiTraceEnabled,
    isPerformanceCaptureEnabled,
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

// Opt-in local timing captures use actual data readiness and two paint frames.
const processStartedAt = Date.now() - process.uptime() * 1000;
const dashboardSenders = new Set<number>();
ipcMain.on('ARM_NATOR_UI_PERFORMANCE', (event, sample) => {
  if (!isPerformanceCaptureEnabled() || !sample ||
      !['dashboard', 'category', 'search'].includes(sample.name) ||
      !Number.isFinite(sample.startedAt) || !Number.isFinite(sample.paintedAt) ||
      sample.paintedAt < sample.startedAt) return;
  const startup = sample.name === 'dashboard' && !dashboardSenders.has(event.sender.id);
  if (startup) dashboardSenders.add(event.sender.id);
  const record = { name: startup ? 'startup-dashboard' : sample.phase === 'catalogue-read' ? 'category-catalogue-read' : sample.name,
    durationMs: sample.paintedAt - (startup ? (app.getAppMetrics().find(metric => metric.pid === process.pid)?.creationTime ?? processStartedAt) : sample.startedAt),
    nodeDurationMs: startup ? sample.paintedAt - processStartedAt : undefined,
    at: sample.paintedAt, pid: process.pid };
  try {
    const directory = join(app.getPath('userData'), 'performance');
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, 'ui-timings.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
  } catch (error) { console.error('Unable to record UI performance', error); }
});

export { recordStartupMilestone } from '../services/startup-performance.service';
