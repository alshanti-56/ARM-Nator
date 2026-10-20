import fs from 'node:fs';
import path from 'node:path';
import { ensureNativeBuild } from './ensure-native-inputs.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    stageKSPlayerMetalMainBundleResources
} = require('./packaging/ksplayer-metal-packaging.cjs');

function stageElectronResources() {
    const electronApp = path.resolve(require('electron'), '..', '..', '..');
    stageKSPlayerMetalMainBundleResources(
        path.join(electronApp, 'Contents', 'Resources'),
        electronApp,
        releaseDirectory
    );
    console.log('[dev] KSPlayer Metal resources staged for Electron.');
}

const workspaceRoot = process.cwd();
const releaseDirectory = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native',
    'build',
    'Release'
);
const distNativeDirectory = path.join(
    workspaceRoot,
    'dist',
    'apps',
    'electron-backend',
    'native'
);

function removeStaleDistNativeTree() {
    if (!fs.existsSync(distNativeDirectory)) return;

    console.log(
        '[dev] Removing stale generated native output before rebuilding...'
    );
    fs.rmSync(distNativeDirectory, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150
    });
}

try {
    const ksplayer = ensureNativeBuild({ root: workspaceRoot, kind: 'ksplayer-metal' });
    const mpv = ensureNativeBuild({ root: workspaceRoot, kind: 'embedded-mpv' });
    if (ksplayer.rebuilt || mpv.rebuilt) removeStaleDistNativeTree();
    stageElectronResources();
    console.log(`[dev] Native inputs verified; ${ksplayer.rebuilt || mpv.rebuilt ? 'changed inputs rebuilt' : 'reusing native binaries'}.`);
} catch (error) {
    console.error('[dev] Native input verification failed:', error);
    process.exitCode = 1;
}
