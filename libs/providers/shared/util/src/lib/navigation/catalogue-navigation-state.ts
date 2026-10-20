import type { PortalCatalogSortMode } from '../portal-catalog-facade';

export interface CatalogueRefinements {
    limit: number;
    sortMode: PortalCatalogSortMode | null;
    minRating: number | null;
    genreFilter: string | null;
    yearFilter: number | null;
}
export interface CatalogueListState extends CatalogueRefinements { scrollTop: number }
export interface StalkerListState {
    scrollTop: number;
    visibleLimit: number;
    viewMode: 'grid' | 'list';
    sortMode: 'server' | 'name-asc' | 'name-desc';
}

/** Session navigation memory only; it never reads or changes playback state. */
export class CatalogueNavigationMemory<T extends { scrollTop: number } = CatalogueListState> {
    private readonly lists = new Map<string, T>();
    constructor(private readonly capacity = 32) {
        if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Catalogue navigation capacity must be positive');
    }
    save(key: string, state: T): void {
        this.lists.delete(key);
        this.lists.set(key, { ...state, scrollTop: Math.max(0, Number.isFinite(state.scrollTop) ? state.scrollTop : 0) });
        while (this.lists.size > this.capacity) {
            const oldest = this.lists.keys().next().value;
            if (oldest === undefined) break;
            this.lists.delete(oldest);
        }
    }
    read(key: string): T | null {
        const state = this.lists.get(key);
        if (!state) return null;
        this.lists.delete(key);
        this.lists.set(key, state);
        return { ...state };
    }
}

const SORT_MODES = new Set<PortalCatalogSortMode>(['date-desc', 'date-asc', 'name-asc', 'name-desc', 'year-desc', 'year-asc', 'rating-desc', 'rating-asc']);

export function readCatalogueRefinements(params: { get(key: string): string | null; has(key: string): boolean }, fallback: CatalogueRefinements): CatalogueRefinements {
    const number = (key: string, valid: (value: number) => boolean, otherwise: number | null): number | null => {
        if (!params.has(key)) return otherwise;
        const raw = params.get(key);
        const value = raw?.trim() ? Number(raw) : NaN;
        return Number.isFinite(value) && valid(value) ? value : null;
    };
    const sort = params.get('sort') as PortalCatalogSortMode | null;
    return {
        limit: number('limit', value => [10, 25, 50, 100].includes(value), fallback.limit) ?? fallback.limit,
        sortMode: sort && SORT_MODES.has(sort) ? sort : fallback.sortMode,
        minRating: number('rating', value => value >= 0 && value <= 10, fallback.minRating),
        genreFilter: params.has('genre') ? params.get('genre')?.trim() || null : fallback.genreFilter,
        yearFilter: number('year', value => Number.isInteger(value) && value >= 1800 && value <= 3000, fallback.yearFilter),
    };
}

/** Accept only a list in the current source/kind, never an external/detail URL. */
export function resolveCatalogueOrigin(state: unknown, playlistId: string, kind: 'vod' | 'series', provider: 'xtream' | 'stalker' = 'xtream'): string | null {
    if (!state || typeof state !== 'object') return null;
    const origin = (state as Record<string, unknown>)['catalogueOrigin'];
    if (typeof origin !== 'string') return null;
    const path = origin.split(/[?#]/, 1)[0];
    const base = `/workspace/${provider === 'stalker' ? 'stalker' : 'xtreams'}/${encodeURIComponent(playlistId)}/${kind}`;
    if (path === base) return origin;
    if (path.startsWith(`${base}/`)) {
        const category = path.slice(base.length + 1);
        if (provider === 'xtream' && /^\d+$/.test(category)) return origin;
        if (provider === 'stalker' && /^[^/\\?#]+$/.test(category)) {
            try {
                const decoded = decodeURIComponent(category);
                if (decoded !== '.' && decoded !== '..' && !/[\\/]/.test(decoded)) return origin;
            } catch { return null; }
        }
    }
    return null;
}
