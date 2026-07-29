import { app } from 'electron';
import { accessSync, constants as fsConstants, statSync } from 'fs';
import path from 'path';

export function isFrameCopyPlatformSupported(): boolean {
    return process.platform === 'darwin' && process.arch === 'arm64';
}

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

export function resolveFrameCopyHelperPath(): string | null {
    const addonCandidates = app.isPackaged
        ? getPackagedAddonPaths()
        : [getLocalBuildAddonPath(), ...getDistAddonPaths()];
    return (
        addonCandidates
            .map((candidatePath) => path.dirname(candidatePath))
            .map((nativeDir) => ({
                helper: path.join(nativeDir, 'arm-nator_mpv_helper'),
                reader: path.join(nativeDir, 'embedded_mpv_frame_reader.node'),
            }))
            .find(({ helper, reader }) => {
                try {
                    accessSync(helper, fsConstants.X_OK);
                    accessSync(reader, fsConstants.R_OK);
                    return (
                        statSync(helper).isFile() &&
                        statSync(reader).isFile()
                    );
                } catch {
                    return false;
                }
            })?.helper ?? null
    );
}

export type FrameCopyRuntimeAvailability =
    | { usable: true }
    | {
          usable: false;
          reason:
              | 'unsupported-platform'
              | 'unsupported-architecture'
              | 'runtime-artifact-missing';
      };

let cachedAvailability: FrameCopyRuntimeAvailability | undefined;

export function getFrameCopyRuntimeAvailability(
    resolveHelper: () => string | null = resolveFrameCopyHelperPath
): FrameCopyRuntimeAvailability {
    if (
        resolveHelper === resolveFrameCopyHelperPath &&
        cachedAvailability !== undefined
    ) {
        return cachedAvailability;
    }

    const availability: FrameCopyRuntimeAvailability =
        process.platform !== 'darwin'
            ? { usable: false, reason: 'unsupported-platform' }
            : process.arch !== 'arm64'
              ? { usable: false, reason: 'unsupported-architecture' }
              : resolveHelper()
                ? { usable: true }
                : { usable: false, reason: 'runtime-artifact-missing' };

    if (resolveHelper === resolveFrameCopyHelperPath) {
        cachedAvailability = availability;
    }
    return availability;
}

export function isFrameCopyRuntimeUsable(
    resolveHelper: () => string | null = resolveFrameCopyHelperPath
): boolean {
    return getFrameCopyRuntimeAvailability(resolveHelper).usable;
}

export function shouldPromotePersistedFrameCopyOptIn(
    storedEnabled: boolean,
    explicitEnv: string | undefined,
    runtimeUsable: () => boolean = isFrameCopyRuntimeUsable
): boolean {
    return explicitEnv === undefined && storedEnabled && runtimeUsable();
}
