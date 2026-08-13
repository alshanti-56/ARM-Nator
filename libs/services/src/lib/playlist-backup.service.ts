/* eslint-disable max-lines */
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DatabaseService } from './database-electron.service';
import { PlaybackPositionService } from './playback-position.service';
import { PlaylistsService } from './playlists.service';
import { XtreamPendingRestoreService } from './xtream-pending-restore.service';
import {
    createRandomId,
    normalizeXtreamPendingRestoreState,
    Playlist,
    PlaylistBackupEntry,
    PlaylistBackupManifestV1,
    PlaylistBackupSettings,
    PLAYLIST_BACKUP_KIND,
    PLAYLIST_BACKUP_VERSION,
    XtreamBackupCategoryType,
    XtreamBackupContentType,
    XtreamPendingRestoreState,
    XtreamPlaylistBackupEntry,
} from '@arm-nator/shared/interfaces';

export interface PlaylistBackupExportPayload {
    defaultFileName: string;
    json: string;
    manifest: PlaylistBackupManifestV1;
}

export interface PlaylistBackupImportSummary {
    imported: number;
    merged: number;
    skipped: number;
    failed: number;
    errors: string[];
}

export class PlaylistBackupError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlaylistBackupError';
    }
}

type XtreamContentType = XtreamBackupContentType;
type XtreamCategoryType = XtreamBackupCategoryType;

@Injectable({
    providedIn: 'root',
})
export class PlaylistBackupService {
    private readonly playlistsService = inject(PlaylistsService);
    private readonly databaseService = inject(DatabaseService);
    private readonly playbackPositionService = inject(PlaybackPositionService);
    private readonly pendingRestoreService = inject(
        XtreamPendingRestoreService
    );

    async exportBackup(): Promise<PlaylistBackupExportPayload> {
        const playlists = (await firstValueFrom(
            this.playlistsService.getAllData()
        )).filter((playlist) => this.isXtreamPlaylist(playlist));
        const exportedAt = new Date().toISOString();
        const manifest: PlaylistBackupManifestV1 = {
            kind: PLAYLIST_BACKUP_KIND,
            version: PLAYLIST_BACKUP_VERSION,
            exportedAt,
            includeSecrets: true,
            playlists: await Promise.all(
                playlists.map((playlist) => this.buildXtreamEntry(playlist))
            ),
        };

        return {
            defaultFileName: `arm-nator-playlist-backup-${exportedAt.slice(
                0,
                10
            )}.json`,
            json: JSON.stringify(manifest, null, 2),
            manifest,
        };
    }

    async importBackup(json: string): Promise<PlaylistBackupImportSummary> {
        const manifest = this.parseManifest(json);
        const existingPlaylists = (await firstValueFrom(
            this.playlistsService.getAllData()
        )).filter((playlist) => this.isXtreamPlaylist(playlist));
        const existingIds = new Set(
            existingPlaylists.map((playlist) => playlist._id)
        );
        const fingerprintMap = await this.buildExistingFingerprintMap(
            existingPlaylists
        );
        const seenBackupFingerprints = new Set<string>();
        const summary: PlaylistBackupImportSummary = {
            imported: 0,
            merged: 0,
            skipped: 0,
            failed: 0,
            errors: [],
        };

        for (const entry of manifest.playlists) {
            const entryLabel = entry.title || entry.exportedId;

            try {
                const fingerprint = this.getEntryFingerprint(entry);
                if (seenBackupFingerprints.has(fingerprint)) {
                    summary.skipped += 1;
                    summary.errors.push(
                        `${entryLabel}: duplicate backup entry skipped`
                    );
                    continue;
                }
                seenBackupFingerprints.add(fingerprint);

                const existingMatch = fingerprintMap.get(fingerprint);
                const targetId = this.resolveTargetPlaylistId(
                    entry,
                    existingMatch?._id,
                    existingIds
                );
                await firstValueFrom(
                    this.playlistsService.addPlaylist(
                        this.buildImportedXtreamPlaylist(
                            entry,
                            targetId,
                            existingMatch ?? null
                        )
                    )
                );
                await this.restoreXtreamEntry(targetId, entry);

                if (existingMatch) {
                    summary.merged += 1;
                } else {
                    summary.imported += 1;
                    existingIds.add(targetId);
                }
            } catch (error) {
                summary.failed += 1;
                summary.errors.push(
                    `${entryLabel}: ${this.getErrorMessage(error)}`
                );
            }
        }

        return summary;
    }

