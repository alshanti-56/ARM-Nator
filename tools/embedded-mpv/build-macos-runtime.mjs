#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
    applyLibassPatches,
    applyMpvPatches,
    getRequiredLibassPatches,
    getRequiredMpvPatches
} from './runtime-patches.mjs';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const [rawPrefix] = args;
const arch = 'arm64';
const macosDeploymentTarget = (process.env.MACOSX_DEPLOYMENT_TARGET ??= '26.0');
const workspaceRoot = process.cwd();

const sourcePackages = [
    {
        id: 'freetype',
        version: '2.13.3',
        url: 'https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz',
        downloadUrls: [
            'https://download.savannah.gnu.org/releases/freetype/freetype-2.13.3.tar.xz',
            'https://downloads.sourceforge.net/project/freetype/freetype2/2.13.3/freetype-2.13.3.tar.xz'
        ],
        license: 'FreeType License or GPL-2.0-or-later'
    },
    {
        id: 'fribidi',
        version: '1.0.16',
        url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.16/fribidi-1.0.16.tar.xz',
        license: 'LGPL-2.1-or-later'
    },
    {
        id: 'harfbuzz',
        version: '8.5.0',
        url: 'https://github.com/harfbuzz/harfbuzz/releases/download/8.5.0/harfbuzz-8.5.0.tar.xz',
        license: 'MIT'
    },
    {
        id: 'libass',
        version: '0.17.3',
        url: 'https://github.com/libass/libass/releases/download/0.17.3/libass-0.17.3.tar.xz',
        license: 'ISC'
    },
    {
        id: 'ffmpeg',
        version: '8.1',
        url: 'https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz',
        license: 'LGPL-compatible configuration'
    },
    {
        id: 'libplacebo',
        version: '7.360.1',
        tag: 'v7.360.1',
        gitUrl: 'https://github.com/haasn/libplacebo.git',
        license: 'LGPL-2.1-or-later'
    },
    {
        id: 'mpv',
        version: '0.41.0',
        url: 'https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz',
        license: 'LGPL-compatible configuration with -Dgpl=false'
    }
];

if (process.platform !== 'darwin') {
    console.error('Embedded MPV runtime builds are supported on macOS only.');
    process.exit(1);
}

if (process.arch !== 'arm64') {
    console.error('Embedded MPV runtime builds require Apple Silicon.');
    process.exit(1);
}

if (!rawPrefix) {
    console.error(
        [
            'Usage: node tools/embedded-mpv/build-macos-runtime.mjs <output-prefix>',
            '',
            'Builds a pinned LGPL-compatible macOS arm64 libmpv runtime from source.'
        ].join('\n')
    );
    process.exit(1);
}

const prefix = path.resolve(rawPrefix);
const buildRoot = path.resolve(
    process.env.ARM_NATOR_EMBEDDED_MPV_BUILD_ROOT ??
        path.join(os.tmpdir(), 'arm-nator-embedded-mpv-runtime', arch)
);
const archiveRoot = path.join(buildRoot, 'archives');
const sourceRoot = path.join(buildRoot, 'sources');
const packageById = new Map(
    sourcePackages.map((source) => [source.id, source])
);
const parallelism =
    process.env.MAKEFLAGS?.match(/-j\s*(\d+)/)?.[1] ?? String(os.cpus().length);

const ffmpegConfigureFlags = [
    `--prefix=${prefix}`,
    '--enable-shared',
    '--disable-static',
    '--disable-doc',
    '--disable-debug',
    '--disable-programs',
    '--enable-ffmpeg',
    '--disable-ffplay',
    '--disable-ffprobe',
    '--disable-autodetect',
    '--disable-gpl',
    '--disable-nonfree',
    '--enable-pic',
    '--enable-securetransport',
    '--enable-audiotoolbox',
    '--enable-videotoolbox'
];

