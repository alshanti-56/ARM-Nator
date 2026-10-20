interface RefreshPorts<TSnapshot, TResult, TContext> {
    fetch(playlistId: string, operationId: string, context: TContext): Promise<TSnapshot>;
    commit(playlistId: string, snapshot: TSnapshot, operationId: string, context: TContext): Promise<TResult>;
    cancel(operationId: string): Promise<unknown>;
}

/** Only the current account's complete snapshot may reach the commit boundary. */
export class CatalogueRefreshCoordinator<TSnapshot, TResult, TContext = void> {
    private readonly active = new Map<string, { identity: string; operationId: string; promise: Promise<TResult> }>();
    constructor(private readonly ports: RefreshPorts<TSnapshot, TResult, TContext>) {}

    run(playlistId: string, identity: string, operationId: string, context: TContext): Promise<TResult> {
        const previous = this.active.get(playlistId);
        if (previous?.identity === identity) return previous.promise;
        const record = { identity, operationId, promise: null as unknown as Promise<TResult> };
        this.active.set(playlistId, record);
        record.promise = (async () => {
            if (previous) await this.ports.cancel(previous.operationId);
            const snapshot = await this.ports.fetch(playlistId, operationId, context);
            if (this.active.get(playlistId) !== record) {
                const error = new Error('Catalogue refresh superseded'); error.name = 'AbortError'; throw error;
            }
            return this.ports.commit(playlistId, snapshot, operationId, context);
        })().finally(() => {
            if (this.active.get(playlistId) === record) this.active.delete(playlistId);
        });
        return record.promise;
    }
}
