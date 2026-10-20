export type XtreamCatalogueKind = 'live' | 'movie' | 'series';

/** Complete provider response, staged before changing the active catalogue. */
export type XtreamCatalogueSnapshot = Record<XtreamCatalogueKind, {
    categories: Record<string, unknown>[];
    streams: Record<string, unknown>[];
}>;

export interface XtreamCatalogueRefreshResult {
    success: true;
    count: number;
    inserted: number;
    updated: number;
    removed: number;
}

export interface XtreamCatalogueAccountIdentity {
    serverUrl: string;
    username: string;
    password: string;
}

export function requireXtreamCatalogueArray<T>(value: unknown): T[] {
    if (!Array.isArray(value)) throw new Error('Xtream catalogue requires an array response');
    return value;
}
