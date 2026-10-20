import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [appArgument, outputArgument] = process.argv.slice(2);
if (!appArgument || !outputArgument) throw new Error('Usage: sample-app-resources.mjs APP OUTPUT_JSON');
const app = resolve(appArgument);
const samples = [];
for (let i = 0; i < 7; i++) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid,ppid,%cpu,rss,command'], { encoding: 'utf8' })
        .split('\n').flatMap(line => {
            const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!match?.[5].startsWith(`${app}/Contents/`)) return [];
            return [{ pid: Number(match[1]), parentPid: Number(match[2]), cpu: Number(match[3]), rssKiB: Number(match[4]) }];
        });
    if (!processes.length) throw new Error('The supplied test app is not running');
    const resources = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./mac-process-resources.py', import.meta.url)), ...processes.map(p => String(p.pid))], { encoding: 'utf8' }));
    samples.push({ footprintBytes: resources.reduce((sum, p) => sum + p.footprintBytes, 0), resources, at: Date.now(), cpu: processes.reduce((sum, p) => sum + p.cpu, 0), rssKiB: processes.reduce((sum, p) => sum + p.rssKiB, 0), processes });
    if (i < 6) await new Promise(resolve => setTimeout(resolve, 1000));
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const result = { app, medianCpuPercent: median(samples.map(p => p.cpu)), medianPhysicalFootprintBytes: median(samples.map(p => p.footprintBytes)), medianAggregateRssKiB: median(samples.map(p => p.rssKiB)), note: 'Primary memory metric is aggregate macOS physical footprint (including compressed memory). RSS is recorded separately because background processes may be compressed. CPU is the macOS ps estimate.', samples };
writeFileSync(resolve(outputArgument), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ medianCpuPercent: result.medianCpuPercent, medianPhysicalFootprintBytes: result.medianPhysicalFootprintBytes, medianAggregateRssKiB: result.medianAggregateRssKiB }));
