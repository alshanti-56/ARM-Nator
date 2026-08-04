import { Injectable, inject, signal } from '@angular/core';
import { DatabaseService } from '@arm-nator/services';
import {
    type CatalogMetadataRecord,
    type PlaylistMeta,
    type XtreamMetadataIndexStatus,
    type XtreamMetadataIndexView,
} from '@arm-nator/shared/interfaces';

import {
    backfillXtreamCatalogMetadata,
    type XtreamCatalogMetadataProgress,
} from '../stores/xtream-catalog-metadata-backfill';
import { XtreamApiService } from './xtream-api.service';

const EMPTY_STATUS: XtreamMetadataIndexView = {
    total: 0,
    indexed: 0,
    failed: 0,
    state: 'idle',
};
const PERSISTED_STOPPED_SOURCES_KEY = 'xtream-metadata-index-stopped-v1';

@Injectable({ providedIn: 'root' })
export class XtreamMetadataIndexService {
    private readonly databaseService = inject(DatabaseService);
    private readonly xtreamApiService = inject(XtreamApiService);
    private readonly persistedStopsReady = this.loadPersistedStops();
    private readonly statusMap = signal<Record<string, XtreamMetadataIndexView>>(
        {}
    );
    private readonly activeSources = new Set<string>();
    private readonly stopRequested = new Set<string>();
    private readonly manuallyStoppedSources = new Set<string>();
    private readonly sessionIds = new Map<string, string>();
    private activePlaylistId: string | null = null;
    private readonly queuedPlaylists = new Map<string, PlaylistMeta>();
    private readonly statusRequests = new Map<
        string,
        Promise<XtreamMetadataIndexView>
    >();

    getStatus(playlistId: string): XtreamMetadataIndexView {
        return this.statusMap()[playlistId] ?? EMPTY_STATUS;
    }

    async refreshStatus(playlistId: string): Promise<XtreamMetadataIndexView> {
        if (
            this.activeSources.has(playlistId) ||
            this.queuedPlaylists.has(playlistId)
        ) {
            return this.getStatus(playlistId);
        }

        const existingRequest = this.statusRequests.get(playlistId);
        if (existingRequest) return existingRequest;

        const request = this.databaseService
            .getXtreamMetadataIndexStatus(playlistId)
            .then((status) => {
                const view = this.toView(status);
                this.setStatus(playlistId, view);
                return view;
            })
            .catch((error: unknown) => {
                const view: XtreamMetadataIndexView = {
                    ...EMPTY_STATUS,
                    state: 'error',
                    error: error instanceof Error ? error.message : String(error),
                };
                this.setStatus(playlistId, view);
                return view;
            })
            .finally(() => this.statusRequests.delete(playlistId));

        this.statusRequests.set(playlistId, request);
        return request;
    }

    async refreshStatuses(playlistIds: readonly string[]): Promise<void> {
        await Promise.all(playlistIds.map((playlistId) => this.refreshStatus(playlistId)));
    }

