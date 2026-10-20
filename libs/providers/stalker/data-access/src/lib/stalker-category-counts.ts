interface CategoryCountInput {
    type: 'itv' | 'vod' | 'series';
    selectedCategory: string;
    totalItems: number;
    categories: ReadonlyArray<{ category_id: string; count?: unknown }>;
    items: ReadonlyArray<Record<string, unknown>>;
}

/** Count loaded items once, then supplement partial pages with known totals. */
export function buildStalkerCategoryCounts(input: CategoryCountInput): {
    counts: Map<string, number>;
    partialIds: Set<string>;
} {
    const counts = new Map<string, number>();
    const partialIds = new Set<string>();
    const completeLiveList = input.type === 'itv' && input.items.length >= input.totalItems;
    for (const item of input.items) {
        const raw = item['tv_genre_id'] ?? item['category_id'] ?? item['genre_id'] ??
            (input.selectedCategory !== '*' ? input.selectedCategory : undefined);
        if (raw == null || String(raw).trim() === '' || raw === '*') continue;
        const id = String(raw);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (!completeLiveList) partialIds.add(id);
    }
    for (const category of input.categories) {
        const raw = category.count;
        if (raw == null || String(raw).trim() === '') continue;
        const total = Number(raw);
        if (!Number.isSafeInteger(total) || total < 0 || category.category_id === '*') continue;
        const id = String(category.category_id);
        const loaded = counts.get(id) ?? 0;
        // A complete local list is authoritative for its represented genres.
        if (completeLiveList && counts.has(id)) continue;
        counts.set(id, Math.max(loaded, total));
        if (total >= loaded) partialIds.delete(id);
    }
    const totalId = input.selectedCategory;
    if (completeLiveList) {
        counts.set('*', input.items.length);
    } else if (input.totalItems > 0 || input.items.length > 0) {
        const loaded = input.items.length;
        const knownTotal = counts.has(totalId) && !partialIds.has(totalId);
        const total = Math.max(input.totalItems, loaded, counts.get(totalId) ?? 0);
        counts.set(totalId, total);
        // The store falls back to page length when the provider omits a total.
        if (knownTotal || input.totalItems > loaded) partialIds.delete(totalId);
        else partialIds.add(totalId);
    }
    return { counts, partialIds };
}
