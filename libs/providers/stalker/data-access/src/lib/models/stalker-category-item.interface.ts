export interface StalkerCategoryItem {
    category_id: string;
    category_name: string;
    /** Optional item total reported by portals that include it in genres. */
    count?: number;
    /**
     * Ministra "censored" genre flag (adult categories). Portals typically
     * exclude these channels from `get_all_channels`, so censored categories
     * are served via the legacy paged flow and get no count badge.
     */
    censored?: boolean;
    [key: string]: unknown;
}
