import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

test('packaged window loads even when unrelated session storage cleanup would never settle', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'arm-nator-window-startup-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bundle = join(directory, 'app.cjs');
    await build({ entryPoints: ['apps/electron-backend/src/app/app.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: bundle, logLevel: 'silent', plugins: [{
        name: 'isolated-window-preferences', setup(build) {
            build.onResolve({ filter: /\/store\.service$/ }, () => ({ path: 'store', namespace: 'test-store' }));
            build.onLoad({ filter: /.*/, namespace: 'test-store' }, () => ({ contents: 'export const WINDOW_BOUNDS="WINDOW_BOUNDS"; export const store={get:()=>undefined,set:()=>{}};', loader: 'js' }));
        },
    }] });
    const harness = join(directory, 'harness.cjs');
    writeFileSync(harness, readFileSync(resolve('tools/testing/packaged-window-startup.harness.cjs')));
    const child = spawnSync(process.execPath, [harness, bundle], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, ARM_NATOR_PERF_CAPTURE: '0', ELECTRON_IS_DEV: '0' } });
    assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr);
});