const mpvMesonFlags = [
    '-Dgpl=false',
    '-Dlibmpv=true',
    '-Dcplayer=false',
    '-Dbuild-date=false',
    '-Dtests=false',
    '-Dlua=disabled',
    '-Djavascript=disabled',
    '-Dcplugins=disabled',
    '-Dmanpage-build=disabled',
    '-Dhtml-build=disabled',
    '-Dpdf-build=disabled',
    '-Dlibarchive=disabled',
    '-Dlibbluray=disabled',
    '-Ddvdnav=disabled',
    '-Dcdda=disabled',
    '-Ddvbin=disabled',
    '-Djpeg=disabled',
    '-Dlcms2=disabled',
    '-Drubberband=disabled',
    '-Duchardet=disabled',
    '-Dzimg=disabled',
    '-Dvulkan=disabled',
    '-Dshaderc=disabled',
    '-Dspirv-cross=disabled',
    // VideoToolbox's OpenGL interop is the stable in-process path used by
    // embedded libmpv; it does not require MPV's Vulkan/Metal renderer.
    '-Dcocoa=enabled',
    '-Dgl-cocoa=enabled',
    '-Dmacos-cocoa-cb=disabled',
    // MPV's Cocoa/OpenGL support uses its generated Swift bridge even when
    // the cplayer and macOS cocoa-cb window backend are disabled. Keep the
    // bridge enabled so VideoToolbox can interoperate with ARM-Nator's own
    // libmpv OpenGL surface without compiling an MPV-owned window.
    '-Dswift-build=enabled',
    '-Dvideotoolbox-gl=enabled',
    '-Dvideotoolbox-pl=disabled',
    '-Dplain-gl=enabled'
];

function log(message) {
    process.stdout.write(`[embedded-mpv-runtime] ${message}\n`);
}

function run(command, commandArgs, options = {}) {
    log(`${command} ${commandArgs.join(' ')}`);
    const result = spawnSync(command, commandArgs, {
        cwd: options.cwd ?? workspaceRoot,
        env: options.env ?? buildEnv(),
        stdio: 'inherit',
        ...options
    });

    if (result.status !== 0) {
        throw new Error(
            `${command} ${commandArgs.join(' ')} failed with status ${
                result.status ?? 1
            }.`
        );
    }
}

function commandExists(command) {
    const result = spawnSync('sh', ['-lc', `command -v ${command}`], {
        stdio: 'ignore'
    });
    return result.status === 0;
}

function buildEnv() {
    const pkgConfigDirs = [
        path.join(prefix, 'lib', 'pkgconfig'),
        path.join(prefix, 'share', 'pkgconfig')
    ].join(path.delimiter);

    return {
        ...process.env,
        PATH: [path.join(prefix, 'bin'), process.env.PATH]
            .filter(Boolean)
            .join(path.delimiter),
        PKG_CONFIG_PATH: pkgConfigDirs,
        PKG_CONFIG_LIBDIR: pkgConfigDirs,
        CMAKE_PREFIX_PATH: prefix,
        DYLD_LIBRARY_PATH: path.join(prefix, 'lib'),
        MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget,
        CFLAGS: [`-I${path.join(prefix, 'include')}`, process.env.CFLAGS]
            .filter(Boolean)
            .join(' '),
        LDFLAGS: [`-L${path.join(prefix, 'lib')}`, process.env.LDFLAGS]
            .filter(Boolean)
            .join(' ')
    };
}

function ensureTools() {
    const requiredCommands = [
        'curl',
        'tar',
        'make',
        'meson',
        'ninja',
        'pkg-config',
        'git'
    ];
    const missing = requiredCommands.filter(
        (command) => !commandExists(command)
    );

    if (missing.length > 0) {
        throw new Error(`Missing required build tools: ${missing.join(', ')}`);
    }
}

function archivePathFor(sourcePackage) {
    const extension = sourcePackage.url.endsWith('.tar.xz')
        ? '.tar.xz'
        : '.tar.gz';
    return path.join(
        archiveRoot,
        `${sourcePackage.id}-${sourcePackage.version}${extension}`
    );
}

