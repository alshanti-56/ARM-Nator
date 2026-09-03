/* eslint-disable max-lines */
import { inject, Injectable } from '@angular/core';
import { NgxIndexedDBService } from 'ngx-indexed-db';
import {
    combineLatest,
    defer,
    firstValueFrom,
    from,
    map,
    Observable,
    of,
    switchMap,
} from 'rxjs';
import {
    Channel,
    DbStores,
    Playlist,
    PlaylistMeta,
    PlaylistMetaUpdate,
    PlaylistRecentlyViewedItem,
    PlaylistUpdateState,
    StalkerPortalItem,
} from '@arm-nator/shared/interfaces';
import { PLAYLIST_DELETE_CLEANUP } from './playlist-delete-cleanup.token';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

type PlaylistRawItem = {
    raw?: string;
};

const SQLITE_PLAYLIST_MIGRATION_FLAG = 'playlist-storage-indexeddb-to-sqlite-v1';

type PlaylistStorageElectronApi = {
    dbDeleteAllPlaylists: () => Promise<unknown>;
    dbDeletePlaylist: (playlistId: string) => Promise<unknown>;
    dbGetAppPlaylist: (
        playlistId: string,
        operationId?: string
    ) => Promise<Playlist | null>;
    dbGetAppPlaylistMetas?: () => Promise<Playlist[]>;
    dbGetAppPlaylists: () => Promise<Playlist[]>;
    dbGetAppState: (key: string) => Promise<string | null>;
    dbSetAppState: (key: string, value: string) => Promise<unknown>;
    dbUpsertAppPlaylist: (
        playlist: Playlist,
        operationId?: string
    ) => Promise<unknown>;
    dbUpsertAppPlaylists: (playlists: Playlist[]) => Promise<unknown>;
};

type PlaylistStorageWindow = Window & {
    electron?: PlaylistStorageElectronApi;
};

type AddManyPlaylistsResult = Playlist[] | IDBValidKey[];

function portalFavoriteId(value: string | StalkerPortalItem): string {
    if (typeof value === 'string') {
        return value;
    }
    return String(
        value.id ?? value.movie_id ?? value.stream_id ?? value.series_id ?? ''
    );
}

