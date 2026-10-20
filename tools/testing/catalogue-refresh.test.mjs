import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildSync } from 'esbuild';

test('real Electron SQLite refresh lifecycle regressions', t => {
    const out = mkdtempSync(join(tmpdir(), 'arm-nator-refresh-bundle-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    const output = join(out, 'harness.cjs');
    buildSync({ entryPoints: ['tools/testing/catalogue-refresh.harness.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['better-sqlite3'], outfile: output, logLevel: 'silent' });
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: resolve('node_modules') };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(resolve('node_modules/.bin/electron'), [output], { env: childEnv, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
});