function sourcePathFor(packageId) {
    return path.join(sourceRoot, packageId);
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function archiveIsValid(archivePath) {
    if (!fs.existsSync(archivePath)) {
        return false;
    }

    return (
        spawnSync('tar', ['-tf', archivePath], {
            stdio: 'ignore'
        }).status === 0
    );
}

function runCapture(command, commandArgs, options = {}) {
    const result = spawnSync(command, commandArgs, {
        cwd: options.cwd ?? workspaceRoot,
        env: options.env ?? buildEnv(),
        encoding: 'utf8',
        stdio: 'pipe',
        ...options
    });

    if (result.status !== 0) {
        const stderr = result.stderr ? `\n${result.stderr}` : '';
        throw new Error(
            `${command} ${commandArgs.join(' ')} failed with status ${
                result.status ?? 1
            }.${stderr}`
        );
    }

    return result.stdout.trim();
}

function cloneGitSource(sourcePackage) {
    const packageSourcePath = sourcePathFor(sourcePackage.id);
    fs.rmSync(packageSourcePath, { recursive: true, force: true });

    run('git', [
        'clone',
        '--depth',
        '1',
        '--branch',
        sourcePackage.tag,
        sourcePackage.gitUrl,
        packageSourcePath
    ]);
    run(
        'git',
        [
            'submodule',
            'update',
            '--init',
            '--depth',
            '1',
            '3rdparty/glad',
            '3rdparty/jinja',
            '3rdparty/markupsafe',
            '3rdparty/fast_float',
            '3rdparty/Vulkan-Headers'
        ],
        { cwd: packageSourcePath }
    );

    sourcePackage.gitCommit = runCapture('git', ['rev-parse', 'HEAD'], {
        cwd: packageSourcePath
    });
    sourcePackage.submodules = runCapture(
        'git',
        [
            'submodule',
            'status',
            '3rdparty/glad',
            '3rdparty/jinja',
            '3rdparty/markupsafe',
            '3rdparty/fast_float',
            '3rdparty/Vulkan-Headers'
        ],
        { cwd: packageSourcePath }
    )
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function downloadSources() {
    fs.mkdirSync(archiveRoot, { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });

    for (const sourcePackage of sourcePackages) {
        if (sourcePackage.gitUrl) {
            cloneGitSource(sourcePackage);
            continue;
        }

        const archivePath = archivePathFor(sourcePackage);
        if (!archiveIsValid(archivePath)) {
            fs.rmSync(archivePath, { force: true });
            const downloadUrls = sourcePackage.downloadUrls ?? [
                sourcePackage.url
            ];
            let lastError;

            for (const downloadUrl of downloadUrls) {
                fs.rmSync(archivePath, { force: true });
                try {
                    run('curl', [
                        '-fL',
                        '--retry',
                        '5',
                        '--retry-all-errors',
                        '--retry-delay',
                        '5',
                        '-o',
                        archivePath,
                        downloadUrl
                    ]);
                    lastError = undefined;
                    break;
                } catch (error) {
                    lastError = error;
                    log(
                        `Download failed for ${downloadUrl}; trying the next mirror.`
                    );
                }
            }

            if (lastError) {
                throw lastError;
            }
        }

        const packageSourcePath = sourcePathFor(sourcePackage.id);
        fs.rmSync(packageSourcePath, { recursive: true, force: true });
        fs.mkdirSync(packageSourcePath, { recursive: true });
        run('tar', [
            '-xf',
            archivePath,
            '-C',
            packageSourcePath,
            '--strip-components',
            '1'
        ]);
        sourcePackage.sha256 = sha256File(archivePath);
    }
}

function configureMakeInstall(packageId, configureArgs) {
    const packageSourcePath = sourcePathFor(packageId);
    run('./configure', [`--prefix=${prefix}`, ...configureArgs], {
        cwd: packageSourcePath
    });
    run('make', [`-j${parallelism}`], { cwd: packageSourcePath });
    run('make', ['install'], { cwd: packageSourcePath });
}

function mesonInstall(packageId, mesonArgs) {
    const packageSourcePath = sourcePathFor(packageId);
    const buildDir = path.join(packageSourcePath, 'build-arm-nator');
    fs.rmSync(buildDir, { recursive: true, force: true });
    run(
        'meson',
        [
            'setup',
            buildDir,
            `--prefix=${prefix}`,
            '--libdir=lib',
            '--buildtype=release',
            '--default-library=shared',
            ...mesonArgs
        ],
        { cwd: packageSourcePath }
    );
    run('meson', ['compile', '-C', buildDir], { cwd: packageSourcePath });
    run('meson', ['install', '-C', buildDir], { cwd: packageSourcePath });
}

function buildRuntime() {
    fs.rmSync(prefix, { recursive: true, force: true });
    fs.mkdirSync(prefix, { recursive: true });

    configureMakeInstall('freetype', ['--enable-shared', '--disable-static']);
    configureMakeInstall('fribidi', ['--enable-shared', '--disable-static']);
    mesonInstall('harfbuzz', [
        '-Dglib=disabled',
        '-Dgobject=disabled',
        '-Dcairo=disabled',
        '-Dchafa=disabled',
        '-Dicu=disabled',
        '-Dfreetype=enabled',
        '-Dtests=disabled',
        '-Dintrospection=disabled',
        '-Ddocs=disabled',
        '-Dutilities=disabled',
        '-Dbenchmark=disabled'
    ]);
    applyLibassPatches(sourcePathFor('libass'));
    configureMakeInstall('libass', [
        '--enable-shared',
        '--disable-static',
        '--disable-fontconfig',
        '--enable-coretext',
        '--disable-libunibreak'
    ]);
    run(process.execPath, [
        path.join(workspaceRoot, 'tools/testing/verify-subtitle-position.mjs'),
        path.join(prefix, 'include'),
        path.join(prefix, 'lib')
    ]);

    const ffmpegSourcePath = sourcePathFor('ffmpeg');
    run('./configure', ffmpegConfigureFlags, { cwd: ffmpegSourcePath });
    run('make', [`-j${parallelism}`], { cwd: ffmpegSourcePath });
    run('make', ['install'], { cwd: ffmpegSourcePath });

    mesonInstall('libplacebo', [
        '-Dopengl=enabled',
        '-Dvulkan=disabled',
        '-Dvk-proc-addr=disabled',
        '-Dglslang=disabled',
        '-Dshaderc=disabled',
        '-Dlcms=disabled',
        '-Ddovi=disabled',
        '-Dlibdovi=disabled',
        '-Ddemos=false',
        '-Dtests=false',
        '-Dbench=false',
        '-Dfuzz=false',
        '-Dunwind=disabled',
        '-Dxxhash=disabled'
    ]);
    applyMpvPatches(sourcePathFor('mpv'));
    run(process.execPath, [
        path.join(workspaceRoot, 'tools/testing/verify-coreaudio-cleanup.mjs'),
        sourcePathFor('mpv')
    ]);
    mesonInstall('mpv', mpvMesonFlags);
}

function listDylibs(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }

    return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.dylib'))
        .map((entry) => path.join(directoryPath, entry.name))
        .sort();
}

function validateRuntimeLinks() {
    if (!commandExists('otool')) {
        log('Skipping otool validation because otool is unavailable.');
        return;
    }

    const libDir = path.join(prefix, 'lib');
    const errors = [];
    const allowedSystemPrefixes = ['/System/Library/', '/usr/lib/'];
    const forbiddenPrefixes = ['/opt/homebrew/', '/usr/local/'];

    for (const dylibPath of listDylibs(libDir)) {
        const result = spawnSync('otool', ['-L', dylibPath], {
            encoding: 'utf8',
            stdio: 'pipe'
        });
        if (result.status !== 0) {
            errors.push(`Unable to inspect ${dylibPath}: ${result.stderr}`);
            continue;
        }

        for (const dependencyPath of result.stdout
            .split(/\r?\n/)
            .slice(1)
            .map((line) => line.trim().split(/\s+\(/)[0])
            .filter(Boolean)) {
            if (
                allowedSystemPrefixes.some((prefixValue) =>
                    dependencyPath.startsWith(prefixValue)
                ) ||
                dependencyPath.startsWith('@loader_path/') ||
                dependencyPath.startsWith('@rpath/') ||
                dependencyPath.startsWith(prefix)
            ) {
                continue;
            }

            if (
                forbiddenPrefixes.some((prefixValue) =>
                    dependencyPath.startsWith(prefixValue)
                )
            ) {
                errors.push(
                    `${dylibPath} links to forbidden ${dependencyPath}`
                );
                continue;
            }

            if (path.isAbsolute(dependencyPath)) {
                errors.push(`${dylibPath} links to external ${dependencyPath}`);
            }
        }
    }

    if (errors.length > 0) {
        throw new Error(
            ['Embedded MPV runtime link validation failed.', ...errors].join(
                '\n'
            )
        );
    }
}

function sourceMetadata(packageId) {
    const sourcePackage = packageById.get(packageId);
    return {
        version: sourcePackage.version,
        sourceUrl: sourcePackage.url ?? sourcePackage.gitUrl,
        ...(sourcePackage.tag ? { sourceTag: sourcePackage.tag } : {}),
        ...(sourcePackage.sha256 ? { sourceSha256: sourcePackage.sha256 } : {}),
        ...(sourcePackage.gitCommit
            ? { sourceGitCommit: sourcePackage.gitCommit }
            : {}),
        ...(sourcePackage.submodules
            ? { sourceSubmodules: sourcePackage.submodules }
            : {}),
        license: sourcePackage.license
    };
}

function writeManifest() {
    const manifest = {
        origin: 'vendored-lgpl-source-build',
        arch,
        generatedAt: new Date().toISOString(),
        macosDeploymentTarget,
        buildHost: {
            platform: process.platform,
            arch: process.arch
        },
        packages: Object.fromEntries(
            sourcePackages.map((sourcePackage) => [
                sourcePackage.id,
                {
                    version: sourcePackage.version,
                    sourceUrl: sourcePackage.url ?? sourcePackage.gitUrl,
                    ...(sourcePackage.tag
                        ? { sourceTag: sourcePackage.tag }
                        : {}),
                    ...(sourcePackage.sha256
                        ? { sourceSha256: sourcePackage.sha256 }
                        : {}),
                    ...(sourcePackage.gitCommit
                        ? { sourceGitCommit: sourcePackage.gitCommit }
                        : {}),
                    ...(sourcePackage.submodules
                        ? { sourceSubmodules: sourcePackage.submodules }
                        : {}),
                    license: sourcePackage.license,
                    ...(sourcePackage.id === 'libass'
                        ? { patches: getRequiredLibassPatches() }
                        : {})
                }
            ])
        ),
        ffmpeg: {
            ...sourceMetadata('ffmpeg'),
            licensePolicy:
                'LGPL, built without --enable-gpl and --enable-nonfree',
            configureFlags: ffmpegConfigureFlags
        },
        mpv: {
            ...sourceMetadata('mpv'),
            patches: getRequiredMpvPatches(),
            licensePolicy:
                'LGPL-compatible libmpv, built with -Dlibmpv=true -Dgpl=false',
            mesonFlags: mpvMesonFlags
        },
        sourceDistribution:
            'Attach the downloaded source archives, the libplacebo git checkout metadata, this manifest, and any local patches with the macOS binary release.'
    };

    fs.writeFileSync(
        path.join(prefix, 'runtime-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`
    );
}

try {
    ensureTools();
    fs.mkdirSync(buildRoot, { recursive: true });
    downloadSources();
    buildRuntime();
    validateRuntimeLinks();
    writeManifest();
    log(`Built LGPL-compatible runtime prefix at ${prefix}`);
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
