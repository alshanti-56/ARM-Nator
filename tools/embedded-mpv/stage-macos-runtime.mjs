import fs from 'fs';
import path from 'path';

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
const [arch, sourcePrefix] = args;
const validArchitectures = new Set(['arm64', 'x64']);
const workspaceRoot = process.cwd();

if (!validArchitectures.has(arch) || !sourcePrefix) {
    console.error(
        [
            'Usage: node tools/embedded-mpv/stage-macos-runtime.mjs <arm64|x64> <lgpl-runtime-prefix>',
            '',
            'The prefix must contain:',
            '- include/mpv/client.h',
            '- lib/libmpv.2.dylib or lib/libmpv.dylib',
            '- all non-system dylib dependencies required by libmpv',
        ].join('\n')
    );
    process.exit(1);
}

const normalizedPrefix = path.resolve(sourcePrefix);
const destinationRoot = path.join(
    workspaceRoot,
    'vendor',
    'embedded-mpv',
    `darwin-${arch}`
);
const destinationIncludeDir = path.join(destinationRoot, 'include');
const destinationLibDir = path.join(destinationRoot, 'lib');
const sourceIncludeDir = path.join(normalizedPrefix, 'include');
const sourceLibDir = path.join(normalizedPrefix, 'lib');

function assertExists(filePath, message) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`${message}: ${filePath}`);
    }
}

function isFileLike(sourcePath, entry) {
    if (entry.isFile()) {
        return true;
    }

    if (!entry.isSymbolicLink()) {
        return false;
    }

    try {
        return fs.statSync(sourcePath).isFile();
    } catch {
        return false;
    }
}

function copyDirectory(sourceDir, destinationDir, filter) {
    fs.mkdirSync(destinationDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const destinationPath = path.join(destinationDir, entry.name);

        if (filter && !filter(sourcePath, entry)) {
            continue;
        }

        if (entry.isDirectory()) {
            copyDirectory(sourcePath, destinationPath, filter);
            continue;
        }

        if (isFileLike(sourcePath, entry)) {
            fs.copyFileSync(sourcePath, destinationPath);
            fs.chmodSync(destinationPath, 0o755);
        }
    }
}

function findLibMpv(libDir) {
    for (const candidate of ['libmpv.2.dylib', 'libmpv.dylib']) {
        const candidatePath = path.join(libDir, candidate);
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return null;
}

function listDylibs(libDir) {
    return fs
        .readdirSync(libDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.dylib'))
        .map((entry) => entry.name)
        .sort();
}

function readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) {
        return null;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

try {
    assertExists(
        path.join(sourceIncludeDir, 'mpv', 'client.h'),
        'Missing libmpv header'
    );
    if (!findLibMpv(sourceLibDir)) {
        throw new Error(`Missing libmpv dylib in ${sourceLibDir}`);
    }

    fs.rmSync(destinationIncludeDir, { recursive: true, force: true });
    fs.rmSync(destinationLibDir, { recursive: true, force: true });
    fs.mkdirSync(destinationRoot, { recursive: true });

    copyDirectory(
        path.join(sourceIncludeDir, 'mpv'),
        path.join(destinationIncludeDir, 'mpv')
    );
    copyDirectory(sourceLibDir, destinationLibDir, (_sourcePath, entry) => {
        return entry.isDirectory() || entry.name.endsWith('.dylib');
    });

    const externalManifest =
        readJsonIfExists(path.join(normalizedPrefix, 'runtime-manifest.json')) ??
        {};
    const manifest = {
        ...externalManifest,
        origin: 'vendored-lgpl',
        arch,
        stagedAt: new Date().toISOString(),
        ffmpeg: {
            licensePolicy: 'LGPL, built without --enable-gpl and --enable-nonfree',
            ...externalManifest.ffmpeg,
            configureFlags:
                externalManifest.ffmpeg?.configureFlags ??
                'Record the exact FFmpeg configure flags used to build this runtime.',
        },
        mpv: {
            licensePolicy: 'LGPL-compatible libmpv, built with -Dlibmpv=true -Dgpl=false',
            ...externalManifest.mpv,
            mesonFlags:
                externalManifest.mpv?.mesonFlags ??
                'Record the exact mpv Meson flags used to build this runtime.',
        },
        dylibs: listDylibs(destinationLibDir),
        sourceDistribution:
            externalManifest.sourceDistribution ??
            'Publish exact source archives and local patches with the macOS binary release.',
    };

    fs.writeFileSync(
        path.join(destinationRoot, 'runtime-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`
    );

    console.log(
        `Staged embedded MPV runtime for darwin-${arch} at ${path.relative(
            workspaceRoot,
            destinationRoot
        )}`
    );
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
