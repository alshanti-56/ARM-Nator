import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EmbeddedMpvShortcuts } from './embedded-mpv-shortcuts';

test('native playback preserves modified commands, focused menus and events already handled elsewhere', () => {
    const previous = globalThis.document;
    let listener!: (event: KeyboardEvent) => void;
    globalThis.document = { addEventListener: (_: string, handler: typeof listener) => { listener = handler; }, removeEventListener: () => { listener = () => undefined; } } as unknown as Document;
    const shortcuts = new EmbeddedMpvShortcuts();
    const calls: string[] = [];
    shortcuts.attach({ isAvailable: () => true, onEscape: () => calls.push('escape'), togglePaused: () => calls.push('pause'), toggleFullscreen: () => calls.push('fullscreen'), seekBy: () => calls.push('seek'), adjustVolume: () => calls.push('volume'), toggleMute: () => calls.push('mute') });
    const dispatch = (key: string, fields = {}) => listener({ key, target: null, preventDefault: () => calls.push('prevented'), ...fields } as KeyboardEvent);
    try {
        dispatch('k', { metaKey: true });
        dispatch('ArrowRight', { defaultPrevented: true });
        dispatch('ArrowDown', { composedPath: () => [{ tagName: 'DIV', matches: (selector: string) => selector.includes('[role="menu"]') }] });
        assert.deepEqual(calls, []);
        dispatch('k');
        assert.deepEqual(calls, ['prevented', 'pause']);
    } finally { shortcuts.detach(); globalThis.document = previous; }
});

test('native keyboard respects unavailable controls and never consumes their keys', () => {
    const previous = globalThis.document;
    let listener!: (event: KeyboardEvent) => void;
    globalThis.document = { addEventListener: (_: string, handler: typeof listener) => { listener = handler; }, removeEventListener: () => { listener = () => undefined; } } as unknown as Document;
    const shortcuts = new EmbeddedMpvShortcuts();
    let commands = 0;
    const invoke = () => { commands++; };
    shortcuts.attach({ isAvailable: () => true, canSeek: () => false, canTogglePaused: () => false, canAdjustVolume: () => false, canToggleFullscreen: () => false, onEscape: invoke, togglePaused: invoke, toggleFullscreen: invoke, seekBy: invoke, adjustVolume: invoke, toggleMute: invoke });
    try {
        for (const key of ['k', 'f', 'm', 'ArrowLeft', 'ArrowUp']) listener({ key, target: null, preventDefault: invoke } as unknown as KeyboardEvent);
        assert.equal(commands, 0);
    } finally { shortcuts.detach(); globalThis.document = previous; }
});
