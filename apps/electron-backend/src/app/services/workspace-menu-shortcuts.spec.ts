import assert from 'node:assert/strict';
import test from 'node:test';
import { ownsWorkspaceMenuShortcut } from './workspace-menu-shortcuts';

test('workspace chords bypass native reload/menu roles while clipboard and key-up retain normal menu behavior', () => {
    for (const key of ['r', 'R', 'f', 'k', '[', ']']) assert.equal(ownsWorkspaceMenuShortcut({ type: 'keyDown', key, meta: true }), true);
    assert.equal(ownsWorkspaceMenuShortcut({ type: 'keyDown', key: 'ArrowLeft', alt: true }), true);
    assert.equal(ownsWorkspaceMenuShortcut({ type: 'keyDown', key: 'c', meta: true }), false);
    assert.equal(ownsWorkspaceMenuShortcut({ type: 'keyDown', key: 'r' }), false);
    assert.equal(ownsWorkspaceMenuShortcut({ type: 'keyUp', key: 'r', meta: true }), false);
});
