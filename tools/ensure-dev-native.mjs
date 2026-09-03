import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const workspaceRoot = process.cwd();
const releaseDirectory = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native',
    'build',
    'Release'
);

// Development should consume the native players already built for the current
// checkout. The full rebuild remains available through `pnpm dev:native` and
// is intentionally not part of every renderer restart.
const requiredArtifacts = [
    'embedded_mpv.node',
    'embedded-mpv-runtime.json',
    'ksplayer_metal.node',
    'ksplayer-metal-runtime.json',
    path.join('lib', 'libmpv.2.dylib'),
    path.join('ksplayer-metal', 'KSPlayerMetalRuntime.dylib'),
    path.join('ksplayer-metal', 'KSPlayer_KSPlayer.bundle'),
    path.join('ksplayer-metal', 'Frameworks')
];

const missingArtifacts = requiredArtifacts.filter(
    (relativePath) => !fs.existsSync(path.join(releaseDirectory, relativePath))
);

if (missingArtifacts.length === 0) {
    console.log('[dev] Native player artifacts are present; skipping native rebuild.');
    process.exit(0);
}

console.log(
    `[dev] Native player artifacts missing (${missingArtifacts.join(', ')}); building once...`
);

const result = spawnSync(
    'pnpm',
    ['exec', 'nx', 'run', 'electron-backend:build-native-players'],
    {
        cwd: workspaceRoot,
        stdio: 'inherit'
    }
);

if (result.error) {
    console.error(`[dev] Native player build could not start: ${result.error.message}`);
}

process.exit(result.status ?? 1);
