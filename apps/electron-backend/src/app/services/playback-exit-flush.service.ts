import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';

let quitting = false;
const pending = new Map<number, { id: string; promise: Promise<void>; complete(error?: string): void }>();
ipcMain.on('PLAYBACK_PROGRESS_FLUSHED', (event, id: unknown, error: unknown) => {
    const request = pending.get(event.sender.id);
    if (request && request.id === id) request.complete(typeof error === 'string' ? error : undefined);
});
export function authorizePlaybackQuit(): void { quitting = true; }
export function isPlaybackQuitAuthorized(): boolean { return quitting; }

export function requestRendererPlaybackFlush(contents: Electron.WebContents | undefined): Promise<void> {
    if (!contents || contents.isDestroyed()) return Promise.resolve();
    const existing = pending.get(contents.id);
    if (existing) return existing.promise;
    const id = randomUUID();
    let resolve!: () => void, reject!: (error: Error) => void;
    const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    const finish = (error?: string) => {
        if (pending.get(contents.id)?.id !== id) return;
        pending.delete(contents.id);
        clearTimeout(timer);
        contents.off('destroyed', onDestroyed);
        if (error) reject(new Error(error)); else resolve();
    };
    const onDestroyed = () => finish('Renderer closed before playback progress was saved');
    const timer = setTimeout(() => finish('Renderer did not acknowledge playback progress flush'), 1500);
    pending.set(contents.id, { id, promise, complete: finish });
    contents.once('destroyed', onDestroyed);
    try { contents.send('PLAYBACK_PROGRESS_FLUSH', id); }
    catch (error) { finish(error instanceof Error ? error.message : String(error)); }
    return promise;
}
