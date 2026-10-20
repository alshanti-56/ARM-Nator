import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ControlsShortcuts } from './controls-shortcuts';

test('only the available controls owner handles a key; focused menus/editors retain command ownership', () => {
    const previous = globalThis.document;
    const listeners = new Set<(event: KeyboardEvent) => void>();
    globalThis.document = { addEventListener: (_: string, handler: (event: KeyboardEvent) => void) => listeners.add(handler), removeEventListener: (_: string, handler: (event: KeyboardEvent) => void) => listeners.delete(handler) } as unknown as Document;
    const calls: string[] = [];
    const unavailable = new ControlsShortcuts(), active = new ControlsShortcuts();
    const handlers = (available: boolean, name: string) => ({ isAvailable: () => available, canTogglePaused: () => true, canSeek: () => true, canAdjustVolume: () => true, canToggleFullscreen: () => true, onEscape: () => calls.push(`${name}:escape`), togglePaused: () => calls.push(`${name}:pause`), toggleFullscreen: () => calls.push(`${name}:fullscreen`), seekBy: () => calls.push(`${name}:seek`), adjustVolume: () => calls.push(`${name}:volume`), toggleMute: () => calls.push(`${name}:mute`) });
    unavailable.attach(handlers(false, 'background'));
    active.attach(handlers(true, 'active'));
    const dispatch = (key: string, fields = {}) => {
        const event = { key, target: null, defaultPrevented: false, preventDefault: () => { event.defaultPrevented = true; }, ...fields };
        for (const listener of listeners) listener(event as unknown as KeyboardEvent);
    };
    try {
        dispatch('Escape');
        dispatch('k');
        assert.deepEqual(calls, ['active:escape', 'active:pause']);
        calls.length = 0;
        for (const key of ['k', 'ArrowRight', 'Escape']) dispatch(key, { composedPath: () => [{ tagName: 'DIV', matches: (selector: string) => selector.includes('[role="menu"]') }] });
        dispatch('k', { ctrlKey: true });
        dispatch('m', { isComposing: true });
        dispatch('ArrowLeft', { target: { tagName: 'SPAN', closest: () => ({ tagName: 'INPUT' }) } });
        assert.deepEqual(calls, []);
    } finally { unavailable.detach(); active.detach(); globalThis.document = previous; }
});

test('Escape still closes a miniplayer popover when global playback shortcuts are unavailable', () => {
    const previous = globalThis.document;
    let listener!: (event: KeyboardEvent) => void;
    globalThis.document = { addEventListener: (_: string, handler: typeof listener) => { listener = handler; }, removeEventListener: () => { listener = () => undefined; } } as unknown as Document;
    let closed = 0;
    const shortcuts = new ControlsShortcuts();
    shortcuts.attach({ isAvailable: () => false, canHandleEscape: () => true, canTogglePaused: () => true, canSeek: () => true, canAdjustVolume: () => true, canToggleFullscreen: () => true, onEscape: () => { closed++; }, togglePaused: () => { throw new Error('Mini shortcut must yield'); }, toggleFullscreen: () => undefined, seekBy: () => undefined, adjustVolume: () => undefined, toggleMute: () => undefined });
    try {
        listener({ key: 'Escape', target: null } as KeyboardEvent);
        assert.equal(closed, 1);
        listener({ key: 'k', target: null } as KeyboardEvent);
    } finally { shortcuts.detach(); globalThis.document = previous; }
});
