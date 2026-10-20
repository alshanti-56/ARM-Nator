const EDITOR_OR_MENU_SELECTOR = [
    'input', 'select', 'textarea',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '[role="combobox"]', '[role="listbox"]',
    '[role="menu"]', '[role^="menuitem"]', '[role="option"]',
].join(',');

const INTERACTIVE_SELECTOR = [
    EDITOR_OR_MENU_SELECTOR, 'a[href]', 'button', 'summary',
    '[role="button"]', '[role="checkbox"]', '[role="link"]',
    '[role="radio"]', '[role="slider"]', '[role="switch"]',
].join(',');

/** A focused editor/menu owns its keys, including across shadow DOM boundaries. */
export function isPlaybackShortcutBlocked(event: KeyboardEvent): boolean {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return true;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event.target];
    // Escape may close a player's own popover from its trigger button. Text
    // editors and focused menu widgets still retain Escape ownership.
    const selector = event.key === 'Escape' ? EDITOR_OR_MENU_SELECTOR : INTERACTIVE_SELECTOR;
    return nodes.some(node => {
        const element = node as HTMLElement | null;
        if (!element || typeof element.tagName !== 'string') return false;
        return element.isContentEditable === true || element.matches?.(selector) === true || Boolean(element.closest?.(selector));
    });
}
