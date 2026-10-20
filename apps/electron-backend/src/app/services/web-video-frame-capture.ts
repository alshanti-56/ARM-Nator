import type { BrowserWindow, IpcMainInvokeEvent, Rectangle } from 'electron';

/** Samples this app's visible renderer only; never opens a media connection. */
export function createWebVideoFrameCapture(
    getOwner: () => BrowserWindow | null,
    now: () => number = Date.now,
): (event: IpcMainInvokeEvent, bounds: Rectangle) => Promise<string | null> {
    const states = new WeakMap<BrowserWindow, {busy: boolean; last: number}>();
    return async (event, bounds) => {
        const owner = getOwner();
        if (!owner || owner.isDestroyed() || owner.webContents !== event.sender ||
            event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() ||
            !owner.isVisible() || owner.isMinimized() || !bounds) return null;
        const values = [bounds.x, bounds.y, bounds.width, bounds.height];
        if (!values.every(Number.isFinite) || bounds.x < 0 || bounds.y < 0 || bounds.width < 32 || bounds.height < 18) return null;
        const zoom = event.sender.getZoomFactor();
        const rect = {x: Math.floor(bounds.x * zoom), y: Math.floor(bounds.y * zoom),
            width: Math.floor(bounds.width * zoom), height: Math.floor(bounds.height * zoom)};
        const content = owner.getContentBounds();
        if (rect.x + rect.width > content.width || rect.y + rect.height > content.height ||
            rect.width * rect.height > 8388608) return null;
        const state = states.get(owner) ?? {busy: false, last: -Infinity};
        if (state.busy || now() - state.last < 5000) return null;
        state.busy = true; state.last = now(); states.set(owner, state);
        try {
            const image = await event.sender.capturePage(rect, {stayHidden: true});
            if (image.isEmpty() || owner.isDestroyed() || event.sender.isDestroyed()) return null;
            const jpeg = image.resize({width: 160, height: 90, quality: 'good'}).toJPEG(55);
            return jpeg.length && jpeg.length <= 65536 ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
        } catch {
            return null;
        } finally { state.busy = false; }
    };
}
