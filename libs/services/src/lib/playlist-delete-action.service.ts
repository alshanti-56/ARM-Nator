import {SOURCE_PLAYBACK_FACADE} from './source-playback/source-playback-facade.token';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlaylistMeta } from '@arm-nator/shared/interfaces';
import {
    DatabaseService,
    type DbOperationEvent,
} from './database-electron.service';
import { PlaylistsService } from './playlists.service';
import { RuntimeCapabilitiesService } from './runtime-capabilities.service';

export interface PlaylistDeleteActionOptions {
    /**
     * Receives Electron DB progress events only for Xtream-style playlists that
     * have a server URL. Non-Xtream Electron deletes do not emit
     * playlist delete progress events.
     */
    readonly onEvent?: (event: DbOperationEvent) => void;
}

@Injectable({ providedIn: 'root' })
export class PlaylistDeleteActionService {
    private readonly sourceChecks=inject(SOURCE_PLAYBACK_FACADE,{optional:true});
    private readonly databaseService = inject(DatabaseService);
    private readonly playlistsService = inject(PlaylistsService);
    private readonly runtime = inject(RuntimeCapabilitiesService);

    async deletePlaylist(
        playlist: PlaylistMeta,
        options: PlaylistDeleteActionOptions = {}
    ): Promise<boolean> {
        const release=await this.sourceChecks?.beginSourceOperation?.(playlist._id);
        try {
        const supportsElectronDelete = playlist.serverUrl
            ? this.runtime.supportsXtreamSqliteDataSource
            : this.runtime.supportsSqlite;

        if (supportsElectronDelete) {
            return await this.deletePlaylistInElectron(playlist, options);
        }

        const result = await firstValueFrom(
            this.playlistsService.deletePlaylist(playlist._id)
        );
        return result.success;
        } finally {release?.();}
    }

    private deletePlaylistInElectron(
        playlist: PlaylistMeta,
        options: PlaylistDeleteActionOptions
    ): Promise<boolean> {
        const operationId = playlist.serverUrl
            ? this.databaseService.createOperationId('playlist-delete')
            : undefined;

        return this.databaseService.deletePlaylist(
            playlist._id,
            operationId
                ? {
                      operationId,
                      onEvent: options.onEvent,
                  }
                : undefined
        );
    }
}
