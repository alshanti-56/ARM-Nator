import type mpegts from 'mpegts.js';

const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const STABLE_PLAYBACK_MS = 15_000;

export interface MpegTsRecoveryScheduled {
    readonly attempt: number;
    readonly delayMs: number;
    readonly reason: string;
}

export function createMpegTsConfig(isLive: boolean): mpegts.Config {
    if (!isLive) {
        return {
            lazyLoad: true,
            reuseRedirectedURL: true,
            accurateSeek: true,
        };
    }

    return {
        isLive: true,
        enableStashBuffer: true,
        lazyLoad: false,
        reuseRedirectedURL: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 120,
        autoCleanupMinBackwardDuration: 30,
        fixAudioTimestampGap: true,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 4,
        liveBufferLatencyMinRemain: 1,
    };
}

export function isRecoverableMpegTsLiveFailure(
    type: string,
    details: string,
    info: unknown,
): boolean {
    const text = `${type} ${details} ${stringifyInfo(info)}`.toLowerCase();
    if (
        text.includes('httpstatuscodeinvalid') ||
        text.includes('networkstatuscodeinvalid') ||
        /\b(?:401|403|404)\b/.test(text)
    ) {
        return false;
    }

    return [
        'earlyeof',
        'early eof',
        'networkexception',
        'networktimeout',
        'connection reset',
        'connection closed',
        'socket closed',
        'failed to fetch',
    ].some((marker) => text.includes(marker));
}

export class MpegTsLiveRecovery {
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    private stableTimer: ReturnType<typeof setTimeout> | undefined;
    private destroyed = false;

    constructor(
        private readonly config: {
            readonly isLive: () => boolean;
            readonly restart: () => void;
            readonly onScheduled?: (event: MpegTsRecoveryScheduled) => void;
        },
    ) {}

    request(reason: string): boolean {
        if (
            this.destroyed ||
            !this.config.isLive() ||
            this.reconnectTimer !== undefined
        ) {
            return false;
        }

        this.clearStableTimer();
        this.attempt += 1;
        const delayMs =
            RETRY_DELAYS_MS[
                Math.min(this.attempt - 1, RETRY_DELAYS_MS.length - 1)
            ];
        this.config.onScheduled?.({
            attempt: this.attempt,
            delayMs,
            reason,
        });
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            if (!this.destroyed && this.config.isLive()) {
                this.config.restart();
            }
        }, delayMs);
        return true;
    }

    markPlaying(): void {
        if (this.destroyed || !this.config.isLive()) {
            return;
        }
        this.clearStableTimer();
        this.stableTimer = setTimeout(() => {
            this.stableTimer = undefined;
            this.attempt = 0;
        }, STABLE_PLAYBACK_MS);
    }

    reset(): void {
        if (this.reconnectTimer !== undefined) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.clearStableTimer();
        this.attempt = 0;
    }

    destroy(): void {
        this.destroyed = true;
        this.reset();
    }

    private clearStableTimer(): void {
        if (this.stableTimer !== undefined) {
            clearTimeout(this.stableTimer);
            this.stableTimer = undefined;
        }
    }
}

function stringifyInfo(info: unknown): string {
    if (typeof info === 'string') {
        return info;
    }
    try {
        return JSON.stringify(info) ?? '';
    } catch {
        return String(info ?? '');
    }
}
