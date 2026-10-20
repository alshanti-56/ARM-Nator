/** Helpers for driving the native `<video>` element source list. */

export function clearNativeVideoSources(element: HTMLVideoElement): void {
    element.pause();
    element.removeAttribute('src');
    element.replaceChildren();
    element.load();
}

/**
 * Replaces the element's sources with a single `<source>` without loading it;
 * callers bind their controls source first, then call `element.load()`.
 */
export function setNativeVideoSource(
    element: HTMLVideoElement,
    url: string,
    type?: string
): void {
    element.preload = 'auto';
    clearNativeVideoSources(element);
    const source = document.createElement('source');
    source.src = url;
    if (type) {
        source.type = type;
    }
    element.appendChild(source);
}
