'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed: ${result.stderr.trim()}`
        );
    }
    return result.stdout;
}

function commandExists(command) {
    return (
        spawnSync('/usr/bin/which', [command], {
            stdio: 'ignore'
        }).status === 0
    );
}

function listDylibs(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }
    return fs
        .readdirSync(directoryPath, { withFileTypes: true })
        .filter(
            (entry) =>
                (entry.isFile() || entry.isSymbolicLink()) &&
                entry.name.endsWith('.dylib')
        )
        .map((entry) => path.join(directoryPath, entry.name))
        .sort();
}

function listRuntimeFiles(directoryPath) {
    return listDylibs(directoryPath);
}

function parseOtoolDependencies(binaryPath) {
    return run('/usr/bin/otool', ['-L', binaryPath])
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(' ')[0])
        .filter(Boolean);
}

function parseOtoolRpaths(binaryPath) {
    const lines = run('/usr/bin/otool', ['-l', binaryPath]).split('\n');
    const rpaths = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() !== 'cmd LC_RPATH') {
            continue;
        }
        for (
            let cursor = index + 1;
            cursor < Math.min(index + 8, lines.length);
            cursor += 1
        ) {
            const match = lines[cursor].trim().match(/^path (.+) \(offset/);
            if (match) {
                rpaths.push(match[1]);
                break;
            }
        }
    }
    return rpaths;
}

function findLibMpv(runtimeLibDir) {
    for (const name of ['libmpv.2.dylib', 'libmpv.dylib']) {
        const candidate = path.join(runtimeLibDir, name);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function isSystemDependency(dependencyPath) {
    return (
        dependencyPath.startsWith('/System/Library/') ||
        dependencyPath.startsWith('/usr/lib/')
    );
}

function isForbiddenDependency(dependencyPath) {
    return (
        dependencyPath.startsWith('/opt/homebrew/') ||
        dependencyPath.startsWith('/usr/local/') ||
        dependencyPath.includes('/vendor/embedded-mpv/')
    );
}

function resolveDependencyPath(dependencyPath, binaryPath) {
    if (dependencyPath.startsWith('@loader_path/')) {
        return path.resolve(
            path.dirname(binaryPath),
            dependencyPath.slice('@loader_path/'.length)
        );
    }
    if (path.isAbsolute(dependencyPath)) {
        return dependencyPath;
    }
    return null;
}

function collectExternalDylibs(entryPaths) {
    const discovered = new Map();
    const queue = [...entryPaths];
    while (queue.length > 0) {
        const binaryPath = queue.shift();
        for (const dependencyPath of parseOtoolDependencies(binaryPath)) {
            if (
                isSystemDependency(dependencyPath) ||
                dependencyPath.startsWith('@rpath/')
            ) {
                continue;
            }
            const resolvedPath = resolveDependencyPath(
                dependencyPath,
                binaryPath
            );
            if (
                resolvedPath &&
                fs.existsSync(resolvedPath) &&
                !discovered.has(path.basename(resolvedPath))
            ) {
                discovered.set(path.basename(resolvedPath), resolvedPath);
                queue.push(resolvedPath);
            }
        }
    }
    return [...discovered.values()].sort();
}

function copyFile(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, 0o755);
}

function patchDylibIds(libDir) {
    for (const dylibPath of listDylibs(libDir)) {
        run('/usr/bin/install_name_tool', [
            '-id',
            `@loader_path/${path.basename(dylibPath)}`,
            dylibPath
        ]);
    }
}

function patchBinaryDependencies(binaryPath, outputLibDir, loaderPrefix) {
    for (const dependencyPath of parseOtoolDependencies(binaryPath)) {
        if (isSystemDependency(dependencyPath)) {
            continue;
        }
        const dependencyName = path.basename(dependencyPath);
        if (fs.existsSync(path.join(outputLibDir, dependencyName))) {
            run('/usr/bin/install_name_tool', [
                '-change',
                dependencyPath,
                `${loaderPrefix}/${dependencyName}`,
                binaryPath
            ]);
        }
    }
}

function adHocSignBinary(binaryPath) {
    run('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        '--timestamp=none',
        binaryPath
    ]);
}

