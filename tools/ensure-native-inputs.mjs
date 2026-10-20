import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, lstatSync, readlinkSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const settings = {
    'embedded-mpv': {
        inputs: ['apps/electron-backend/native/src/embedded_mpv.mm', 'apps/electron-backend/native/src/native_presentation.h', 'apps/electron-backend/native/binding.gyp', 'apps/electron-backend/build-embedded-mpv.js', 'tools/embedded-mpv', 'tools/packaging/embedded-mpv-packaging.cjs', 'vendor/embedded-mpv/darwin-arm64/runtime-manifest.json'],
        artifacts: ['embedded_mpv.node', 'embedded-mpv-runtime.json', 'lib/libmpv.2.dylib', 'ffmpeg'],
        commands: ['tools/embedded-mpv/ensure-macos-runtime.mjs', 'apps/electron-backend/build-embedded-mpv.js'],
    },
    'ksplayer-metal': {
        inputs: ['apps/electron-backend/native/src/ksplayer_metal.mm', 'apps/electron-backend/build-ksplayer-metal.js', 'apps/electron-backend/ksplayer-metal/Sources', 'apps/electron-backend/ksplayer-metal/include', 'apps/electron-backend/ksplayer-metal/patches', 'apps/electron-backend/ksplayer-metal/Package.swift', 'apps/electron-backend/ksplayer-metal/Package.resolved', 'apps/electron-backend/ksplayer-metal/.build/checkouts', 'tools/packaging/ksplayer-metal-packaging.cjs'],
        artifacts: ['ksplayer_metal.node', 'ksplayer-metal-runtime.json', 'ksplayer-metal/KSPlayerMetalRuntime.dylib', 'ksplayer-metal/KSPlayer_KSPlayer.bundle/Contents/Resources/default.metallib', 'ksplayer-metal/Frameworks'],
        commands: ['apps/electron-backend/build-ksplayer-metal.js'],
    },
};
const sourceExtensions = /\.(?:mjs|cjs|js|mm|m|c|cc|h|hpp|cpp|s|swift|metal|patch|gyp|json|resolved|modulemap)$/;
function files(root, entries) {
    const result = [];
    const visit = p => {
        if (!existsSync(p)) return;
        const info = statSync(p);
        if (info.isDirectory()) {
            for (const item of readdirSync(p, { withFileTypes: true })) {
                if (item.isSymbolicLink() || ['.git', 'node_modules', 'build', '.build'].includes(item.name)) continue;
                visit(join(p, item.name));
            }
        } else if (sourceExtensions.test(p)) result.push(p);
    };
    entries.forEach(p => visit(join(root, p)));
    return result.sort();
}
function hashFiles(root, paths, extra) {
    const hash = createHash('sha256').update(JSON.stringify(extra));
    for (const p of paths) hash.update(relative(root, p)).update(lstatSync(p).isSymbolicLink() ? readlinkSync(p) : readFileSync(p));
    return hash.digest('hex');
}
function artifacts(root, entries) {
    const result = [];
    const visit = path => {
        if (lstatSync(path).isDirectory()) {
            for (const entry of readdirSync(path)) visit(join(path, entry));
        } else result.push(path);
    };
    entries.forEach(path => visit(join(root, path)));
    return result.sort();
}
function buildEnvironment(root) {
    const env = { ...process.env };
    const config = join(root, 'tools/native-toolchain.env');
    if (existsSync(config)) {
        for (const line of readFileSync(config, 'utf8').split('\n')) {
            const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
            if (match && env[match[1]] === undefined) env[match[1]] = match[2];
        }
    }
    return env;
}
function detectToolchain(root, env) {
    const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-version'], { cwd: root, env, encoding: 'utf8' });
    const clang = spawnSync('xcrun', ['clang', '--version'], { cwd: root, env, encoding: 'utf8' });
    return [sdk.status, sdk.stdout, clang.status, clang.stdout];
}
export function ensureNativeBuild({ root = process.cwd(), kind, toolchain, build }) {
    const config = settings[kind];
    if (!config) throw new Error(`Unknown native target: ${kind}`);
    root = resolve(root);
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const output = join(root, 'apps/electron-backend/native/build/Release');
    const stamp = join(output, `.${kind}-inputs.json`);
    const environment = buildEnvironment(root);
    const fingerprint = () => hashFiles(root, files(root, [...config.inputs, 'tools/ensure-native-inputs.mjs', 'tools/native-toolchain.env']), {
        electron: pkg.devDependencies?.electron, napi: pkg.devDependencies?.['node-addon-api'], platform: process.platform, arch: process.arch,
        toolchain: toolchain ?? detectToolchain(root, environment),
        environment: Object.fromEntries(['DEVELOPER_DIR', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'].map(key => [key, environment[key]])),
    });
    const inputs = fingerprint();
    const artifactsExist = () => config.artifacts.every(p => existsSync(join(output, p)));
    const artifactHash = () => hashFiles(output, artifacts(output, config.artifacts), []);
    let previous;
    try { previous = JSON.parse(readFileSync(stamp, 'utf8')); } catch { /* First build or incomplete stamp. */ }
    if (previous?.inputs === inputs && artifactsExist() && previous.artifacts === artifactHash()) return { rebuilt: false };
    rmSync(stamp, { force: true });
    if (build) build();
    else {
        for (const command of config.commands) {
            const result = spawnSync(process.execPath, [command], { cwd: root, env: environment, stdio: 'inherit' });
            if (result.error || result.status !== 0) throw result.error ?? new Error(`Native build failed: ${command} (${result.status})`);
        }
    }
    if (!artifactsExist()) throw new Error(`Incomplete native build: ${kind}`);
    mkdirSync(output, { recursive: true });
    // Keep the inputs actually supplied to this build. Inputs changed during
    // compilation (including newly resolved sources) require a fresh build.
    writeFileSync(stamp, JSON.stringify({ inputs, artifacts: artifactHash() }));
    return { rebuilt: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const kind = process.argv[2];
        const result = ensureNativeBuild({ kind });
        console.log(`[native] ${kind}: ${result.rebuilt ? 'built changed inputs' : 'reusing verified artifacts'}`);
    } catch (error) { console.error(error); process.exitCode = 1; }
}
