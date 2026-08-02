export interface OpenSubtitlesSearchRequest {
    query: string;
    languages?: string;
}

export interface OpenSubtitlesDownloadRequest {
    result: OpenSubtitlesSearchResult;
}

export interface OpenSubtitlesSearchResult {
    id: string;
    fileId: number;
    fileName: string;
    language: string;
    downloads: number;
    fps: number | null;
    uploadDate: string;
    release: string;
    year: number | null;
    trusted: boolean;
    hearingImpaired: boolean;
}

export interface OpenSubtitlesDownloadedSubtitle {
    fileId: number;
    fileName: string;
    language: string;
    label: string;
    cacheHit: boolean;
    filePath: string;
    webVttDataUrl: string;
}
