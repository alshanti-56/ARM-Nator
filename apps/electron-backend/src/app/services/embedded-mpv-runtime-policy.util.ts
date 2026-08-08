/**
 * Embedded MPV is a regular feature. Runtime probing still decides
 * whether the current platform and native addon can actually provide it.
 */
export function isEmbeddedMpvFeatureEnabled(): boolean {
    return true;
}
