import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function verify(t, change = () => {}) {
    const root = mkdtempSync(join(tmpdir(), 'arm-nator-toolchain-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'tools'));
    mkdirSync(join(root, 'bin'));
    const manifest = {
        engines: { node: process.versions.node, pnpm: '12.11.2' },
        packageManager: 'pnpm@12.11.2',
        devEngines: { runtime: { name: 'node', version: process.versions.node, onFail: 'error' } },
    };
    const fixture = { manifest, nvmrc: process.versions.node, pnpm: '12.11.2' };
    change(fixture);
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(root, '.nvmrc'), fixture.nvmrc);
    writeFileSync(join(root, 'tools/verify-environment.mjs'), readFileSync(new URL('../verify-environment.mjs', import.meta.url)));
    for (const [command, version] of [['pnpm', fixture.pnpm], ['swift', 'Swift test fixture'], ['xcodebuild', 'Xcode test fixture']]) {
        writeFileSync(join(root, 'bin', command), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
    }
    return spawnSync(process.execPath, [join(root, 'tools/verify-environment.mjs')], {
        env: { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin` },
        encoding: 'utf8',
        timeout: 15_000,
    });
}

test('accepts a consistent toolchain', (t) => {
    const result = verify(t);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Environment verification passed/);
});

test('rejects a Node version file that disagrees with the manifest', (t) => {
    const result = verify(t, (f) => { f.nvmrc = '22.23.3'; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.nvmrc.*engines\.node/);
});

test('rejects a package manager pin that disagrees with the required pnpm', (t) => {
    const result = verify(t, (f) => { f.manifest.packageManager = 'pnpm@11.19.0'; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /packageManager.*engines\.pnpm/);
});

test('rejects a managed Node runtime that disagrees with the required Node', (t) => {
    const result = verify(t, (f) => { f.manifest.devEngines.runtime.version = '24.19.0'; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /devEngines\.runtime.*engines\.node/);
});

test('rejects a missing runtime pin', (t) => {
    const result = verify(t, (f) => { delete f.manifest.devEngines; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /devEngines\.runtime/);
});

test('rejects automatic Node downloads in the direct-install configuration', (t) => {
    const result = verify(t, (f) => { f.manifest.devEngines.runtime.onFail = 'download'; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /devEngines\.runtime.*onFail: error/);
});

test('rejects an incompatible pnpm on PATH with recovery instructions', (t) => {
    const result = verify(t, (f) => { f.pnpm = '11.25.0'; });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pnpm 12\.11\.2 is required.*11\.25\.0/);
    assert.match(result.stderr, /npm install --global pnpm@12\.11\.2/);
});
