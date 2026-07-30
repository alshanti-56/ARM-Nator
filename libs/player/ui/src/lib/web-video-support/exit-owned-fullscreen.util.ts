/** Exits document fullscreen only when the given player surface owns it. */
export function exitOwnedFullscreen(
    surface: HTMLElement | undefined,
    reportError: (error: unknown) => void
): void {
    if (
        document.fullscreenElement !== surface ||
        typeof document.exitFullscreen !== 'function'
    ) {
        return;
    }

    try {
        void Promise.resolve(document.exitFullscreen()).catch(reportError);
    } catch (error: unknown) {
        reportError(error);
    }
}
