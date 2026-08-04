export interface XtreamMetadataIndexStatus {
    total: number;
    indexed: number;
    failed: number;
}

export type XtreamMetadataIndexState =
    | 'idle'
    | 'queued'
    | 'running'
    | 'stopping'
    | 'complete'
    | 'error';

export interface XtreamMetadataIndexView extends XtreamMetadataIndexStatus {
    state: XtreamMetadataIndexState;
    error?: string;
}
