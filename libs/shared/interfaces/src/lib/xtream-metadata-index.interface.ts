export interface XtreamMetadataIndexStatus {
    total: number;
    indexed: number;
    failed: number;
}

export type XtreamMetadataIndexState =
    | 'idle'
    | 'queued'
    | 'running'
    | 'complete'
    | 'error';

export interface XtreamMetadataIndexView extends XtreamMetadataIndexStatus {
    state: XtreamMetadataIndexState;
    error?: string;
}
