/**
 * Flattened EPG channel metadata returned to the renderer for lookup-based
 * enrichment of playlist channels.
 */
export interface EpgChannelMetadata {
    id: string;
    displayName: string;
    iconUrl: string | null;
}
