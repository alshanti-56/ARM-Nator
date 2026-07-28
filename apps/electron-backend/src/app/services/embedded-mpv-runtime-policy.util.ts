/**
 * Embedded MPV is a regular beta feature. Runtime probing still decides
 * whether the current platform and native addon can actually provide it.
 */
export function isEmbeddedMpvFeatureEnabled(): boolean {
    return true;
}
