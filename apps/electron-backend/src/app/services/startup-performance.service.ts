import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isPerformanceCaptureEnabled } from './debug-trace';

export function recordStartupMilestone(name: string): void {
    if (!isPerformanceCaptureEnabled()) return;
    try {
        const directory = join(app.getPath('userData'), 'performance');
        mkdirSync(directory, { recursive: true });
        appendFileSync(join(directory, 'startup-phases.jsonl'), JSON.stringify({
            name, at: Date.now(), pid: process.pid, nodeUptimeMs: process.uptime() * 1000,
        }) + '\n', { mode: 0o600 });
    } catch (error) { console.error('Unable to record startup milestone', error); }
}
