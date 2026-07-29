import { existsSync, readdirSync } from 'fs';
import path from 'path';
import {
    ExternalPlayerName,
    parseExternalPlayerArguments,
    type ExternalPlayerArgumentsInput,
} from '@arm-nator/shared/interfaces';

export type PathExists = (path: string) => boolean;
export type ReadDirectory = (path: string) => string[];

export interface PlayerPathOptions {
    pathExists?: PathExists;
    readDirectory?: ReadDirectory;
}

export interface ExternalPlayerLaunchContext {
    mode: 'direct';
    playerPath: string;
    command: string;
    argsPrefix: [];
}

export interface ExternalPlayerSpawnSpec {
    mode: 'direct';
    playerPath: string;
    command: string;
    args: string[];
}

export function normalizeCustomPlayerPath(
    value: string | null | undefined
): string | null {
    const trimmedValue = value?.trim();
    return trimmedValue ? trimmedValue : null;
}

export function normalizePlayerPathForStore(
    value: string | null | undefined
): string {
    return normalizeCustomPlayerPath(value) ?? '';
}

const macOSAppBundleExecutableNames: Record<ExternalPlayerName, string> = {
    mpv: 'mpv',
    vlc: 'VLC',
};

function resolveMacOSAppBundlePlayerPath(
    player: ExternalPlayerName,
    playerPath: string
): string {
    const appBundlePath = playerPath.replace(/[\\/]+$/, '') || playerPath;
    return /\.app$/i.test(appBundlePath)
        ? path.join(
              appBundlePath,
              'Contents',
              'MacOS',
              macOSAppBundleExecutableNames[player]
          )
        : playerPath;
}

function getDefaultPlayerPath(
    player: ExternalPlayerName,
    options: PlayerPathOptions
): string {
    return player === 'mpv'
        ? getDefaultMpvPath(options)
        : getDefaultVlcPath(options);
}

export function resolveExternalPlayerLaunchContext(
    player: ExternalPlayerName,
    customPlayerPath?: string,
    options: PlayerPathOptions = {}
): ExternalPlayerLaunchContext {
    const playerPath = resolveMacOSAppBundlePlayerPath(
        player,
        normalizeCustomPlayerPath(customPlayerPath) ??
            getDefaultPlayerPath(player, options)
    );
    return {
        mode: 'direct',
        playerPath,
        command: playerPath,
        argsPrefix: [],
    };
}

export function buildExternalPlayerSpawnSpec(
    launchContext: ExternalPlayerLaunchContext,
    playerArgs: string[]
): ExternalPlayerSpawnSpec {
    return {
        mode: 'direct',
        playerPath: launchContext.playerPath,
        command: launchContext.command,
        args: [...playerArgs],
    };
}

export { parseExternalPlayerArguments };

export function buildPlayerArgsWithCustomArguments(
    customArguments: ExternalPlayerArgumentsInput,
    playerArgs: string[]
): string[] {
    return [...parseExternalPlayerArguments(customArguments), ...playerArgs];
}

export function shouldReuseMpvInstance(
    requestedReuseInstance: boolean
): boolean {
    return requestedReuseInstance;
}

export function shouldUseMpvSocketBridge(): boolean {
    return true;
}

export function shouldReuseVlcInstance(
    requestedReuseInstance: boolean
): boolean {
    return requestedReuseInstance;
}

export function getDefaultMpvPath(options: PlayerPathOptions = {}): string {
    const pathExists = options.pathExists ?? existsSync;
    for (const playerPath of [
        '/Applications/mpv.app/Contents/MacOS/mpv',
        '/opt/homebrew/bin/mpv',
        '/usr/local/bin/mpv',
    ]) {
        if (pathExists(playerPath)) {
            return playerPath;
        }
    }
    return 'mpv';
}

export function getDefaultVlcPath(options: PlayerPathOptions = {}): string {
    const pathExists = options.pathExists ?? existsSync;
    const readDirectory = options.readDirectory ?? readdirSync;
    for (const playerPath of [
        '/Applications/VLC.app/Contents/MacOS/VLC',
        ...getHomebrewCaskVlcPaths(readDirectory),
    ]) {
        if (pathExists(playerPath)) {
            return playerPath;
        }
    }
    return 'vlc';
}

function getHomebrewCaskVlcPaths(readDirectory: ReadDirectory): string[] {
    const caskroomPath = '/opt/homebrew/Caskroom/vlc';
    try {
        return readDirectory(caskroomPath)
            .filter((entry) => entry.trim().length > 0)
            .map((entry) =>
                path.join(
                    caskroomPath,
                    entry,
                    'VLC.app',
                    'Contents',
                    'MacOS',
                    'VLC'
                )
            );
    } catch {
        return [];
    }
}
