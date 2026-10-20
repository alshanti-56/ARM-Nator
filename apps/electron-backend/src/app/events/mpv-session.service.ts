import { ChildProcess, spawn, spawnSync } from 'child_process';
import { createConnection } from 'net';
import { PlayerContentInfo } from '@arm-nator/shared/interfaces';
import {
    MPV_PLAYER_ARGUMENTS,
    MPV_PLAYER_PATH,
    MPV_REUSE_INSTANCE,
    store,
} from '../services/store.service';
import {
    buildExternalPlayerSpawnSpec,
    buildPlayerArgsWithCustomArguments,
    getDefaultMpvPath,
    normalizeCustomPlayerPath,
    parseExternalPlayerArguments,
    PlayerPathOptions,
    resolveExternalPlayerLaunchContext,
    shouldReuseMpvInstance,
    shouldUseMpvSocketBridge,
} from './external-player-launch-context';
import { resolveEffectiveExternalPlaybackRequest } from './external-player-playback-request';
import {
    buildPlayerStartError,
    externalPlayerSessions,
    maskUrlForLogs,
    sendPlaybackPositionUpdate,
    sendPlayerErrorNotification,
    traceExternalPlayer,
} from './external-player-runtime';
import {
    closeMpvSessionProcess,
    sendMpvIpcCommand,
    terminateMpvProcessAndWait,
} from './mpv-session-teardown';

export interface OpenExternalPlayerRequest {
    url: string;
    title: string;
    thumbnail?: string;
    userAgent?: string;
    referer?: string;
    origin?: string;
    contentInfo?: PlayerContentInfo;
    startTime?: number;
    headers?: Record<string, string>;
    subtitleUrl?: string;
}

let mpvProcess: ChildProcess | null = null;
let mpvSocketPath: string | null = null;
let mpvActiveProcess: ChildProcess | null = null;
let mpvActiveSessionId: string | null = null;
let positionPollingInterval: NodeJS.Timeout | null = null;

function getMpvPath(options: PlayerPathOptions = {}): string {
    return (
        normalizeCustomPlayerPath(store.get(MPV_PLAYER_PATH)) ??
        getDefaultMpvPath(options)
    );
}

export function getMpvAvailability() {
    const context = resolveExternalPlayerLaunchContext(
        'mpv',
        getMpvPath()
    );
    const spec = buildExternalPlayerSpawnSpec(context, ['--version']);
    const result = spawnSync(spec.command, spec.args, {
        encoding: 'utf8',
        timeout: 3000,
    });
    return {
        engine: 'mpv',
        available: !result.error && result.status === 0,
        path: context.playerPath,
        reason: result.error?.message || result.stderr?.trim() || undefined,
    };
}

async function getMpvProperty(
    socketPath: string,
    property: string
): Promise<number | null> {
    return new Promise((resolve) => {
        const client = createConnection(socketPath);
        const request =
            JSON.stringify({
                command: ['get_property', property],
            }) + '\n';

        let data = '';

        client.on('connect', () => {
            client.write(request);
        });

        const timeoutHandle = setTimeout(() => {
            client.destroy();
            resolve(null);
        }, 2000);

        client.on('data', (chunk) => {
            data += chunk.toString();
            if (data.includes('\n')) {
                clearTimeout(timeoutHandle);
                try {
                    const lines = data.split('\n');
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        const response = JSON.parse(line);
                        if (response.data !== undefined) {
                            client.destroy();
                            resolve(response.data);
                            return;
                        }
                    }
                } catch {
                    // Ignore partial JSON while MPV is still writing.
                }
            }
        });

        client.on('end', () => {
            clearTimeout(timeoutHandle);
            if (data && !data.includes('\n')) {
                try {
                    const response = JSON.parse(data);
                    resolve(response.data ?? null);
                } catch {
                    resolve(null);
                }
            }
        });

        client.on('error', () => {
            clearTimeout(timeoutHandle);
            resolve(null);
        });
    });
}

function stopPositionPolling(): void {
    if (positionPollingInterval) {
        clearInterval(positionPollingInterval);
        positionPollingInterval = null;
    }
}

function shouldIgnoreMpvStdoutLine(line: string): boolean {
    return /^(\(Paused\)\s*)?AV:\s/.test(line);
}

