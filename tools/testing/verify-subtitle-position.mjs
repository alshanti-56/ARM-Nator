#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [includeDirectory, libraryDirectory] = process.argv.slice(2);
assert.ok(includeDirectory && libraryDirectory,
    'Usage: node tools/testing/verify-subtitle-position.mjs <include-directory> <library-directory>');

const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sourceFile = path.join(workspaceRoot, 'tools/testing/verify-subtitle-position.c');
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-nator-libass-position-'));
const executable = path.join(temporaryDirectory, 'verify-subtitle-position');

try {
    const compile = spawnSync('clang', [
        '-std=c11',
        `-I${includeDirectory}`,
        sourceFile,
        `-L${libraryDirectory}`,
        '-lass',
        `-Wl,-rpath,${libraryDirectory}`,
        '-o',
        executable
    ], { encoding: 'utf8' });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));

    const run = spawnSync(executable, [], {
        encoding: 'utf8',
        env: {
            ...process.env,
            DYLD_LIBRARY_PATH: [libraryDirectory, process.env.DYLD_LIBRARY_PATH]
                .filter(Boolean)
                .join(path.delimiter)
        }
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    assert.equal(run.status, 0, `libass renderer regression failed with status ${run.status ?? 1}`);
} finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
