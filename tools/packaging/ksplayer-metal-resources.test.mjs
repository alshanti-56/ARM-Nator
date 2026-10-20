import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageKSPlayerMetalMainBundleResources } from './ksplayer-metal-packaging.cjs';

function fixture(t) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'arm-nator-metal-resources-')
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        root,
        resources: path.join(root, 'Electron.app', 'Contents', 'Resources')
    };
}

function makeRuntime(nativeRoot) {
    const bundle = path.join(
        nativeRoot,
        'ksplayer-metal',
        'KSPlayer_KSPlayer.bundle'
    );
    const resources = path.join(bundle, 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(
        path.join(resources, 'default.metallib'),
        'fixture shaders'
    );
    fs.writeFileSync(
        path.join(bundle, 'Contents', 'Info.plist'),
        'fixture bundle'
    );
}

function verifyStaged(resources) {
    assert.equal(
        fs.readFileSync(path.join(resources, 'default.metallib'), 'utf8'),
        'fixture shaders'
    );
    assert.equal(
        fs.readFileSync(
            path.join(
                resources,
                'KSPlayer_KSPlayer.bundle',
                'Contents',
                'Info.plist'
            ),
            'utf8'
        ),
        'fixture bundle'
    );
}

test('stages KSPlayer shaders from a relocated development runtime', (t) => {
    const { root, resources } = fixture(t);
    const nativeRoot = path.join(root, 'different-checkout', 'native');
    makeRuntime(nativeRoot);
    fs.mkdirSync(resources, { recursive: true });
    stageKSPlayerMetalMainBundleResources(resources, undefined, nativeRoot);
    verifyStaged(resources);
});

test('keeps the packaged runtime resource layout working', (t) => {
    const { resources } = fixture(t);
    makeRuntime(
        path.join(resources, 'app.asar.unpacked', 'electron-backend', 'native')
    );
    stageKSPlayerMetalMainBundleResources(resources);
    verifyStaged(resources);
});

test('rejects an incomplete KSPlayer resource bundle before playback', (t) => {
    const { root, resources } = fixture(t);
    assert.throws(
        () =>
            stageKSPlayerMetalMainBundleResources(
                resources,
                undefined,
                path.join(root, 'missing')
            ),
        /Cannot stage KSPlayer Metal resources/
    );
});
