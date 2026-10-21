import { inject, Injectable } from '@angular/core';
import { DatabaseService, SOURCE_PLAYBACK_FACADE, type DbOperationOptions } from '@arm-nator/services';
import { XtreamApiService } from '@arm-nator/providers/xtream/data-access';
import type { PlaylistMeta, XtreamCatalogueAccountIdentity, XtreamCatalogueSnapshot, XtreamCatalogueRefreshResult } from '@arm-nator/shared/interfaces';
import { CatalogueRefreshCoordinator } from './coalesced-catalogue-refresh';

@Injectable({ providedIn: 'root' })
export class XtreamCatalogueRefreshService {
    private readonly sourceChecks=inject(SOURCE_PLAYBACK_FACADE,{optional:true});
    private readonly db = inject(DatabaseService);
    private readonly api = inject(XtreamApiService);
    private readonly callbacks = new Map<string, DbOperationOptions | undefined>();
    private readonly coordinator = new CatalogueRefreshCoordinator<XtreamCatalogueSnapshot, XtreamCatalogueRefreshResult, XtreamCatalogueAccountIdentity>({
        cancel: operationId => this.api.cancelSession(operationId),
        fetch: async (_playlistId, operationId, account) => {
            const snapshot = {} as XtreamCatalogueSnapshot;
            for (const kind of ['live', 'movie', 'series'] as const) {
                const request = { sessionId: operationId, requireArray: true };
                const [categories, streams] = await Promise.all([
                    this.api.getCategories(account, kind === 'movie' ? 'vod' : kind, request),
                    this.api.getStreams(account, kind, request),
                ]);
                snapshot[kind] = { categories: categories as unknown as Record<string, unknown>[], streams: streams as unknown as Record<string, unknown>[] };
            }
            return snapshot;
        },
        commit: (playlistId, snapshot, operationId, account) => this.db.replaceXtreamCatalogue(playlistId, snapshot, account, { ...this.callbacks.get(operationId), operationId }),
    });

    async refresh(item: PlaylistMeta, options?: DbOperationOptions): Promise<XtreamCatalogueRefreshResult> {
        const release=await this.sourceChecks?.beginSourceOperation?.(item._id);
        try {
        const playlist = await this.db.getPlaylistById(item._id);
        if (!playlist?.serverUrl || !playlist.username || !playlist.password) throw new Error('Xtream account is unavailable');
        const account = { serverUrl: playlist.serverUrl, username: playlist.username, password: playlist.password };
        const operationId = options?.operationId ?? this.db.createOperationId('catalogue-refresh');
        this.callbacks.set(operationId, options);
        try {
            return await this.coordinator.run(item._id, JSON.stringify(account), operationId, account);
        } finally {
            this.callbacks.delete(operationId);
        }
        } finally { release?.(); }
    }
}
