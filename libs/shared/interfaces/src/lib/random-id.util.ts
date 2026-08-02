/**
 * Random RFC 4122 v4 identifier used for playlist `_id` values, shared by the
 * renderer, the Electron backend and the web backend. Pure function — no
 * Angular/Node dependencies.
 *
 * The fallback covers embedded Chromium versions without
 * `crypto.randomUUID()` and builds the same v4 shape from
 * `crypto.getRandomValues()`.
 */

const HEX_BY_BYTE = Array.from({ length: 256 }, (_unused, byte) =>
    byte.toString(16).padStart(2, '0')
);

function randomUuidFromBytes(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Version 4 and the RFC 4122 variant bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => HEX_BY_BYTE[byte]);

    return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
    ].join('-');
}

/** Returns a lowercase RFC 4122 v4 UUID. */
export function createRandomId(): string {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    return randomUuidFromBytes();
}