    async start(playlist: PlaylistMeta): Promise<void> {
        await this.persistedStopsReady;
        const playlistId = playlist._id;
        if (
            !playlist.serverUrl ||
            !playlist.username ||
            !playlist.password ||
            this.activeSources.has(playlistId)
        ) {
            return;
        }

        this.manuallyStoppedSources.delete(playlistId);
        this.persistStoppedSources();
        this.stopRequested.delete(playlistId);

        if (
            this.activePlaylistId ||
            (this.activeSources.size > 0 && !this.activeSources.has(playlistId))
        ) {
            this.queuedPlaylists.set(playlistId, playlist);
            this.setStatus(playlistId, {
                ...this.getStatus(playlistId),
                state: 'queued',
                error: undefined,
            });
            return;
        }

        this.activePlaylistId = playlistId;
        this.activeSources.add(playlistId);
        const sessionId = crypto.randomUUID();
        this.sessionIds.set(playlistId, sessionId);
        this.setStatus(playlistId, {
            ...this.getStatus(playlistId),
            state: 'running',
            error: undefined,
        });

        try {
            const [movies, series] = await Promise.all([
                this.databaseService.getXtreamContent(playlistId, 'movie'),
                this.databaseService.getXtreamContent(playlistId, 'series'),
            ]);
            const total = movies.length + series.length;
            const current = this.getStatus(playlistId);

            this.setStatus(playlistId, {
                ...current,
                total,
                state: total > 0 ? 'running' : 'complete',
            });

            if (total === 0) return;

            const credentials = {
                serverUrl: playlist.serverUrl,
                username: playlist.username,
                password: playlist.password,
            };

            await backfillXtreamCatalogMetadata({
                movies: movies as unknown as CatalogMetadataRecord[],
                series: series as unknown as CatalogMetadataRecord[],
                isActive: () => this.shouldContinue(playlistId),
                fetchDetails: async (job) => {
                    const item = job.item;
                    const id =
                        job.type === 'movie'
                            ? item['xtream_id'] ?? item['stream_id']
                            : item['xtream_id'] ?? item['series_id'];
                    if (typeof id !== 'string' && typeof id !== 'number') {
                        throw new Error(`Missing Xtream id for ${job.type}`);
                    }

                    return (job.type === 'movie'
                        ? await this.xtreamApiService.getVodInfo(credentials, id, {
                              sessionId,
                          })
                        : await this.xtreamApiService.getSeriesInfo(
                              credentials,
                              id,
                              { sessionId }
                          )) as unknown as CatalogMetadataRecord;
                },
                persist: async (job, metadata, enrichment) => {
                    const contentId = Number(job.item['id']);
                    if (!Number.isInteger(contentId) || contentId <= 0) {
                        throw new Error(`Missing database id for ${job.type}`);
                    }

                    await this.databaseService.updateXtreamContentMetadata(
                        contentId,
                        metadata,
                        enrichment
                    );
                },
                onProgress: (progress) =>
                    this.updateProgress(playlistId, progress),
            });
        } catch (error: unknown) {
            this.setStatus(playlistId, {
                ...this.getStatus(playlistId),
                state: 'error',
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.activeSources.delete(playlistId);
            this.stopRequested.delete(playlistId);
            this.sessionIds.delete(playlistId);
            if (this.activePlaylistId === playlistId) {
                this.activePlaylistId = null;
            }
            await this.refreshStatus(playlistId);

            this.startNextQueued();
        }
    }

    async beginExternal(
        playlistId: string,
        total = this.getStatus(playlistId).total,
        sessionId = crypto.randomUUID()
    ): Promise<boolean> {
        await this.persistedStopsReady;
        if (this.manuallyStoppedSources.has(playlistId)) return false;
        if (this.activeSources.size > 0) return false;

        this.stopRequested.delete(playlistId);
        this.activeSources.add(playlistId);
        this.sessionIds.set(playlistId, sessionId);
        this.setStatus(playlistId, {
            ...this.getStatus(playlistId),
            total,
            state: 'running',
            error: undefined,
        });
        return true;
    }

    updateExternalProgress(
        playlistId: string,
        progress: XtreamCatalogMetadataProgress
    ): void {
        if (this.activeSources.has(playlistId)) {
            this.updateProgress(playlistId, progress);
        }
    }

    finishExternal(playlistId: string): void {
        this.activeSources.delete(playlistId);
        this.stopRequested.delete(playlistId);
        this.sessionIds.delete(playlistId);
        void this.refreshStatus(playlistId);
        this.startNextQueued();
    }

    shouldContinue(playlistId: string): boolean {
        return (
            this.activeSources.has(playlistId) &&
            !this.stopRequested.has(playlistId)
        );
    }

    stop(playlistId: string): void {
        if (this.queuedPlaylists.delete(playlistId)) {
            this.manuallyStoppedSources.add(playlistId);
            this.persistStoppedSources();
            this.setStatus(playlistId, {
                ...this.getStatus(playlistId),
                state: 'idle',
            });
            return;
        }

        if (!this.activeSources.has(playlistId)) return;

        this.manuallyStoppedSources.add(playlistId);
        this.persistStoppedSources();
        this.stopRequested.add(playlistId);
        this.setStatus(playlistId, {
            ...this.getStatus(playlistId),
            state: 'stopping',
        });

        const sessionId = this.sessionIds.get(playlistId);
        if (sessionId) {
            void this.xtreamApiService.cancelSession(sessionId);
        }
    }

    private async loadPersistedStops(): Promise<void> {
        const raw = await this.databaseService.getAppState(
            PERSISTED_STOPPED_SOURCES_KEY
        );
        if (!raw) return;

        try {
            const playlistIds = JSON.parse(raw) as unknown;
            if (Array.isArray(playlistIds)) {
                playlistIds
                    .filter((playlistId): playlistId is string =>
                        typeof playlistId === 'string' && playlistId.length > 0
                    )
                    .forEach((playlistId) =>
                        this.manuallyStoppedSources.add(playlistId)
                    );
            }
        } catch {
            // Ignore an invalid persisted value and start normally.
        }
    }

    private persistStoppedSources(): void {
        void this.databaseService.setAppState(
            PERSISTED_STOPPED_SOURCES_KEY,
            JSON.stringify([...this.manuallyStoppedSources])
        );
    }

    private startNextQueued(): void {
        if (this.activePlaylistId || this.activeSources.size > 0) return;

        const next = this.queuedPlaylists.entries().next();
        if (!next.done) {
            this.queuedPlaylists.delete(next.value[0]);
            void this.start(next.value[1]);
        }
    }

    private updateProgress(
        playlistId: string,
        progress: XtreamCatalogMetadataProgress
    ): void {
        this.setStatus(playlistId, {
            total: progress.total,
            indexed: progress.completed,
            failed: progress.failed,
            state:
                progress.completed + progress.failed >= progress.total
                    ? 'complete'
                    : 'running',
        });
    }

    private toView(status: XtreamMetadataIndexStatus): XtreamMetadataIndexView {
        return {
            ...status,
            state:
                status.total > 0 && status.indexed >= status.total
                    ? 'complete'
                    : 'idle',
        };
    }

    private setStatus(
        playlistId: string,
        status: XtreamMetadataIndexView
    ): void {
        this.statusMap.update((current) => ({
            ...current,
            [playlistId]: status,
        }));
    }
}