function startPositionPolling(
    socketPath: string,
    contentInfo: PlayerContentInfo | undefined,
    sessionId: string
): void {
    stopPositionPolling();

    setTimeout(() => {
        positionPollingInterval = setInterval(async () => {
            try {
                const position = await getMpvProperty(socketPath, 'time-pos');
                const duration = await getMpvProperty(socketPath, 'duration');

                if (position !== null) {
                    const snapshot = {
                        positionSeconds: Math.floor(position),
                        durationSeconds: duration ? Math.floor(duration) : null,
                    };
                    if (contentInfo) {
                        sendPlaybackPositionUpdate(
                            sessionId,
                            contentInfo,
                            snapshot
                        );
                    } else {
                        externalPlayerSessions.markPlaying(sessionId);
                        externalPlayerSessions.updateSession(sessionId, {
                            ...snapshot,
                            canPause: true,
                            canSeek: snapshot.durationSeconds !== null,
                        });
                    }
                }
            } catch {
                stopPositionPolling();
            }
        }, 5000);
    }, 2000);
}

function sendMpvCommand(
    command: string,
    args: Array<string | number>,
    socketPath = mpvSocketPath
): Promise<void> {
    if (!socketPath) {
        return Promise.reject(new Error('No MPV socket path available'));
    }
    traceExternalPlayer('mpv ipc command', {
        command,
        argsCount: args.length,
    });
    return sendMpvIpcCommand(socketPath, command, args).catch((error) => {
        console.error('MPV socket command failed:', error);
        throw error;
    });
}

function clearMpvProcessReferences(process: ChildProcess): void {
    if (mpvProcess === process) {
        mpvProcess = null;
        mpvSocketPath = null;
    }
    if (mpvActiveProcess === process) {
        mpvActiveProcess = null;
        mpvActiveSessionId = null;
        stopPositionPolling();
    }
}

async function closeMpvSession(
    sessionId: string,
    process: ChildProcess,
    socketPath: string | null,
    reuseInstance: boolean
): Promise<void> {
    const isReusableOwner =
        reuseInstance &&
        Boolean(socketPath) &&
        mpvProcess === process &&
        mpvSocketPath === socketPath;

    const outcome = await closeMpvSessionProcess({
        sessionId,
        process,
        socketPath,
        isReusableOwner,
        activeSessionId: mpvActiveSessionId,
        stopPlayback: (path) => sendMpvCommand('stop', [], path),
    });
    if (outcome === 'superseded') {
        return;
    }
    if (outcome === 'terminated') {
        clearMpvProcessReferences(process);
        traceExternalPlayer('terminated mpv process after session close');
    } else {
        traceExternalPlayer('stopped media in reusable mpv instance');
    }

    if (mpvActiveProcess === process && mpvActiveSessionId === sessionId) {
        mpvActiveSessionId = null;
        stopPositionPolling();
    }
}

function killStoredMpvProcess(reason: string): void {
    if (!mpvProcess || mpvProcess.killed) {
        return;
    }
    traceExternalPlayer(reason);
    mpvProcess.kill();
    mpvProcess = null;
    mpvSocketPath = null;
    stopPositionPolling();
}

export function setMpvReuseInstance(reuseInstance: boolean): void {
    traceExternalPlayer('set mpv reuse instance', { reuseInstance });
    store.set(MPV_REUSE_INSTANCE, reuseInstance);

    if (!reuseInstance) {
        killStoredMpvProcess('clean up mpv process after disabling reuse');
    }
}

/**
 * Kill the MPV instance kept alive for reuse. The reused process is spawned
 * non-detached with piped stdio, so without an explicit kill it outlives the
 * app and keeps playing after quit.
 */
export function shutdownMpvSession(): void {
    killStoredMpvProcess('kill reused mpv process on app shutdown');
}

export async function controlMpvSession(
    sessionId: string,
    action: 'toggle-pause' | 'seek-relative',
    value = 0
) {
    const session = externalPlayerSessions.getSession(sessionId);
    if (!session || session.player !== 'mpv' || !mpvSocketPath) {
        return session;
    }
    if (action === 'toggle-pause') {
        await sendMpvCommand('cycle', ['pause']);
    } else {
        await sendMpvCommand('seek', [value, 'relative']);
    }
    return externalPlayerSessions.updateSession(sessionId, {
        canPause: true,
        canSeek: true,
    });
}

