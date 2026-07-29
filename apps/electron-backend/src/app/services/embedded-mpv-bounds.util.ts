import { EmbeddedMpvBounds } from '@arm-nator/shared/interfaces';

export interface NativeViewBoundsContext {
    /** Page zoom factor of the main window's webContents (1 = 100%). */
    zoomFactor: number;
}

/**
 * Converts renderer-measured bounds (CSS pixels from
 * getBoundingClientRect()) into the coordinate space the native-view
 * engine positions its NSView in points. CSS pixels match points at 100%
 * page zoom, so only the Electron page zoom factor is applied.
 *
 * Bounds arrive with unrounded CSS edges and are rounded exactly once here,
 * after scaling: edges first, then width/height derived from them. Rounding
 * any earlier (or per-field) lets fractional CSS layouts drift by a pixel
 * per scale factor and open 1px seams between the native video window and
 * the surrounding DOM UI.
 */
export function toNativeViewBounds(
    bounds: EmbeddedMpvBounds,
    context: NativeViewBoundsContext
): EmbeddedMpvBounds {
    const scale = sanitizeFactor(context.zoomFactor);
    if (scale === 1) {
        return bounds;
    }

    const left = Math.round(bounds.x * scale);
    const top = Math.round(bounds.y * scale);
    const right = Math.round((bounds.x + bounds.width) * scale);
    const bottom = Math.round((bounds.y + bounds.height) * scale);

    return {
        x: left,
        y: top,
        width: Math.max(1, right - left),
        height: Math.max(1, bottom - top),
    };
}

function sanitizeFactor(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 1;
}
