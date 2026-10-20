/** Retains only pending requests; settled results never stay in a query cache. */
export class InFlightCatalogueReads {
    private readonly pending = new Map<string, Promise<unknown>>();
    constructor(private readonly capacity = 64) {}
    run<T>(key: string, fetch: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(key);
        if (previous) return previous as Promise<T>;
        // Run the fetch now, while also representing synchronous failures as promises.
        let fetched: Promise<T>;
        try { fetched = fetch(); } catch (error) { fetched = Promise.reject(error); }
        const request = fetched.finally(() => {
            if (this.pending.get(key) === request) this.pending.delete(key);
        });
        this.pending.set(key, request);
        while (this.pending.size > Math.max(1, this.capacity)) {
            const oldest = this.pending.keys().next().value;
            if (oldest === undefined) break;
            this.pending.delete(oldest);
        }
        return request;
    }
    clear(): void { this.pending.clear(); }
}
