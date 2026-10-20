import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('parallel test workers never observe a partially installed Electron runtime', t => {
    const root = mkdtempSync(join(tmpdir(), 'arm-nator-test-runtime-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const directory of ['apps', 'libs', 'tools/embedded-mpv', 'tools/packaging', 'tools/testing', 'node_modules/electron']) {
        mkdirSync(join(root, directory), { recursive: true });
    }
    copyFileSync(new URL('./run-node-tests.mjs', import.meta.url), join(root, 'tools/testing/run-node-tests.mjs'));
    symlinkSync(dirname(require.resolve('tsx/package.json')), join(root, 'node_modules/tsx'), 'dir');
    writeFileSync(join(root, 'tsconfig.base.json'), '{}');

    // Use Electron's real first-use installer wrapper. In a worker, hold
    // extraction open until its peer has read the visible, incomplete binary.
    const electronRoot = join(root, 'node_modules/electron');
    copyFileSync(require.resolve('electron'), join(electronRoot, 'index.js'));
    writeFileSync(join(electronRoot, 'path.txt'), 'electron');
    writeFileSync(join(electronRoot, 'install.js'), `
        const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        mkdirSync(join(__dirname, 'dist'), { recursive: true });
        const binary = join(__dirname, 'dist/electron');
        writeFileSync(binary, 'incomplete');
        const deadline = Date.now() + 10000;
        while (process.env.NODE_TEST_CONTEXT && !existsSync(join(__dirname, 'observed'))) {
            if (Date.now() > deadline) throw new Error('Peer never observed extraction');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        writeFileSync(binary, 'ready');
    `);
    for (const name of ['first', 'second']) {
        writeFileSync(join(root, `tools/testing/${name}.test.mjs`), `
            import assert from 'node:assert/strict';
            import { existsSync, readFileSync, writeFileSync } from 'node:fs';
            import { createRequire } from 'node:module';
            import { dirname, join } from 'node:path';
            import test from 'node:test';
            const require = createRequire(import.meta.url);
            const root = dirname(require.resolve('electron'));
            if (${name === 'second'}) {
                const deadline = Date.now() + 10000;
                while (!existsSync(join(root, 'dist/electron'))) {
                    if (Date.now() > deadline) throw new Error('Extraction never started');
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
            }
            const binary = require('electron');
            const contents = readFileSync(binary, 'utf8');
            if (${name === 'second'}) writeFileSync(join(root, 'observed'), 'yes');
            test('runtime is completely extracted', () => {
                assert.equal(contents, 'ready');
            });
        `);
    }
    const env = { ...process.env, ARM_NATOR_NODE_TEST_CONCURRENCY: '2' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['tools/testing/run-node-tests.mjs'], {
        cwd: root, env, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
    assert.match(result.stdout, /(?:pass 2|# pass 2)/);
});
