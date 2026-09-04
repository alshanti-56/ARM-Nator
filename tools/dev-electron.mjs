import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockDirectory = path.join(workspaceRoot, 'tmp');
const lockPath = path.join(lockDirectory, 'arm-nator-dev.lock');
const electronMain = path.join(workspaceRoot, 'dist/apps/electron-backend/main.js');
const electronBinary = path.join(workspaceRoot, 'node_modules/.bin/electron');
const electronLogPath = path.join(lockDirectory, 'electron.log');
const rendererPort = 4300;
const restartDebounceMs = 450;

let lockHandle;
let rendererProcess;
let buildProcess;
let electronProcess;
let mtimeTimer;
let restartTimer;
let restartInProgress = false;
let restartRequested = false;
let shuttingDown = false;
let lastBuildMtime = 0;
let electronLogFd;

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isOurRunner(pid) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8'
    });
    return result.status === 0 && result.stdout.includes('tools/dev-electron.mjs');
}

function isWorkspaceCwd(pid) {
    const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8'
    });
    return result.status === 0 && result.stdout.includes(`n${workspaceRoot}`);
}

function findLegacyRunners() {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (result.status !== 0) return [];

    return result.stdout
        .split('\n')
        .flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) return [];
            const pid = Number(match[1]);
            const command = match[2];
            const isLegacyNx =
                command.includes('electron-backend:serve-electron-dev') ||
                /nx(?:\.js)?\s+(?:run\s+)?serve electron-backend/.test(command);
            return pid !== process.pid && isLegacyNx && isWorkspaceCwd(pid) ? [pid] : [];
        });
}

function findWebApiOnlyRunners() {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (result.status !== 0) return [];

    return result.stdout
        .split('\n')
        .flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(.+)$/);
            if (!match) return [];

            const pid = Number(match[1]);
            const command = match[2];
            const isWebApiOnlyElectron =
                command.includes('dist/apps/electron-backend/main.js') &&
                command.includes('--web-api-only');

            return pid !== process.pid &&
                isWebApiOnlyElectron &&
                isWorkspaceCwd(pid)
                ? [pid]
                : [];
        });
}

async function waitForExit(pid, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !isAlive(pid);
}

async function removeLockIfOwned(pid) {
    try {
        const current = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (current?.pid === pid) {
            await fs.promises.rm(lockPath, { force: true });
        }
    } catch {
        // The owner may have removed the lock while it was shutting down.
    }
}

async function acquireLock() {
    await fs.promises.mkdir(lockDirectory, { recursive: true });

    while (true) {
        try {
            lockHandle = await fs.promises.open(lockPath, 'wx');
            await lockHandle.writeFile(
                JSON.stringify({ pid: process.pid, cwd: workspaceRoot, startedAt: new Date().toISOString() })
            );
            return;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;

            let owner;
            try {
                owner = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
            } catch {
                await fs.promises.rm(lockPath, { force: true });
                continue;
            }

            if (!owner?.pid || !isAlive(owner.pid)) {
                await fs.promises.rm(lockPath, { force: true });
                continue;
            }

            if (!isOurRunner(owner.pid)) {
                throw new Error(`A dev runner lock is held by PID ${owner.pid}. Remove ${lockPath} only after verifying it is stale.`);
            }

            console.log(`[dev] Stopping previous ARM-Nator dev runner (PID ${owner.pid})...`);
            process.kill(owner.pid, 'SIGTERM');
            if (!(await waitForExit(owner.pid))) {
                console.warn(`[dev] Previous runner did not exit; sending SIGKILL to PID ${owner.pid}.`);
                process.kill(owner.pid, 'SIGKILL');
                await waitForExit(owner.pid, 1000);
            }
            await removeLockIfOwned(owner.pid);
        }
    }
}

async function stopPid(pid, label) {
    console.log(`[dev] Stopping ${label} (PID ${pid})...`);
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }
    if (!(await waitForExit(pid, 3000))) {
        console.warn(`[dev] ${label} did not exit; sending SIGKILL to PID ${pid}.`);
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // It exited between the checks.
        }
        await waitForExit(pid, 1000);
    }
}

async function stopLegacyRunners() {
    for (const pid of findLegacyRunners()) {
        await stopPid(pid, 'legacy Nx dev runner');
    }
}

async function stopConflictingElectronRunners() {
    for (const pid of findWebApiOnlyRunners()) {
        await stopPid(pid, 'conflicting web-api-only Electron process');
    }
}

