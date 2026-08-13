import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { PlaylistsService } from '@arm-nator/services';
import { Playlist, ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { XtreamUrlService } from '@arm-nator/providers/xtream/data-access';
import { UnifiedCollectionItem } from '@arm-nator/providers/shared/util';

export interface ResolvedLiveCollectionDetail {
    readonly playback: ResolvedPortalPlayback;
}

@Injectable({ providedIn: 'root' })
export class StreamResolverService {
    private readonly playlistsService = inject(PlaylistsService);
    private readonly xtreamUrl = inject(XtreamUrlService);

    async resolvePlayback(
        item: UnifiedCollectionItem
    ): Promise<ResolvedPortalPlayback> {
        return (await this.resolveLiveDetail(item)).playback;
    }

    async resolveLiveDetail(
        item: UnifiedCollectionItem
    ): Promise<ResolvedLiveCollectionDetail> {
        const playlist = await firstValueFrom(
            this.playlistsService.getPlaylistById(item.playlistId)
        ) as Playlist | undefined;
        if (!playlist?.serverUrl || !playlist.username || !playlist.password) {
            throw new Error('Missing Xtream credentials');
        }
        if (item.xtreamId == null) {
            throw new Error('Missing Xtream stream ID');
        }

        return {
            playback: {
                streamUrl: this.xtreamUrl.constructLiveUrl(
                    {
                        serverUrl: playlist.serverUrl,
                        username: playlist.username,
                        password: playlist.password,
                    },
                    item.xtreamId
                ),
                title: item.name,
                thumbnail: item.logo ?? null,
                isLive: true,
            },
        };
    }
}
