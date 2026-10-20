import type { ElectronBridgeXtreamContent } from '@arm-nator/shared/interfaces';

/** Decode once in the renderer rather than cloning every row through three contexts. */
export function decodeCatalogueContent(payload: string, kind: 'live' | 'movie' | 'series'): ElectronBridgeXtreamContent[] {
    const rows: unknown = JSON.parse(payload);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' ||
        !Number.isSafeInteger(row.id) || row.id < 1 ||
        !Number.isSafeInteger(row.category_id) || row.category_id < 1 ||
        !Number.isSafeInteger(row.xtream_id) || row.xtream_id < 0 ||
        typeof row.title !== 'string' || row.type !== kind)) {
        throw new Error('Malformed cached catalogue response');
    }
    return rows as ElectronBridgeXtreamContent[];
}
