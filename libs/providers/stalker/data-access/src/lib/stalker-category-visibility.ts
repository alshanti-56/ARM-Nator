import type { PlaylistMeta } from '@arm-nator/shared/interfaces';

type CategoryVisibility = NonNullable<PlaylistMeta['hiddenStalkerCategoryIds']>;

/** Apply only the categories offered by this dialog; retain unavailable IDs. */
export function updateStalkerCategoryVisibility(
    current: CategoryVisibility | undefined,
    section: 'itv' | 'vod' | 'series',
    offeredIds: readonly string[],
    hiddenIds: readonly string[],
): CategoryVisibility {
    const offered = new Set(offeredIds.filter((id) => id !== '*'));
    const hidden = new Set((current?.[section] ?? []).filter((id) => id !== '*' && !offered.has(id)));
    for (const id of hiddenIds) {
        if (offered.has(id)) hidden.add(id);
    }
    return { ...current, [section]: [...hidden] };
}