    private async buildXtreamEntry(
        playlist: Playlist
    ): Promise<XtreamPlaylistBackupEntry> {
        if (!this.isXtreamPlaylist(playlist)) {
            throw new PlaylistBackupError(
                `Unsupported playlist source for "${playlist.title}".`
            );
        }

        const base = {
            portalType: 'xtream' as const,
            exportedId: playlist._id,
            title: playlist.title,
            autoRefresh: Boolean(playlist.autoRefresh),
            position: playlist.position,
            connection: {
                serverUrl: playlist.serverUrl,
                username: playlist.username,
                ...(playlist.password ? { password: playlist.password } : {}),
            },
        };

        if (!this.hasElectronApi()) {
            return {
                ...base,
                userState: {
                    hiddenCategories: [],
                    favorites: [],
                    recentlyViewed: [],
                    playbackPositions: [],
                },
            };
        }

        const [
            liveCategories,
            movieCategories,
            seriesCategories,
            favorites,
            recent,
            playbackPositions,
        ] = await Promise.all([
            this.databaseService.getAllXtreamCategories(playlist._id, 'live'),
            this.databaseService.getAllXtreamCategories(playlist._id, 'movies'),
            this.databaseService.getAllXtreamCategories(playlist._id, 'series'),
            this.databaseService.getFavorites(playlist._id),
            this.databaseService.getRecentItems(playlist._id),
            this.playbackPositionService.getAllPlaybackPositions(playlist._id),
        ]);

        return {
            ...base,
            userState: {
                hiddenCategories: [
                    ...this.mapHiddenCategories(liveCategories, 'live'),
                    ...this.mapHiddenCategories(movieCategories, 'movies'),
                    ...this.mapHiddenCategories(seriesCategories, 'series'),
                ],
                favorites: favorites.map((item) => ({
                    xtreamId: item.xtream_id,
                    contentType: item.type as XtreamContentType,
                    ...(item.added_at ? { addedAt: item.added_at } : {}),
                    ...(item.position !== undefined
                        ? { position: item.position }
                        : {}),
                })),
                recentlyViewed: recent.map((item) => ({
                    xtreamId: item.xtream_id,
                    contentType: item.type as XtreamContentType,
                    viewedAt: item.viewed_at ?? new Date().toISOString(),
                })),
                playbackPositions: playbackPositions.map((item) => ({
                    ...item,
                })),
            },
        };
    }

    private parseManifest(json: string): PlaylistBackupManifestV1 {
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (error) {
            throw new PlaylistBackupError(
                `Invalid backup JSON: ${this.getErrorMessage(error)}`
            );
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new PlaylistBackupError('Backup file must be a JSON object.');
        }

        const manifest = parsed as Partial<PlaylistBackupManifestV1>;
        if (manifest.kind !== PLAYLIST_BACKUP_KIND) {
            throw new PlaylistBackupError('Unsupported backup file format.');
        }
        if (manifest.version !== PLAYLIST_BACKUP_VERSION) {
            throw new PlaylistBackupError(
                `Unsupported backup version: ${manifest.version ?? 'unknown'}`
            );
        }
        if (!Array.isArray(manifest.playlists)) {
            throw new PlaylistBackupError(
                'Backup file must contain playlists.'
            );
        }

        for (const entry of manifest.playlists) {
            this.validateEntry(entry);
        }

        return manifest as PlaylistBackupManifestV1;
    }

    private validateEntry(entry: PlaylistBackupEntry): void {
        if (
            !entry ||
            typeof entry !== 'object' ||
            entry.portalType !== 'xtream' ||
            !entry.exportedId ||
            !entry.title
        ) {
            throw new PlaylistBackupError(
                'Backup contains an invalid or unsupported playlist entry.'
            );
        }
        if (!entry.connection?.serverUrl || !entry.connection?.username) {
            throw new PlaylistBackupError(
                `Xtream backup "${entry.title}" is missing connection metadata.`
            );
        }
        if (
            !Array.isArray(entry.userState?.hiddenCategories) ||
            !Array.isArray(entry.userState?.favorites) ||
            !Array.isArray(entry.userState?.recentlyViewed) ||
            !Array.isArray(entry.userState?.playbackPositions)
        ) {
            throw new PlaylistBackupError(
                `Xtream backup "${entry.title}" has incomplete user state.`
            );
        }
    }

    private async buildExistingFingerprintMap(
        playlists: Playlist[]
    ): Promise<Map<string, Playlist>> {
        const map = new Map<string, Playlist>();
        for (const playlist of playlists) {
            if (this.isXtreamPlaylist(playlist)) {
                map.set(this.getPlaylistFingerprint(playlist), playlist);
            }
        }
        return map;
    }

    private getPlaylistFingerprint(playlist: Playlist): string {
        if (!this.isXtreamPlaylist(playlist)) {
            throw new PlaylistBackupError(
                `Unable to fingerprint unsupported playlist "${playlist.title}".`
            );
        }
        return [
            'xtream',
            this.normalizeUrlIdentity(playlist.serverUrl),
            this.normalizeIdentityValue(playlist.username),
        ].join('|');
    }

    private getEntryFingerprint(entry: PlaylistBackupEntry): string {
        if (entry.portalType !== 'xtream') {
            throw new PlaylistBackupError('Unsupported backup playlist type.');
        }
        return [
            'xtream',
            this.normalizeUrlIdentity(entry.connection.serverUrl),
            this.normalizeIdentityValue(entry.connection.username),
        ].join('|');
    }

