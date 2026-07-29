#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(toolDirectory, '..', '..');
const runtimeRoot = path.join(
    workspaceRoot,
    'vendor',
    'embedded-mpv',
    'darwin-arm64'
);
const buildPrefix = path.join(
    os.tmpdir(),
    'arm-nator-embedded-mpv-prefix',
    'darwin-arm64'
);

function runtimeExists() {
    return (
        fs.existsSync(path.join(runtimeRoot, 'include', 'mpv', 'client.h')) &&
        ['libmpv.2.dylib', 'libmpv.dylib'].some((name) =>
            fs.existsSync(path.join(runtimeRoot, 'lib', name))
        ) &&
        fs.existsSync(path.join(runtimeRoot, 'runtime-manifest.json'))
    );
}

function run(script, args) {
    const result = spawnSync(
        process.execPath,
        [path.join(toolDirectory, script), ...args],
        {
            cwd: workspaceRoot,
            stdio: 'inherit'
        }
    );
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    console.error('The embedded MPV runtime requires macOS on Apple Silicon.');
    process.exit(1);
}

if (runtimeExists()) {
    console.log('Portable embedded MPV runtime is already staged.');
    process.exit(0);
}

console.log(
    'Portable embedded MPV runtime is missing; building pinned LGPL sources.'
);
run('build-macos-runtime.mjs', [buildPrefix]);
run('stage-macos-runtime.mjs', [buildPrefix]);
