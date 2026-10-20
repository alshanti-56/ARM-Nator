/** Worker-local search pages. Catalogue writes clear both cached and pending ownership. */
export class SearchQueryCache<T> {
  private readonly entries = new Map<string, { value: T[]; expires: number }>();
  private readonly pending = new Map<string, Promise<T[]>>();
  private generation = 0;
  retainedItems = 0;

  constructor(
    private readonly maxEntries = 16,
    private readonly maxItems = 4_000,
    private readonly ttlMs = 120_000,
    private readonly now = Date.now,
  ) {}

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.retainedItems = 0;
  }

  async read(key: string, execute: () => Promise<T[]>): Promise<T[]> {
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      if (cached.expires > this.now()) {
        this.entries.set(key, cached);
        return cached.value;
      }
      this.retainedItems -= cached.value.length;
    }
    const existing = this.pending.get(key);
    if (existing) return existing;
    const generation = this.generation;
    const request = Promise.resolve()
      .then(execute)
      .then((value) => {
        if (generation !== this.generation || value.length > this.maxItems)
          return value;
        const replaced = this.entries.get(key);
        if (replaced) {
          this.retainedItems -= replaced.value.length;
          this.entries.delete(key);
        }
        while (
          this.entries.size >= this.maxEntries ||
          this.retainedItems + value.length > this.maxItems
        ) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) break;
          this.retainedItems -= this.entries.get(oldest)?.value.length ?? 0;
          this.entries.delete(oldest);
        }
        this.entries.set(key, { value, expires: this.now() + this.ttlMs });
        this.retainedItems += value.length;
        return value;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    if (this.pending.size < this.maxEntries) this.pending.set(key, request);
    return request;
  }
}

export function isSearchCatalogueMutation(operation: string): boolean {
  if (
    /^DB_(GET_|HAS_|IS_|SEARCH_|GLOBAL_SEARCH$|MATCH_TITLES$)/.test(operation)
  )
    return false;
  // These writes do not affect search fields, navigation targets or source labels.
  if (
    /^DB_(SAVE_PLAYBACK_POSITION|CLEAR_(ALL_)?PLAYBACK_POSITION(S)?|ADD_FAVORITE|REMOVE_FAVORITE|REORDER_GLOBAL_FAVORITES|ADD_RECENT_ITEM|REMOVE_RECENT_ITEM(S_BATCH)?|CLEAR_(PLAYLIST_RECENT_ITEMS|RECENTLY_VIEWED)|SET_APP_STATE|SET_TMDB_METADATA|CLEAR_TMDB_METADATA)$/.test(
      operation,
    )
  )
    return false;
  return true;
}