    private resolveTargetPlaylistId(
        entry: PlaylistBackupEntry,
        matchedId: string | undefined,
        existingIds: Set<string>
    ): string {
        if (matchedId) return matchedId;
        if (entry.exportedId && !existingIds.has(entry.exportedId)) {
            return entry.exportedId;
        }
        let nextId = createRandomId();
        while (existingIds.has(nextId)) nextId = createRandomId();
        return nextId;
    }

    private buildImportedXtreamPlaylist(
        entry: XtreamPlaylistBackupEntry,
        playlistId: string,
        existing: Playlist | null
    ): Playlist {
        const now = new Date().toISOString();
        return {
            ...existing,
            _id: playlistId,
            title: entry.title,
            filename: entry.title,
            count: existing?.count ?? 0,
            importDate: existing?.importDate ?? now,
            lastUsage: existing?.lastUsage ?? now,
            autoRefresh: entry.autoRefresh,
            position: entry.position,
            serverUrl: entry.connection.serverUrl,
            username: entry.connection.username,
            password: entry.connection.password,
            favorites: [],
            recentlyViewed: [],
        };
    }

    private async restoreXtreamEntry(
        playlistId: string,
        entry: XtreamPlaylistBackupEntry
    ): Promise<void> {
        const restoreState: XtreamPendingRestoreState =
            normalizeXtreamPendingRestoreState(entry.userState);
        this.pendingRestoreService.set(playlistId, restoreState);

        if (!this.hasElectronApi() || !(await this.hasCompletedOfflineCache(playlistId))) {
            return;
        }

        await this.applyXtreamRestoreState(playlistId, restoreState);
        this.pendingRestoreService.clear(playlistId);
    }

    private async hasCompletedOfflineCache(playlistId: string): Promise<boolean> {
        const checks = await Promise.all(
            [
                { categoryType: 'live' as const, contentType: 'live' as const },
                { categoryType: 'movies' as const, contentType: 'movie' as const },
                { categoryType: 'series' as const, contentType: 'series' as const },
            ].map(async ({ categoryType, contentType }) => {
                const [importStatus, hasCategories, hasContent] = await Promise.all([
                    this.databaseService.getXtreamImportStatus(playlistId, contentType),
                    this.databaseService.hasXtreamCategories(playlistId, categoryType),
                    this.databaseService.hasXtreamContent(playlistId, contentType),
                ]);
                return importStatus === 'completed' && hasCategories && hasContent;
            })
        );
        return checks.every(Boolean);
    }

    private async applyXtreamRestoreState(
        playlistId: string,
        state: XtreamPendingRestoreState
    ): Promise<void> {
        await this.restoreXtreamCategoryVisibility(playlistId, state);
        await this.databaseService.restoreXtreamUserData(
            playlistId,
            state.favorites,
            state.recentlyViewed
        );
        await this.playbackPositionService.clearAllPlaybackPositions(playlistId);
        for (const playbackPosition of state.playbackPositions) {
            await this.playbackPositionService.savePlaybackPosition(
                playlistId,
                playbackPosition
            );
        }
    }

    private async restoreXtreamCategoryVisibility(
        playlistId: string,
        state: XtreamPendingRestoreState
    ): Promise<void> {
        const categoriesByType = await Promise.all([
            this.databaseService.getAllXtreamCategories(playlistId, 'live'),
            this.databaseService.getAllXtreamCategories(playlistId, 'movies'),
            this.databaseService.getAllXtreamCategories(playlistId, 'series'),
        ]);
        for (const categories of categoriesByType) {
            if (categories.length === 0) continue;
            await this.databaseService.updateCategoryVisibility(
                categories.map((category) => category.id),
                false
            );
            const hiddenCategoryIds = categories
                .filter((category) =>
                    state.hiddenCategories.some(
                        (hidden) =>
                            hidden.categoryType === category.type &&
                            hidden.xtreamId === category.xtream_id
                    )
                )
                .map((category) => category.id);
            if (hiddenCategoryIds.length > 0) {
                await this.databaseService.updateCategoryVisibility(
                    hiddenCategoryIds,
                    true
                );
            }
        }
    }

    private mapHiddenCategories(
        categories: Array<{
            hidden: boolean;
            xtream_id: number;
            type: XtreamCategoryType;
        }>,
        categoryType: XtreamCategoryType
    ): XtreamPendingRestoreState['hiddenCategories'] {
        return categories
            .filter((category) => category.hidden)
            .map((category) => ({ categoryType, xtreamId: category.xtream_id }));
    }

    private isXtreamPlaylist(
        playlist: Playlist
    ): playlist is Playlist & { serverUrl: string; username: string } {
        return Boolean(playlist.serverUrl && playlist.username);
    }

    private normalizeUrlIdentity(value: string): string {
        const trimmed = value.trim();
        if (!trimmed) return '';
        try {
            const url = new URL(trimmed);
            const pathname =
                url.pathname === '/'
                    ? '/'
                    : url.pathname.replace(/\/+$/, '') || '/';
            return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}${url.hash}`;
        } catch {
            return trimmed.toLowerCase();
        }
    }

    private normalizeIdentityValue(value: string): string {
        return value.trim();
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }

    private hasElectronApi(): boolean {
        return !!(window as Window & { electron?: unknown }).electron;
    }
}