export async function openMpvPlayer({
    url,
    title,
    thumbnail,
    userAgent,
    referer,
    origin,
    contentInfo,
    startTime,
    headers,
    subtitleUrl,
}: OpenExternalPlayerRequest) {
    const session = externalPlayerSessions.beginSession({
        player: 'mpv',
        title,
        thumbnail,
        streamUrl: url,
        contentInfo,
    });

    try {
        const mpvLaunchContext = resolveExternalPlayerLaunchContext(
            'mpv',
            getMpvPath()
        );
        const customMpvArguments = store.get(MPV_PLAYER_ARGUMENTS, '');
        const requestedReuseInstance = store.get(MPV_REUSE_INSTANCE, false);
        const reuseInstance = shouldReuseMpvInstance(requestedReuseInstance);
        const useMpvSocketBridge = shouldUseMpvSocketBridge();
        const {
            effectiveOrigin,
            effectiveReferer,
            effectiveUserAgent,
            headerFields,
        } = resolveEffectiveExternalPlaybackRequest({
            url,
            userAgent,
            referer,
            origin,
            headers,
        });

        traceExternalPlayer('open mpv player', {
            path: mpvLaunchContext.playerPath,
            launchMode: mpvLaunchContext.mode,
            requestedReuseInstance,
            reuseInstance,
            stream: maskUrlForLogs(url),
            hasUserAgent: Boolean(effectiveUserAgent),
            hasReferer: Boolean(effectiveReferer),
            hasOrigin: Boolean(effectiveOrigin),
            headerCount: headerFields.length,
            hasContentInfo: Boolean(contentInfo),
            startTime: startTime ?? null,
            customArgumentCount:
                parseExternalPlayerArguments(customMpvArguments).length,
        });

        const existingProcess = mpvActiveProcess;
        const reusableProcessAvailable =
            reuseInstance &&
            existingProcess !== null &&
            existingProcess === mpvProcess &&
            !existingProcess.killed &&
            Boolean(mpvSocketPath);
        if (existingProcess && !reusableProcessAvailable) {
            const existingSessionId = mpvActiveSessionId;
            if (existingSessionId) {
                await closeMpvSession(
                    existingSessionId,
                    existingProcess,
                    existingProcess === mpvProcess ? mpvSocketPath : null,
                    false
                );
                externalPlayerSessions.markClosed(existingSessionId);
            } else {
                await terminateMpvProcessAndWait(existingProcess);
                clearMpvProcessReferences(existingProcess);
            }
        }

        if (
            reuseInstance &&
            mpvProcess &&
            mpvActiveProcess === mpvProcess &&
            !mpvProcess.killed &&
            mpvSocketPath
        ) {
            const reusedProcess = mpvProcess;
            const reusedSocketPath = mpvSocketPath;
            const replacedSessionId = mpvActiveSessionId;
            traceExternalPlayer('reuse existing mpv instance');
            try {
                if (effectiveUserAgent) {
                    await sendMpvCommand('set_property', [
                        'user-agent',
                        effectiveUserAgent,
                    ], reusedSocketPath);
                }
                if (effectiveReferer) {
                    await sendMpvCommand('set_property', [
                        'referrer',
                        effectiveReferer,
                    ], reusedSocketPath);
                }
                if (headerFields.length > 0) {
                    await sendMpvCommand('set_property', [
                        'http-header-fields',
                        headerFields.join(','),
                    ], reusedSocketPath);
                }

                const loadFileArgs: Array<string | number> = [url, 'replace'];
                const loadFileOptions: string[] = [];

                if (title) {
                    loadFileOptions.push(`force-media-title=${title}`);
                }
                if (loadFileOptions.length > 0) {
                    loadFileArgs.push(-1, loadFileOptions.join(','));
                }

                await sendMpvCommand('loadfile', loadFileArgs, reusedSocketPath);
                traceExternalPlayer('loaded new url in existing mpv instance');
                mpvActiveProcess = reusedProcess;
                mpvActiveSessionId = session.id;
                if (replacedSessionId && replacedSessionId !== session.id) {
                    externalPlayerSessions.markClosed(replacedSessionId);
                }
                externalPlayerSessions.attachCloser(session.id, () =>
                    closeMpvSession(
                        session.id,
                        reusedProcess,
                        reusedSocketPath,
                        true
                    )
                );

                if (startTime) {
                    await sendMpvCommand('seek', [
                        String(startTime),
                        'absolute',
                    ], reusedSocketPath);
                }

                if (contentInfo) {
                    startPositionPolling(
                        reusedSocketPath,
                        contentInfo,
                        session.id
                    );
                } else {
                    stopPositionPolling();
                }

                return externalPlayerSessions.markOpened(session.id) ?? session;
            } catch (err) {
                console.error('Failed to send command to existing MPV:', err);
                await terminateMpvProcessAndWait(reusedProcess);
                clearMpvProcessReferences(reusedProcess);
                if (replacedSessionId) {
                    externalPlayerSessions.markClosed(replacedSessionId);
                }
            }
        }

        traceExternalPlayer('create new mpv instance');

        let socketPath: string | null = null;
        const args: string[] = [];

        if (useMpvSocketBridge) {
            socketPath = `/tmp/mpvsocket-${Date.now()}`;
            args.push(`--input-ipc-server=${socketPath}`, '--idle=yes');
        }

        args.push('--ytdl=no');

        if (effectiveUserAgent) {
            args.push(`--user-agent=${effectiveUserAgent}`);
        }

        if (effectiveReferer) {
            args.push(`--referrer=${effectiveReferer}`);
        }

        if (headerFields.length > 0) {
            args.push(`--http-header-fields=${headerFields.join(',')}`);
        }

        if (title) {
            args.push(`--force-media-title=${title}`);
        }

        if (startTime) {
            args.push(`--start=${startTime}`);
        }

        if (subtitleUrl) {
            args.push(`--sub-file=${subtitleUrl}`);
        }

        args.push(url);

        await new Promise<void>((resolve, reject) => {
            const spawnSpec = buildExternalPlayerSpawnSpec(
                mpvLaunchContext,
                buildPlayerArgsWithCustomArguments(customMpvArguments, args)
            );
            const proc = spawn(spawnSpec.command, spawnSpec.args, {
                shell: false,
                detached: !reuseInstance,
                stdio: reuseInstance ? ['ignore', 'pipe', 'pipe'] : 'ignore',
            });

            if (proc.stdout) {
                proc.stdout.on('data', (data) => {
                    const lines = data
                        .toString()
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);

                    for (const output of lines) {
                        if (shouldIgnoreMpvStdoutLine(output)) {
                            continue;
                        }

                        traceExternalPlayer('mpv stdout', { output });

                        if (
                            output.includes('Failed to open') ||
                            output.includes('Error opening') ||
                            output.includes('Protocol not found') ||
                            output.includes('Connection refused') ||
                            output.includes('error') ||
                            output.includes('403') ||
                            output.includes('404')
                        ) {
                            console.error('[MPV ERROR from stdout]:', output);
                            sendPlayerErrorNotification('MPV', output);
                        }
                    }
                });
            }

            if (proc.stderr) {
                proc.stderr.on('data', (data) => {
                    const output = data.toString().trim();
                    if (output) {
                        console.error('[MPV stderr]:', output);

                        if (
                            output.includes('Failed to open') ||
                            output.includes(
                                'Exiting... (Errors when loading file)'
                            ) ||
                            output.includes('Error opening') ||
                            output.includes('Protocol not found') ||
                            output.includes('Connection refused') ||
                            output.includes('error') ||
                            output.includes('403') ||
                            output.includes('404')
                        ) {
                            console.error('[MPV ERROR]:', output);
                            sendPlayerErrorNotification('MPV', output);
                        }
                    }
                });
            }

            proc.on('error', (err) => {
                console.error('Failed to start MPV player:', err);
                clearMpvProcessReferences(proc);
                externalPlayerSessions.markError(
                    session.id,
                    `Failed to start MPV player: ${err.message}`
                );
                reject(buildPlayerStartError('MPV', err, mpvLaunchContext));
            });

            proc.on('exit', (code) => {
                traceExternalPlayer('mpv exited', { code });
                const isCurrentProcess = mpvActiveProcess === proc;
                const endedSessionId = isCurrentProcess
                    ? mpvActiveSessionId ?? session.id
                    : session.id;
                clearMpvProcessReferences(proc);

                if (code !== 0 && code !== null) {
                    console.error(
                        `[MPV ERROR] MPV exited with error code ${code}`
                    );
                    sendPlayerErrorNotification(
                        'MPV',
                        `MPV player closed unexpectedly (exit code: ${code})`
                    );
                    externalPlayerSessions.markError(
                        endedSessionId,
                        `MPV player closed unexpectedly (exit code: ${code})`
                    );
                    return;
                }

                externalPlayerSessions.markClosed(endedSessionId);
            });

            mpvActiveProcess = proc;
            mpvActiveSessionId = session.id;
            if (reuseInstance && socketPath) {
                mpvProcess = proc;
                mpvSocketPath = socketPath;
                traceExternalPlayer('stored mpv process for reuse', {
                    socketPath,
                });
            } else {
                proc.unref();
            }

            externalPlayerSessions.attachCloser(session.id, () =>
                closeMpvSession(session.id, proc, socketPath, reuseInstance)
            );

            if (useMpvSocketBridge && socketPath) {
                startPositionPolling(socketPath, contentInfo, session.id);
                externalPlayerSessions.updateSession(session.id, {
                    canPause: true,
                    canSeek: true,
                });
            }

            setTimeout(() => {
                if (!proc.killed) {
                    resolve();
                }
            }, 100);
        });

        return externalPlayerSessions.markOpened(session.id) ?? session;
    } catch (error) {
        console.error('Error opening MPV player:', error);
        externalPlayerSessions.markError(
            session.id,
            error instanceof Error ? error.message : String(error)
        );
        throw error;
    }
}
