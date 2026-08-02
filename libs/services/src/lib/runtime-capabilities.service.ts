import { Injectable } from '@angular/core';
import { ElectronBridgeApi } from '@arm-nator/shared/interfaces';

type RuntimeElectronBridge = Partial<ElectronBridgeApi>;

const playbackPositionStorageMethods = [
    'dbSavePlaybackPosition',
    'dbGetPlaybackPosition',
    'dbGetSeriesPlaybackPositions',
    'dbGetRecentPlaybackPositions',
    'dbGetAllPlaybackPositions',
    'dbClearAllPlaybackPositions',
    'dbClearPlaybackPosition',
];

@Injectable({ providedIn: 'root' })
export class RuntimeCapabilitiesService {
    get isElectron(): boolean {
        return !!this.electronBridge;
    }

    get platform(): string | undefined {
        const platform = this.electronBridge?.['platform'];
        return typeof platform === 'string' ? platform : undefined;
    }

    get isMacOS(): boolean {
        return this.platform === 'darwin';
    }

    get supportsSqlite(): boolean {
        return [
            'dbDeleteAllPlaylists',
            'dbDeletePlaylist',
            'dbGetAppPlaylist',
            'dbGetAppPlaylists',
            'dbGetAppState',
            'dbSetAppState',
            'dbUpsertAppPlaylist',
            'dbUpsertAppPlaylists',
        ].every((methodName) => this.hasElectronMethod(methodName));
    }

    get supportsXtreamSqliteDataSource(): boolean {
        return [
            'dbGetPlaylist',
            'dbCreatePlaylist',
            'dbUpdatePlaylist',
            'dbDeletePlaylist',
            'dbHasCategories',
            'dbGetCategories',
            'dbSaveCategories',
            'dbGetAllCategories',
            'dbUpdateCategoryVisibility',
            'dbHasContent',
            'dbGetContent',
            'dbSaveContent',
            'dbGetAppState',
            'dbSetAppState',
            'dbSearchContent',
            'dbGetFavorites',
            'dbAddFavorite',
            'dbRemoveFavorite',
            'dbIsFavorite',
            'dbGetRecentItems',
            'dbAddRecentItem',
            'dbRemoveRecentItem',
            'dbClearPlaylistRecentItems',
            'dbGetContentByXtreamId',
            ...playbackPositionStorageMethods,
            'dbDeleteXtreamContent',
            'dbRestoreXtreamUserData',
        ].every((methodName) => this.hasElectronMethod(methodName));
    }

    get supportsPlaybackPositionStorage(): boolean {
        return playbackPositionStorageMethods.every((methodName) =>
            this.hasElectronMethod(methodName)
        );
    }

    get supportsPlaybackPositionUpdates(): boolean {
        return this.hasElectronMethod('onPlaybackPositionUpdate');
    }

    get supportsAppStateStorage(): boolean {
        return ['dbGetAppState', 'dbSetAppState'].every((methodName) =>
            this.hasElectronMethod(methodName)
        );
    }

    get supportsPlaylistRefresh(): boolean {
        return [
            'refreshPlaylist',
            'cancelPlaylistRefresh',
            'onPlaylistRefreshEvent',
        ].every((methodName) => this.hasElectronMethod(methodName));
    }

    get supportsManagedExternalPlayers(): boolean {
        return ['openInMpv', 'openInVlc'].every((methodName) =>
            this.hasElectronMethod(methodName)
        );
    }

    get supportsExternalPlayerPathSettings(): boolean {
        return ['setMpvPlayerPath', 'setVlcPlayerPath'].every((methodName) =>
            this.hasElectronMethod(methodName)
        );
    }

    get supportsEmbeddedMpv(): boolean {
        return this.hasElectronMethod('prepareEmbeddedMpv');
    }

    get supportsDesktopFileSave(): boolean {
        return (
            this.hasElectronMethod('saveFileDialog') &&
            this.hasElectronMethod('writeFile')
        );
    }

    get supportsXtreamSectionNavigation(): boolean {
        return (
            this.supportsXtreamSqliteDataSource ||
            this.hasElectronMethod('xtreamRequest')
        );
    }

    private hasElectronMethod(methodName: string): boolean {
        const bridge = this.electronBridge as
            | Record<string, unknown>
            | undefined;
        return typeof bridge?.[methodName] === 'function';
    }

    private get electronBridge(): RuntimeElectronBridge | undefined {
        if (typeof window === 'undefined') {
            return undefined;
        }

        return window.electron;
    }
}
