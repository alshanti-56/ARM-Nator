import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const ARM_NATOR_E2E_DATA_DIR_ENV = 'ARM_NATOR_E2E_DATA_DIR';

function ensureDirectory(dirPath: string): string {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
    }

    return dirPath;
}

export function getIptvnatorDataRoot(): string {
    const e2eDataDir = process.env[ARM_NATOR_E2E_DATA_DIR_ENV]?.trim();

    if (e2eDataDir) {
        return ensureDirectory(e2eDataDir);
    }

    return ensureDirectory(join(homedir(), '.arm-nator'));
}

export function getIptvnatorDatabaseDirectory(): string {
    return ensureDirectory(join(getIptvnatorDataRoot(), 'databases'));
}

export function getIptvnatorDatabasePath(): string {
    return join(getIptvnatorDatabaseDirectory(), 'arm-nator.db');
}

export function getElectronUserDataPath(): string | null {
    const e2eDataDir = process.env[ARM_NATOR_E2E_DATA_DIR_ENV]?.trim();

    if (!e2eDataDir) {
        return null;
    }

    return ensureDirectory(join(e2eDataDir, 'user-data'));
}

export function getElectronConfigDirectory(): string | null {
    const e2eDataDir = process.env[ARM_NATOR_E2E_DATA_DIR_ENV]?.trim();

    if (!e2eDataDir) {
        return null;
    }

    return ensureDirectory(join(e2eDataDir, 'config'));
}