function copyRuntimeToNativeBuild({
    runtimeLibDir,
    outputLibDir,
    runtimeOrigin,
    runtimeManifest
}) {
    const libMpvPath = findLibMpv(runtimeLibDir);
    if (!libMpvPath) {
        throw new Error(`Unable to find libmpv in ${runtimeLibDir}.`);
    }

    fs.rmSync(outputLibDir, { recursive: true, force: true });
    fs.mkdirSync(outputLibDir, { recursive: true });
    const runtimeFiles = new Map([[path.basename(libMpvPath), libMpvPath]]);
    for (const dylibPath of collectExternalDylibs([libMpvPath])) {
        runtimeFiles.set(path.basename(dylibPath), dylibPath);
    }
    if (runtimeOrigin === 'vendored-lgpl') {
        for (const dylibPath of listDylibs(runtimeLibDir)) {
            runtimeFiles.set(path.basename(dylibPath), dylibPath);
        }
    }
    for (const [name, sourcePath] of runtimeFiles) {
        copyFile(sourcePath, path.join(outputLibDir, name));
    }
    if (!fs.existsSync(path.join(outputLibDir, 'libmpv.2.dylib'))) {
        copyFile(libMpvPath, path.join(outputLibDir, 'libmpv.2.dylib'));
    }

    patchDylibIds(outputLibDir);
    for (const dylibPath of listDylibs(outputLibDir)) {
        patchBinaryDependencies(dylibPath, outputLibDir, '@loader_path');
        adHocSignBinary(dylibPath);
    }

    const manifest = {
        origin: runtimeOrigin,
        platform: 'darwin',
        targetArch: 'arm64',
        generatedAt: new Date().toISOString(),
        libDir: 'lib',
        runtimeFiles: listDylibs(outputLibDir).map((filePath) =>
            path.basename(filePath)
        ),
        dylibs: listDylibs(outputLibDir).map((filePath) =>
            path.basename(filePath)
        ),
        ...runtimeManifest
    };
    fs.writeFileSync(
        path.join(path.dirname(outputLibDir), 'embedded-mpv-runtime.json'),
        `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
}

function patchBinaryForBundledRuntime(binaryPath, outputLibDir) {
    if (!fs.existsSync(binaryPath)) {
        throw new Error(`Missing native binary: ${binaryPath}`);
    }
    patchBinaryDependencies(binaryPath, outputLibDir, '@loader_path/lib');
    adHocSignBinary(binaryPath);
}

function validateNoForbiddenRuntimeLinks(binaryPaths) {
    const errors = [];
    for (const binaryPath of binaryPaths) {
        if (!fs.existsSync(binaryPath)) {
            errors.push(`Missing binary: ${binaryPath}`);
            continue;
        }
        for (const dependencyPath of parseOtoolDependencies(binaryPath)) {
            if (isForbiddenDependency(dependencyPath)) {
                errors.push(
                    `${binaryPath} links to forbidden runtime path: ${dependencyPath}`
                );
            }
            if (dependencyPath.startsWith('@loader_path/')) {
                const resolvedPath = resolveDependencyPath(
                    dependencyPath,
                    binaryPath
                );
                if (!resolvedPath || !fs.existsSync(resolvedPath)) {
                    errors.push(
                        `${binaryPath} links to missing bundled dependency: ${dependencyPath}`
                    );
                }
            } else if (!isSystemDependency(dependencyPath)) {
                errors.push(
                    `${binaryPath} links to non-bundled runtime path: ${dependencyPath}`
                );
            }
        }
    }
    return errors;
}

function validatePackagedEmbeddedMpv(resourceDir, options = {}) {
    const nativeDir = path.join(
        resourceDir,
        'app.asar.unpacked',
        'electron-backend',
        'native'
    );
    const addonPath = path.join(nativeDir, 'embedded_mpv.node');
    const helperPath = path.join(nativeDir, 'arm-nator_mpv_helper');
    const readerPath = path.join(nativeDir, 'embedded_mpv_frame_reader.node');
    const manifestPath = path.join(nativeDir, 'embedded-mpv-runtime.json');
    const libDir = path.join(nativeDir, 'lib');
    const errors = [];

    if (options.platform && options.platform !== 'darwin') {
        errors.push('Embedded MPV packaging supports darwin only.');
    }
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
        errors.push(
            'macOS arm64 package validation requires an Apple Silicon Mac.'
        );
    }
    for (const artifact of [addonPath, helperPath, readerPath, manifestPath]) {
        if (!fs.existsSync(artifact)) {
            errors.push(`Missing embedded MPV artifact: ${artifact}`);
        }
    }
    if (!findLibMpv(libDir)) {
        errors.push(`Missing bundled libmpv runtime in ${libDir}.`);
    }
    if (fs.existsSync(manifestPath)) {
        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const allowedOrigins = ['vendored-lgpl'];
            if (!allowedOrigins.includes(manifest.origin)) {
                errors.push(
                    `Embedded MPV runtime origin must be ${allowedOrigins.join(
                        ' or '
                    )}; received ${manifest.origin}.`
                );
            }
            if (
                manifest.platform !== 'darwin' ||
                manifest.targetArch !== 'arm64'
            ) {
                errors.push(
                    'Embedded MPV runtime manifest must target darwin-arm64.'
                );
            }
        } catch (error) {
            errors.push(
                `Invalid embedded MPV runtime manifest: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
    errors.push(
        ...validateNoForbiddenRuntimeLinks([
            addonPath,
            helperPath,
            ...listDylibs(libDir)
        ])
    );
    return errors;
}

module.exports = {
    collectExternalDylibs,
    commandExists,
    copyRuntimeToNativeBuild,
    findLibMpv,
    listDylibs,
    listRuntimeFiles,
    parseOtoolDependencies,
    parseOtoolRpaths,
    patchAddonForBundledRuntime: patchBinaryForBundledRuntime,
    patchBinaryForBundledRuntime,
    validateNoForbiddenRuntimeLinks,
    validatePackagedEmbeddedMpv
};
