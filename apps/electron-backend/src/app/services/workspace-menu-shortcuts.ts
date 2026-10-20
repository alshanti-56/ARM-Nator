export interface WorkspaceMenuShortcutInput {
    type: string;
    key: string;
    control?: boolean;
    meta?: boolean;
    alt?: boolean;
    shift?: boolean;
}

/** Let renderer focus/command handlers own these keys before native menu roles. */
export function ownsWorkspaceMenuShortcut(input: WorkspaceMenuShortcutInput): boolean {
    if (input.type !== 'keyDown') return false;
    const key = input.key.toLowerCase();
    if ((input.control || input.meta) && !input.alt) {
        return ['r', 'f', 'k', '[', ']'].includes(key);
    }
    return Boolean(input.alt && !input.control && !input.meta && !input.shift && ['arrowleft', 'arrowright'].includes(key));
}
