interface CloseEvent { preventDefault(): void; }

/** A bounded pre-exit flush; a broken renderer or disk cannot prevent resource cleanup. */
export class PlaybackExitCoordinator {
    private quitAllowed = false;
    private closeAllowed = false;
    private quitPending = false;
    private closePending = false;
    constructor(private readonly requestFlush: () => Promise<void>, private readonly options: { timeoutMs?: number; onError?: (error: unknown) => void } = {}) {}

    deferQuit(event: CloseEvent, resume: () => void): boolean {
        if (this.quitAllowed) return false;
        event.preventDefault();
        if (!this.quitPending) {
            this.quitPending = true;
            void this.flush().finally(() => { this.quitAllowed = true; resume(); });
        }
        return true;
    }

    deferWindowClose(event: CloseEvent, resume: () => void): boolean {
        if (this.closeAllowed || this.quitAllowed) return false;
        event.preventDefault();
        if (!this.closePending) {
            this.closePending = true;
            void this.flush().finally(() => { this.closeAllowed = true; resume(); });
        }
        return true;
    }

    private async flush(): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.resolve().then(this.requestFlush),
                new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('Playback progress flush timed out')), this.options.timeoutMs ?? 1500); }),
            ]);
        } catch (error) { this.options.onError?.(error); }
        finally { if (timer) clearTimeout(timer); }
    }
}
