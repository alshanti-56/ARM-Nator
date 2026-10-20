import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function runner() {
    const name = '../ensure-native-inputs.mjs';
    const module = await import(name).catch(() => null);
    assert.equal(typeof module?.ensureNativeBuild, 'function');
    return module.ensureNativeBuild;
}
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'arm-native-cache-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = join(root, 'apps/electron-backend/native/src/embedded_mpv.mm');
    mkdirSync(join(root, 'apps/electron-backend/native/src'), { recursive: true });
    writeFileSync(source, 'native version one');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '44.7.0' } }));
    const output = join(root, 'apps/electron-backend/native/build/Release');
    const build = () => {
        for (const name of ['embedded_mpv.node', 'embedded-mpv-runtime.json', 'lib/libmpv.2.dylib', 'ffmpeg']) {
            const p = join(output, name); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, readFileSync(source));
        }
    };
    return { root, source, output, build };
}
test('renderer edits reuse native artifacts; native edits rebuild them', async t => {
    const run = await runner(); const f = fixture(t);
    const opts = { root: f.root, kind: 'embedded-mpv', toolchain: 'fixture-sdk', build: f.build };
    assert.equal(run(opts).rebuilt, true);
    mkdirSync(join(f.root, 'apps/desktop-ui'), { recursive: true }); writeFileSync(join(f.root, 'apps/desktop-ui/styles.scss'), 'renderer change');
    assert.equal(run(opts).rebuilt, false);
    writeFileSync(f.source, 'native version two');
    assert.equal(run(opts).rebuilt, true);
    assert.equal(readFileSync(join(f.output, 'embedded_mpv.node'), 'utf8'), 'native version two');
    rmSync(join(f.output, 'ffmpeg'));
    assert.equal(run(opts).rebuilt, true);
});
test('a failed build never leaves a reusable success stamp', async t => {
    const run = await runner(); const f = fixture(t);
    const opts = { root: f.root, kind: 'embedded-mpv', toolchain: 'fixture-sdk', build: f.build };
    run(opts);
    writeFileSync(f.source, 'new version');
    assert.throws(() => run({ ...opts, build: () => { throw new Error('compiler failure'); } }), /compiler failure/);
    assert.equal(existsSync(join(f.output, '.embedded-mpv-inputs.json')), false);
    assert.equal(run(opts).rebuilt, true);
});

test('source changes during compilation cannot stamp stale artifacts as current', async t => {
    const run = await runner(); const f = fixture(t);
    const opts = { root: f.root, kind: 'embedded-mpv', toolchain: 'fixture-sdk', build: f.build };
    run({ ...opts, build: () => { f.build(); writeFileSync(f.source, 'changed during compilation'); } });
    assert.equal(run(opts).rebuilt, true);
    assert.equal(readFileSync(join(f.output, 'embedded_mpv.node'), 'utf8'), 'changed during compilation');
});