@Injectable({
    providedIn: 'root',
})
export class PlaylistsService {
    private readonly dbService = inject(NgxIndexedDBService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly playlistDeleteCleanups =
        inject(PLAYLIST_DELETE_CLEANUP, { optional: true }) ?? [];
    private electronMigrationPromise: Promise<void> | null = null;
    private readonly playlistWriteQueues = new Map<string, Promise<unknown>>();

    private get electronApi(): PlaylistStorageElectronApi | null {
        if (typeof window === 'undefined') {
            return null;
        }

        return (window as PlaylistStorageWindow).electron ?? null;
    }

    private get isElectronStorageAvailable(): boolean {
        return this.runtime.supportsSqlite;
    }

    private runOnSqlite<T>(operation: () => Promise<T>) {
        return from(
            this.ensureElectronPlaylistMigrations().then(() => operation())
        );
    }

    private async ensureElectronPlaylistMigrations(): Promise<void> {
        if (!this.isElectronStorageAvailable) {
            return;
        }

        if (!this.electronMigrationPromise) {
            this.electronMigrationPromise = (async () => {
                await this.migrateIndexedDbPlaylistsToSqlite();
            })();
        }

        return this.electronMigrationPromise;
    }

    private toPlaylistMeta(playlist: Playlist): Playlist {
        const playlistMeta = { ...playlist };
        delete playlistMeta.playlist;
        delete playlistMeta.items;
        delete playlistMeta.header;
        return playlistMeta;
    }

    private toAutoUpdatePlaylistMeta(playlist: Playlist): Playlist {
        const playlistMeta = this.toPlaylistMeta(playlist);
        delete playlistMeta.favorites;
        return playlistMeta;
    }

    private async migrateIndexedDbPlaylistsToSqlite(): Promise<void> {
        try {
            const electron = this.electronApi;
            if (!electron) {
                return;
            }

            const alreadyMigrated = await electron.dbGetAppState(
                SQLITE_PLAYLIST_MIGRATION_FLAG
            );
            if (alreadyMigrated === '1') {
                return;
            }

            const indexedDbPlaylists = await firstValueFrom(
                this.dbService.getAll<Playlist>(DbStores.Playlists)
            );

            if (indexedDbPlaylists.length > 0) {
                await electron.dbUpsertAppPlaylists(
                    indexedDbPlaylists.filter(
                        (playlist) =>
                            Boolean(
                                playlist.serverUrl ||
                                    playlist.portalUrl ||
                                    playlist.macAddress
                            )
                    )
                );
                await firstValueFrom(this.dbService.clear(DbStores.Playlists));
            }

            await electron.dbSetAppState(SQLITE_PLAYLIST_MIGRATION_FLAG, '1');
        } catch (error) {
            console.error(
                'Failed to migrate IndexedDB playlists to SQLite:',
                error
            );
        }
    }

    private createSqliteFallbackPlaylist(
        playlist: Partial<Playlist> & { _id?: string; id?: string }
    ): Playlist {
        const id = String(playlist._id ?? playlist.id ?? '');
        return {
            ...playlist,
            _id: id,
            title: playlist.title ?? '',
            count: Number(playlist.count ?? 0),
            importDate: playlist.importDate ?? new Date().toISOString(),
            lastUsage: playlist.lastUsage ?? new Date().toISOString(),
            favorites: playlist.favorites ?? [],
            recentlyViewed: playlist.recentlyViewed ?? [],
            autoRefresh: Boolean(playlist.autoRefresh),
            playlist: playlist.playlist,
            url: playlist.url,
            filePath: playlist.filePath,
            userAgent: playlist.userAgent,
            referrer: playlist.referrer,
            origin: playlist.origin,
            updateDate: playlist.updateDate,
            updateState: playlist.updateState,
            position: playlist.position,
            serverUrl: playlist.serverUrl,
            username: playlist.username,
            password: playlist.password,
            macAddress: playlist.macAddress,
            portalUrl: playlist.portalUrl,
        } as Playlist;
    }

    private upsertSqlitePlaylist(playlist: Playlist, operationId?: string) {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            if (!electron) {
                return playlist;
            }

            if (operationId === undefined) {
                await electron.dbUpsertAppPlaylist(playlist);
            } else {
                await electron.dbUpsertAppPlaylist(playlist, operationId);
            }
            return playlist;
        });
    }

    private upsertManySqlitePlaylists(playlists: Playlist[]) {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            if (!electron) {
                return playlists;
            }

            await electron.dbUpsertAppPlaylists(playlists);
            return playlists;
        });
    }

    // Every playlist mutation reads the row, patches it in memory, and writes
    // the whole row back. Overlapping mutations on the same playlist would be
    // last-write-wins, so all of them are chained per playlist id here.
    private serializePlaylistWrite<T>(
        playlistId: string,
        operation: () => Promise<T>
    ): Observable<T> {
        return defer(() => {
            const previous =
                this.playlistWriteQueues.get(playlistId) ?? Promise.resolve();
            const next = previous.then(() => operation());
            const tail = next.then(
                () => undefined,
                () => undefined
            );
            this.playlistWriteQueues.set(playlistId, tail);
            void tail.then(() => {
                if (this.playlistWriteQueues.get(playlistId) === tail) {
                    this.playlistWriteQueues.delete(playlistId);
                }
            });
            return next;
        });
    }

    private persistPlaylistMutation(
        nextPlaylist: Playlist,
        operationId?: string
    ) {
        return firstValueFrom(
            this.upsertSqlitePlaylist(nextPlaylist, operationId)
        );
    }

    getAllPlaylists() {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            const playlists = electron
                ? await (electron.dbGetAppPlaylistMetas?.() ??
                      electron.dbGetAppPlaylists())
                : [];
            return (playlists as Playlist[]).map((playlist) =>
                this.toPlaylistMeta(playlist)
            );
        });
    }

    addPlaylist(playlist: Playlist) {
        return this.upsertSqlitePlaylist(playlist);
    }

    getPlaylist(id: string) {
        return this.getPlaylistById(id);
    }

    deletePlaylist(playlistId: string): Observable<{ success: boolean }> {
        const delete$: Observable<unknown> = this.runOnSqlite(async () => {
            const electron = this.electronApi;
            if (!electron) {
                return undefined;
            }

            await electron.dbDeletePlaylist(playlistId);
            return undefined;
        });

        return delete$.pipe(
            switchMap(() => from(this.runPlaylistDeleteCleanups(playlistId))),
            map(() => ({ success: true }))
        );
    }

    private async runPlaylistDeleteCleanups(playlistId: string): Promise<void> {
        if (this.playlistDeleteCleanups.length === 0) {
            return;
        }

        const failures = (
            await Promise.all(
                this.playlistDeleteCleanups.map(async (cleanup) => {
                    try {
                        await cleanup(playlistId);
                        return null;
                    } catch (error) {
                        return error;
                    }
                })
            )
        ).filter((error) => error !== null);

        for (const failure of failures) {
            console.warn(
                'Playlist cleanup failed after playlist deletion:',
                failure
            );
        }
    }

    /**
     * Canonical refresh merge shared by the single-playlist update flow and
     * the auto-refresh batch. The refreshed payload only contributes
     * refresh-owned data (parsed content and count); user-owned
     * state on the freshly read row — favorites, recently viewed, ordering,
     * hidden groups — must survive the refresh write.
     */
    private mergeRefreshedPlaylist(
        currentPlaylist: Playlist | undefined,
        updatedPlaylist: Playlist,
        playlistId: string
    ): Playlist {

        return {
            ...currentPlaylist,
            ...updatedPlaylist,
            _id: playlistId,
            count:
                updatedPlaylist.playlist?.items?.length ??
                currentPlaylist?.count ??
                updatedPlaylist.count,
            updateDate: Date.now(),
            updateState: PlaylistUpdateState.UPDATED,
            ...(currentPlaylist
                ? {
                      favorites: currentPlaylist.favorites,
                      recentlyViewed: currentPlaylist.recentlyViewed,
                      position: currentPlaylist.position,
                  }
                : {}),
            autoRefresh:
                currentPlaylist?.autoRefresh ?? updatedPlaylist.autoRefresh,
        };
    }

    updatePlaylist(
        playlistId: string,
        updatedPlaylist: Playlist,
        operationId?: string
    ) {
        return this.serializePlaylistWrite(playlistId, async () => {
            const currentPlaylist = await firstValueFrom(
                this.getPlaylistById(playlistId, operationId)
            );
            const mergedPlaylist = this.mergeRefreshedPlaylist(
                currentPlaylist,
                updatedPlaylist,
                playlistId
            );

            return this.persistPlaylistMutation(mergedPlaylist, operationId);
        });
    }

    getPlaylistById(id: string, operationId?: string) {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            let playlist: Playlist | null = null;
            if (electron) {
                playlist =
                    operationId === undefined
                        ? await electron.dbGetAppPlaylist(id)
                        : await electron.dbGetAppPlaylist(id, operationId);
            }
            return playlist
                ? this.createSqliteFallbackPlaylist(playlist as Playlist)
                : (undefined as unknown as Playlist);
        });
    }

    updatePlaylistMeta(updatedPlaylist: PlaylistMeta) {
        return this.serializePlaylistWrite(updatedPlaylist._id, async () => {
            const playlist = await firstValueFrom(
                this.getPlaylistById(updatedPlaylist._id)
            );
            const nextPlaylist = this.applyPlaylistMetaUpdate(
                playlist,
                updatedPlaylist
            );

            return this.persistPlaylistMutation(nextPlaylist);
        });
    }

    /** Applies a metadata patch while keeping session-only fields explicit. */
    private applyPlaylistMetaUpdate(
        playlist: Playlist,
        update: PlaylistMetaUpdate
    ): Playlist {
        const { stalkerSessionPatch, ...metadata } = update;
        const nextPlaylist: Playlist = { ...playlist, ...metadata };
        if (stalkerSessionPatch !== undefined) {
            if (stalkerSessionPatch === null) {
                nextPlaylist.stalkerToken = undefined;
                nextPlaylist.stalkerSessionIdentity = undefined;
                nextPlaylist.stalkerWatchdogTimeout = undefined;
                nextPlaylist.stalkerTimeslot = undefined;
                nextPlaylist.stalkerAccountInfo = undefined;
            } else {
                Object.assign(nextPlaylist, stalkerSessionPatch);
            }
        }
        return nextPlaylist;
    }

    transformPlaylistMeta(
        playlistId: string,
        transform: (current: Playlist) => Playlist | null
    ): Observable<Playlist | null> {
        return this.serializePlaylistWrite(playlistId, async () => {
            const current = await firstValueFrom(
                this.getPlaylistById(playlistId)
            );
            if (!current) {
                return null;
            }
            const next = transform(current);
            return next ? this.persistPlaylistMutation(next) : null;
        });
    }

    updatePlaylistMetaIfCurrent(
        update: PlaylistMetaUpdate,
        isCurrent: (current: Playlist) => boolean
    ): Observable<Playlist | null> {
        return this.transformPlaylistMeta(update._id, (current) =>
            isCurrent(current)
                ? this.applyPlaylistMetaUpdate(current, update)
                : null
        );
    }

    updateStalkerSession(
        playlistId: string,
        patch: NonNullable<PlaylistMetaUpdate['stalkerSessionPatch']>
    ): Observable<Playlist | null> {
        return this.transformPlaylistMeta(playlistId, (current) =>
            this.applyPlaylistMetaUpdate(current, {
                _id: playlistId,
                stalkerSessionPatch: patch,
            })
        );
    }

    updateFavorites(id: string, favorites: string[]) {
        return this.serializePlaylistWrite(id, async () => {
            const playlist = await firstValueFrom(this.getPlaylistById(id));

            return this.persistPlaylistMutation({
                ...playlist,
                favorites,
            });
        });
    }

    /**
     * Applies an atomic favorites update: the current favorites are read
     * inside the per-playlist write queue, so overlapping calls cannot work
     * from stale snapshots. Callers should pass a pure transform instead of
     * precomputing the next favorites array from an earlier read.
     */
    transformPlaylistFavorites(
        playlistId: string,
        transform: (
            currentFavorites: NonNullable<Playlist['favorites']>
        ) => NonNullable<Playlist['favorites']>
    ): Observable<Playlist> {
        if (!playlistId) {
            throw new Error('Playlist ID is required');
        }

        return this.serializePlaylistWrite(playlistId, async () => {
            const playlist = await firstValueFrom(
                this.getPlaylistById(playlistId)
            );
            if (!playlist) {
                throw new Error(`Playlist not found: ${playlistId}`);
            }

            const currentFavorites = Array.isArray(playlist.favorites)
                ? playlist.favorites
                : [];
            const nextPlaylist: Playlist = {
                ...playlist,
                favorites: transform(currentFavorites),
            };

            await this.persistPlaylistMutation(nextPlaylist);
            return nextPlaylist;
        });
    }

    updateManyPlaylists(playlists: Playlist[]) {
        if (playlists.length === 0) {
            return of([]);
        }

        // Auto-refresh payloads are snapshots taken before the refresh ran,
        // so each row goes through the same per-playlist queue and canonical
        // refresh merge as the single-playlist update flow: a batch write
        // cannot clobber a concurrent collection or metadata mutation.
        return combineLatest(
            playlists.map((playlist) =>
                this.serializePlaylistWrite(playlist._id, async () => {
                    const current = await firstValueFrom(
                        this.getPlaylistById(playlist._id)
                    );
                    // The merge takes autoRefresh from the current row first,
                    // so disabling auto-refresh while a refresh is in flight
                    // is not reverted by the completing batch write.
                    const nextPlaylist = this.mergeRefreshedPlaylist(
                        current,
                        playlist,
                        playlist._id
                    );

                    await this.persistPlaylistMutation(nextPlaylist);
                    return nextPlaylist;
                })
            )
        );
    }

    getFavoriteChannels(playlistId: string) {
        return this.getPlaylistById(playlistId).pipe(
            map((data) =>
                ((data.playlist?.items ?? []) as Channel[]).filter((channel) =>
                    data.favorites?.some(
                        (favorite) =>
                            typeof favorite === 'string' &&
                            favorite === channel.id
                    )
                )
            )
        );
    }

    getPortalFavorites(playlistId: string): Observable<StalkerPortalItem[]> {
        return this.getPlaylistById(playlistId).pipe(
            map((playlist) =>
                (playlist?.favorites ?? []).filter(
                    (favorite): favorite is StalkerPortalItem =>
                        typeof favorite === 'object' && favorite !== null
                )
            )
        );
    }

    addPortalFavorite(playlistId: string, favorite: StalkerPortalItem) {
        return this.transformPlaylistMeta(playlistId, (playlist) => {
            const favorites = [...(playlist.favorites ?? [])];
            const favoriteId = portalFavoriteId(favorite);
            const remaining = favorites.filter(
                (entry) => portalFavoriteId(entry) !== favoriteId
            );
            return {
                ...playlist,
                favorites: [favorite, ...remaining],
            };
        });
    }

    removeFromPortalFavorites(playlistId: string, favoriteId: string) {
        return this.transformPlaylistMeta(playlistId, (playlist) => ({
            ...playlist,
            favorites: (playlist.favorites ?? []).filter(
                (favorite) => portalFavoriteId(favorite) !== favoriteId
            ),
        }));
    }

    addPortalRecentlyViewed(
        playlistId: string,
        item: PlaylistRecentlyViewedItem
    ) {
        return this.addRecentlyViewed(playlistId, item);
    }

    removeFromPortalRecentlyViewed(
        playlistId: string,
        identity: string | number
    ) {
        return this.removeRecentlyViewed(playlistId, identity);
    }

    clearPortalRecentlyViewed(playlistId: string) {
        return this.clearRecentlyViewed(playlistId);
    }

    private addRecentlyViewed(playlistId: string, item: PlaylistRecentlyViewedItem) {
        return this.serializePlaylistWrite(playlistId, async () => {
            const playlist = await firstValueFrom(this.getPlaylistById(playlistId));
            const recentItems = Array.isArray(playlist.recentlyViewed)
                ? playlist.recentlyViewed
                : [];
            const existingIndex = recentItems.findIndex(
                (recentItem) => String(recentItem.id) === String(item.id)
            );
            const remainingItems = recentItems.filter((_, index) => index !== existingIndex);
            return this.persistPlaylistMutation({
                ...playlist,
                recentlyViewed: [
                    { ...item, added_at: new Date().toISOString() },
                    ...remainingItems,
                ],
            });
        });
    }

    private removeRecentlyViewed(playlistId: string, identity: string | number) {
        return this.serializePlaylistWrite(playlistId, async () => {
            const playlist = await firstValueFrom(this.getPlaylistById(playlistId));
            return this.persistPlaylistMutation({
                ...playlist,
                recentlyViewed: (playlist.recentlyViewed ?? []).filter(
                    (item) => String(item.id) !== String(identity)
                ),
            });
        });
    }

    private clearRecentlyViewed(playlistId: string) {
        return this.serializePlaylistWrite(playlistId, async () => {
            const playlist = await firstValueFrom(this.getPlaylistById(playlistId));
            return this.persistPlaylistMutation({ ...playlist, recentlyViewed: [] });
        });
    }

    updatePlaylistPositions(
        positionUpdates: {
            id: string;
            changes: { position: number };
        }[]
    ) {
        if (positionUpdates.length === 0) {
            return of([]);
        }

        return combineLatest(
            positionUpdates.map((item) =>
                this.serializePlaylistWrite(item.id, async () => {
                    const playlist = await firstValueFrom(
                        this.getPlaylistById(item.id)
                    );
                    if (!playlist) {
                        return null;
                    }

                    const nextPlaylist: Playlist = {
                        ...playlist,
                        position: item.changes.position,
                    };

                    await this.persistPlaylistMutation(nextPlaylist);
                    return nextPlaylist;
                })
            )
        );
    }

    addManyPlaylists(
        playlists: Playlist[]
    ): Observable<AddManyPlaylistsResult> {
        return this.upsertManySqlitePlaylists(playlists);
    }

    getPlaylistsForAutoUpdate() {
        return this.getAllData().pipe(
            map((playlists: Playlist[]) => {
                return playlists
                    .filter((item) => item.autoRefresh)
                    .map((playlist) => this.toAutoUpdatePlaylistMeta(playlist));
            })
        );
    }

    setFavorites(playlistId: string, favorites: string[]) {
        return this.serializePlaylistWrite(playlistId, async () => {
            const playlist = await firstValueFrom(
                this.getPlaylistById(playlistId)
            );

            return this.persistPlaylistMutation({
                ...playlist,
                favorites,
            });
        });
    }

    getRawPlaylistById(id: string) {
        return this.getPlaylistById(id).pipe(
            map((playlist) => {
                return (
                    `${playlist.playlist?.header?.raw ?? ''}` +
                    '\n' +
                    ((playlist.playlist?.items ?? []) as PlaylistRawItem[])
                        .map((item) => item.raw)
                        .join('\n')
                );
            })
        );
    }

    getAllData() {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            return electron
                ? ((await electron.dbGetAppPlaylists()) as Playlist[])
                : [];
        });
    }

    removeAll(): Observable<void> {
        return this.runOnSqlite(async () => {
            const electron = this.electronApi;
            if (electron) {
                await electron.dbDeleteAllPlaylists();
            }
            return undefined;
        }).pipe(map(() => undefined));
    }

}
