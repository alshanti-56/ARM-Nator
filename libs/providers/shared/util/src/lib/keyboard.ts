/**
 * Returns true when the keyboard event originated inside an editable text
 * field, so global shortcuts should not fire.
 */
export function isTypingInInput(event: Event): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const nodes = path.length ? path : [event.target];
    const selector = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="listbox"],[role="menu"],[role^="menuitem"],[role="slider"]';
    return nodes.some(node => {
        const target = node as HTMLElement | null;
        if (!target || typeof target.tagName !== 'string') return false;
        return target.isContentEditable === true || target.matches?.(selector) === true || Boolean(target.closest?.(selector));
    });
}

export function historyShortcutDirection(event: KeyboardEvent): 'back' | 'forward' | null {
    if (event.defaultPrevented || event.isComposing || event.shiftKey || isTypingInInput(event)) return null;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
        if (event.key === '[') return 'back';
        if (event.key === ']') return 'forward';
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
        if (event.key === 'ArrowLeft') return 'back';
        if (event.key === 'ArrowRight') return 'forward';
    }
    return null;
}