async function releaseLock() {
    clearInterval(mtimeTimer);
    clearTimeout(restartTimer);
    if (lockHandle) {
        await lockHandle.close();
        lockHandle = undefined;
        await fs.promises.rm(lockPath, { force: true });
    }
    if (electronLogFd !== undefined) {
        fs.closeSync(electronLogFd);
        electronLogFd = undefined;
    }
}

function getElectronLogFd() {
    if (electronLogFd === undefined) {
        electronLogFd = fs.openSync(electronLogPath, 'a');
    }
    return electronLogFd;
}

function spawnGroup(command, args, options = {}) {
    return spawn(command, args, {
        cwd: workspaceRoot,
        env: process.env,
        stdio: options.stdio ?? 'inherit',
        detached: true
    });
}

async function stopProcess(child) {
    if (!child?.pid) return;
    try {
        process.kill(-child.pid, 'SIGTERM');
    } catch {
        child.kill('SIGTERM');
    }
    await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

function waitForPort(port, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const loopbackHosts = ['127.0.0.1', '::1'];
        let hostIndex = 0;
        const attempt = () => {
            const host = loopbackHosts[hostIndex];
            hostIndex = (hostIndex + 1) % loopbackHosts.length;
            const socket = net.createConnection({ host, port });
            socket.once('connect', () => {
                socket.destroy();
                resolve();
            });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() >= deadline) {
                    reject(
                        new Error(
                            `Renderer did not open loopback port ${port} within ${timeoutMs / 1000}s.`
                        )
                    );
                } else {
                    setTimeout(attempt, hostIndex === 0 ? 250 : 0);
                }
            });
        };
        attempt();
    });
}

async function restartElectron() {
    if (restartInProgress || shuttingDown) {
        restartRequested = true;
        return;
    }
    restartInProgress = true;
    try {
        if (electronProcess) {
            const previous = electronProcess;
            electronProcess = undefined;
            await stopProcess(previous);
        }
        if (!fs.existsSync(electronMain)) return;
        console.log('[dev] Starting Electron with the latest build.');
        electronProcess = spawnGroup(electronBinary, [electronMain], {
            // Detached Electron must not inherit the runner's terminal pipe.
            // Codex/IDE terminals can close independently, which otherwise
            // turns a later console write into an uncaught EPIPE exception.
            stdio: ['ignore', getElectronLogFd(), getElectronLogFd()],
        });
        electronProcess.once('error', (error) => {
            console.error(`[dev] Electron failed to start: ${error.message}`);
        });
    } finally {
        restartInProgress = false;
        if (restartRequested) {
            restartRequested = false;
            scheduleRestart();
        }
    }
}

function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => void restartElectron(), restartDebounceMs);
}

function watchBuildOutput() {
    try {
        lastBuildMtime = fs.statSync(electronMain).mtimeMs;
    } catch {
        lastBuildMtime = 0;
    }
    mtimeTimer = setInterval(() => {
        try {
            const mtime = fs.statSync(electronMain).mtimeMs;
            if (mtime !== lastBuildMtime) {
                lastBuildMtime = mtime;
                scheduleRestart();
            }
        } catch {
            // The first build may not have emitted main.js yet.
        }
    }, 200);
}

async function shutdown(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    clearInterval(mtimeTimer);
    await Promise.all([stopProcess(electronProcess), stopProcess(buildProcess), stopProcess(rendererProcess)]);
    electronProcess = undefined;
    buildProcess = undefined;
    rendererProcess = undefined;
    await releaseLock();
    process.exit(exitCode);
}

async function main() {
    await acquireLock();
    await stopLegacyRunners();
    await stopConflictingElectronRunners();
    process.on('SIGINT', () => void shutdown(130));
    process.on('SIGTERM', () => void shutdown(143));

    rendererProcess = spawnGroup('pnpm', ['exec', 'nx', 'run', 'desktop-ui:serve']);
    rendererProcess.once('exit', (code) => {
        if (!shuttingDown && code !== 0) void shutdown(code ?? 1);
    });
    await waitForPort(rendererPort);

    buildProcess = spawnGroup('pnpm', ['exec', 'nx', 'run', 'electron-backend:build-dev', '--watch']);
    buildProcess.once('exit', (code) => {
        if (!shuttingDown && code !== 0) void shutdown(code ?? 1);
    });
    watchBuildOutput();
    await restartElectron();
    console.log('[dev] Watching source changes; native build output is excluded from hot reload.');
}

main().catch(async (error) => {
    console.error(`[dev] ${error.message}`);
    await shutdown(1);
});
