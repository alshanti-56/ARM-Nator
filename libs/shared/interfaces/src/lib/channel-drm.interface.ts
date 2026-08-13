/**
 * DRM configuration extracted from `#KODIPROP:inputstream.adaptive.*` lines of
 * a playlist entry. ClearKey, Widevine, and PlayReady can be passed to
 * the browser DRM engine when the provider supplies a usable license server.
 * Other license types are preserved so playback can surface a meaningful DRM
 * diagnostic instead of failing silently.
 */
export interface ChannelDrmClearKeys {
    /** Key id (32 lowercase hex chars) mapped to its key (32 lowercase hex chars). */
    [kidHex: string]: string;
}

export interface ChannelDrm {
    /** Normalized EME key-system name, e.g. `org.w3.clearkey` or `com.widevine.alpha`. */
    licenseType: string;
    /** True when enough information exists to configure the browser DRM engine. */
    supported: boolean;
    clearKeys?: ChannelDrmClearKeys;
    /** Provider license endpoint for Widevine/PlayReady-style DRM. */
    licenseServerUrl?: string;
    /** Additional headers required by the provider license endpoint. */
    licenseRequestHeaders?: Record<string, string>;
}
