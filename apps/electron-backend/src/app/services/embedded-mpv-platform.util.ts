import { app } from 'electron';
import { existsSync } from 'fs';
import path from 'path';

function dedupeDefinedPaths(paths: Array<string | undefined>): string[] {
    return [
        ...new Set(paths.filter((value): value is string => Boolean(value))),
    ];
}

function getLocalBuildAddonPath(): string {
    return path.resolve(
        process.cwd(),
        'apps/electron-backend/native/build/Release/embedded_mpv.node'
    );
}

function getDistAddonPaths(): string[] {
    return [
        path.resolve(__dirname, 'native/embedded_mpv.node'),
        path.resolve(__dirname, '../../native/embedded_mpv.node'),
    ];
}

function getPackagedAddonPaths(): string[] {
    const resourcesPath = (
        process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    return dedupeDefinedPaths([
        resourcesPath
            ? path.resolve(
                  resourcesPath,
                  'app.asar.unpacked',
                  'electron-backend',
                  'native',
                  'embedded_mpv.node'
              )
            : undefined,
        app.getAppPath()
            ? path.join(
                  path.dirname(app.getAppPath()),
                  'app.asar.unpacked',
                  'electron-backend',
                  'native',
                  'embedded_mpv.node'
              )
            : undefined,
    ]);
}

export function getEmbeddedMpvAddonCandidatePaths(): string[] {
    const packagedPaths = getPackagedAddonPaths();
    return app.isPackaged
        ? packagedPaths
        : dedupeDefinedPaths([
              getLocalBuildAddonPath(),
              ...getDistAddonPaths(),
              ...packagedPaths,
          ]);
}

export type EmbeddedMpvRuntimeAvailability =
    | { usable: true }
    | {
          usable: false;
          reason:
              | 'unsupported-platform'
              | 'unsupported-architecture'
              | 'runtime-artifact-missing';
      };

let cachedAvailability: EmbeddedMpvRuntimeAvailability | undefined;

export function getEmbeddedMpvRuntimeAvailability(): EmbeddedMpvRuntimeAvailability {
    if (cachedAvailability !== undefined) {
        return cachedAvailability;
    }

    const availability: EmbeddedMpvRuntimeAvailability =
        process.platform !== 'darwin'
            ? { usable: false, reason: 'unsupported-platform' }
            : process.arch !== 'arm64'
              ? { usable: false, reason: 'unsupported-architecture' }
              : getEmbeddedMpvAddonCandidatePaths().some(existsSync)
                ? { usable: true }
                : { usable: false, reason: 'runtime-artifact-missing' };

    cachedAvailability = availability;
    return availability;
}
