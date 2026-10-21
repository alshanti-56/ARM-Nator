import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const configs = process.argv.slice(2).length
    ? process.argv.slice(2)
    : [
          'libs/providers/stalker/data-access/jest.config.ts',
          'libs/providers/stalker/feature/jest.config.ts',
          'libs/providers/xtream/feature/jest.config.ts',
          'tools/testing/jest.source-playback.config.ts',
      ];

function runConfig(config) {
    return new Promise((resolveRun) => {
        const child = spawn(
            resolve(workspaceRoot, 'node_modules/.bin/jest'),
            ['--config', config, '--runInBand'],
            {
                cwd: workspaceRoot,
                env: process.env,
                stdio: 'inherit',
            }
        );

        child.on('exit', (code, signal) => {
            resolveRun({ code: code ?? 1, signal });
        });
    });
}

for (const config of configs) {
    const result = await runConfig(config);
    if (result.signal) {
        process.kill(process.pid, result.signal);
    }
    if (result.code !== 0) {
        process.exit(result.code);
    }
}
