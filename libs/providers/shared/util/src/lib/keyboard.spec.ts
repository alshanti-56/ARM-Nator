import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { historyShortcutDirection, isTypingInInput } from './keyboard';
test('global navigation keys yield to composed-path editors and focused widget descendants', () => {
    assert.equal(isTypingInInput({ target: null, composedPath: () => [{ tagName: 'DIV', isContentEditable: true }] } as unknown as Event), true);
    assert.equal(isTypingInInput({ target: { tagName: 'SPAN', closest: () => ({ tagName: 'DIV' }) } } as unknown as Event), true);
    assert.equal(isTypingInInput({ target: { tagName: 'VIDEO', matches: () => false, closest: () => null } } as unknown as Event), false);
});

test('history shortcuts use standard chords and yield to focused menus and typing', () => {
    const event = (key: string, extras = {}) => ({ key, target: null, ...extras } as unknown as KeyboardEvent);
    assert.equal(historyShortcutDirection(event('[', { metaKey: true })), 'back');
    assert.equal(historyShortcutDirection(event(']', { ctrlKey: true })), 'forward');
    assert.equal(historyShortcutDirection(event('ArrowLeft', { altKey: true })), 'back');
    assert.equal(historyShortcutDirection(event('ArrowRight', { altKey: true })), 'forward');
    assert.equal(historyShortcutDirection(event('ArrowLeft')), null);
    assert.equal(historyShortcutDirection(event('[', { metaKey: true, target: { tagName: 'INPUT', matches: () => true } })), null);
    assert.equal(historyShortcutDirection(event(']', { metaKey: true, defaultPrevented: true })), null);
});
