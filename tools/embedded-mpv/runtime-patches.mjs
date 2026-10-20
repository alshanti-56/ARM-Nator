import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const patches = [
    {
        file: '0001-coreaudio-init-cleanup.patch',
        upstream: 'https://github.com/mpv-player/mpv/pull/18383'
    },
    {
        file: '0002-coreaudio-clear-disposed-unit.patch',
        reason: 'Clear the failed AudioUnit handle before outer cleanup.'
    }
];
const libassPatches = [
    {
        file: '0001-subtitle-position-usable-range.patch',
        reason:
            'Map subtitle position across the visible range after accounting for rendered text height.'
    }
];

function patchPath(file) {
    return fileURLToPath(new URL(`./patches/${file}`, import.meta.url));
}

export function getRequiredMpvPatches() {
    return patches.map((patch) => ({
        ...patch,
        sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(patchPath(patch.file)))
            .digest('hex')
    }));
}

export function hasRequiredMpvPatches(manifest) {
    const applied = manifest?.mpv?.patches;
    return (
        Array.isArray(applied) &&
        getRequiredMpvPatches().every((required) =>
            applied.some(
                (patch) =>
                    patch?.file === required.file &&
                    patch?.sha256 === required.sha256
            )
        )
    );
}

export function applyMpvPatches(sourceDirectory) {
    for (const patch of patches) {
        const patchFile = patchPath(patch.file);
        for (const args of [
            ['apply', '--check', patchFile],
            ['apply', patchFile]
        ]) {
            const result = spawnSync('git', args, {
                cwd: sourceDirectory,
                encoding: 'utf8'
            });
            if (result.status !== 0) {
                throw new Error(
                    `Unable to apply MPV CoreAudio fix: ${result.stderr || result.error || result.status}`
                );
            }
        }
    }
}

export function getRequiredLibassPatches() {
    return libassPatches.map((patch) => ({
        ...patch,
        sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(patchPath(patch.file)))
            .digest('hex')
    }));
}

export function hasRequiredLibassPatches(manifest) {
    const applied = manifest?.packages?.libass?.patches;
    return (
        Array.isArray(applied) &&
        getRequiredLibassPatches().every((required) =>
            applied.some(
                (patch) =>
                    patch?.file === required.file &&
                    patch?.sha256 === required.sha256
            )
        )
    );
}

export function applyLibassPatches(sourceDirectory) {
    for (const patch of libassPatches) {
        const patchFile = patchPath(patch.file);
        for (const args of [
            ['apply', '--check', patchFile],
            ['apply', patchFile]
        ]) {
            const result = spawnSync('git', args, {
                cwd: sourceDirectory,
                encoding: 'utf8'
            });
            if (result.status !== 0) {
                throw new Error(
                    `Unable to apply libass subtitle position fix: ${result.stderr || result.error || result.status}`
                );
            }
        }
    }
}
