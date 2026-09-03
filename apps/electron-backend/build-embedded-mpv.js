/* eslint-disable @nx/enforce-module-boundaries */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    copyRuntimeToNativeBuild,
    findLibMpv,
    patchBinaryForBundledRuntime,
    validateNoForbiddenRuntimeLinks
} = require('../../tools/packaging/embedded-mpv-packaging.cjs');

const workspaceRoot = process.cwd();
const nativeRoot = path.join(
    workspaceRoot,
    'apps',
    'electron-backend',
    'native'
);
const outputDir = path.join(nativeRoot, 'build', 'Release');
const outputLibDir = path.join(outputDir, 'lib');
const outputFile = path.join(outputDir, 'embedded_mpv.node');
const outputFfmpegFile = path.join(outputDir, 'ffmpeg');
const manifestFile = path.join(outputDir, 'embedded-mpv-runtime.json');
const unavailableMarkerFile = path.join(
    outputDir,
    'embedded-mpv-unavailable.txt'
);
const distNativeDir = path.join(
    workspaceRoot,
    'dist',
    'apps',
    'electron-backend',
    'native'
);
const vendoredRuntimeRoot = path.join(
    workspaceRoot,
    'vendor',
    'embedded-mpv',
    'darwin-arm64'
);
function log(message) {
    process.stdout.write(`[embedded-mpv] ${message}\n`);
}

function cleanOutput() {
    for (const artifact of [outputFile, outputFfmpegFile, manifestFile]) {
        fs.rmSync(artifact, { force: true });
    }
    fs.rmSync(outputLibDir, { recursive: true, force: true });
    // Older runtime builds staged a Vulkan ICD next to the addon. Remove the
    // whole generated metadata directory so a renderer change cannot leak
    // obsolete files into webpack or the packaged app.
    fs.rmSync(path.join(outputDir, 'etc'), { recursive: true, force: true });
    fs.rmSync(path.join(outputDir, '.deps'), { recursive: true, force: true });
    fs.rmSync(path.join(outputDir, 'obj.target'), {
        recursive: true,
        force: true
    });
    fs.writeFileSync(
        unavailableMarkerFile,
        'Embedded MPV native runtime is not available for this build.\n'
    );
}

function cleanNativeBuildIntermediates() {
    fs.rmSync(outputFile, { force: true });
    fs.rmSync(path.join(outputDir, '.deps'), { recursive: true, force: true });
    fs.rmSync(path.join(outputDir, 'obj.target'), {
        recursive: true,
        force: true
    });
}

function readRuntimeManifest(runtimeRoot) {
    const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
    return fs.existsSync(manifestPath)
        ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        : {};
}

function resolveRuntime() {
    const vendoredIncludeDir = path.join(vendoredRuntimeRoot, 'include');
    const vendoredLibDir = path.join(vendoredRuntimeRoot, 'lib');
    const vendoredFfmpegPath = path.join(vendoredRuntimeRoot, 'bin', 'ffmpeg');
    if (
        fs.existsSync(path.join(vendoredIncludeDir, 'mpv', 'client.h')) &&
        findLibMpv(vendoredLibDir) &&
        fs.existsSync(vendoredFfmpegPath)
    ) {
        return {
            origin: 'vendored-lgpl',
            includeDir: vendoredIncludeDir,
            libDir: vendoredLibDir,
            ffmpegPath: vendoredFfmpegPath,
            manifest: readRuntimeManifest(vendoredRuntimeRoot)
        };
    }

    return null;
}

function resolveNodeGypBin() {
    try {
        return require.resolve('node-gyp/bin/node-gyp.js');
    } catch (error) {
        throw new Error(
            `Unable to resolve node-gyp. Is it installed? (${error.message})`
        );
    }
}

function runNodeGyp(command, env) {
    const result = spawnSync(
        process.execPath,
        [resolveNodeGypBin(), command, '--directory', nativeRoot],
        {
            cwd: workspaceRoot,
            env,
            stdio: 'inherit'
        }
    );
    if (result.status !== 0) {
        throw new Error(
            `node-gyp ${command} failed with status ${result.status ?? 1}.`
        );
    }
}

function runNativeTarget(target, env) {
    const result = spawnSync(
        '/usr/bin/make',
        ['-C', path.join(nativeRoot, 'build'), 'BUILDTYPE=Release', target],
        {
            cwd: workspaceRoot,
            env,
            stdio: 'inherit'
        }
    );
    if (result.status !== 0) {
        throw new Error(
            `make ${target} failed with status ${result.status ?? 1}.`
        );
    }
}

function assertMacOSAppleSiliconHost() {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        throw new Error(
            `ARM-Nator requires macOS on Apple Silicon; received ${process.platform}-${process.arch}.`
        );
    }
}

function main() {
    assertMacOSAppleSiliconHost();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.rmSync(distNativeDir, { recursive: true, force: true });
    cleanOutput();

    const runtime = resolveRuntime();
    if (!runtime) {
        const message = [
            'No embedded MPV runtime was found for darwin-arm64.',
            `Expected a vendored runtime at ${vendoredRuntimeRoot}.`,
            'Run `pnpm embedded-mpv:runtime` to build the portable runtime.'
        ].join('\n');
        throw new Error(message);
    }

    try {
        const runtimeManifest = copyRuntimeToNativeBuild({
            runtimeLibDir: runtime.libDir,
            runtimeFfmpegPath: runtime.ffmpegPath,
            outputLibDir,
            runtimeOrigin: runtime.origin,
            runtimeManifest: {
                platform: 'darwin',
                targetArch: 'arm64',
                ...runtime.manifest
            }
        });
        const electronVersion = require(
            path.join(workspaceRoot, 'node_modules', 'electron', 'package.json')
        ).version;
        const env = {
            ...process.env,
            npm_config_runtime: 'electron',
            npm_config_target: electronVersion,
            npm_config_arch: 'arm64',
            npm_config_disturl: 'https://electronjs.org/headers',
            npm_config_build_from_source: 'true',
            npm_config_update_binary: 'false',
            MACOSX_DEPLOYMENT_TARGET: '26.0',
            LIBMPV_INCLUDE_DIR: runtime.includeDir,
            LIBMPV_LIBRARY_DIR: outputLibDir
        };

        log(
            `Building native addon against Electron ${electronVersion} using ${runtime.origin} runtime for darwin-arm64...`
        );
        cleanNativeBuildIntermediates();
        runNodeGyp('configure', env);
        // Build only the independently owned Embedded MPV target. The
        // node-gyp aggregate target would also rebuild KSPlayer.
        runNativeTarget('embedded_mpv', env);

        for (const artifact of [outputFile]) {
            if (!fs.existsSync(artifact)) {
                throw new Error(
                    `Native build finished without producing ${artifact}.`
                );
            }
        }

        patchBinaryForBundledRuntime(outputFile, outputLibDir);
        const linkErrors = validateNoForbiddenRuntimeLinks([
            outputFile,
            outputFfmpegFile,
            ...runtimeManifest.dylibs.map((name) =>
                path.join(outputLibDir, name)
            )
        ]);
        if (linkErrors.length > 0) {
            throw new Error(linkErrors.join('\n'));
        }
        fs.rmSync(unavailableMarkerFile, { force: true });
    } catch (error) {
        cleanOutput();
        throw error;
    }

    log(`Built ${path.relative(workspaceRoot, outputFile)}.`);
}

try {
    main();
} catch (error) {
    process.stderr.write(
        `[embedded-mpv] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
}
