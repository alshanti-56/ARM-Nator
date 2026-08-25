import { inject, Injectable, Provider } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { PlaylistInfoComponent } from '@arm-nator/providers/shared/playlist-ui';
import {
    PORTAL_NAVIGATION_ACTIONS,
    PortalNavigationActions,
} from '@arm-nator/providers/shared/util';
import { XtreamStore } from '@arm-nator/providers/xtream/data-access';
import { Playlist } from '@arm-nator/shared/interfaces';

@Injectable({ providedIn: 'root' })
export class AppPortalNavigationActionsService
    implements PortalNavigationActions
{
    private readonly dialog = inject(MatDialog);
    private readonly xtreamStore = inject(XtreamStore);

    openAccountInfo(): void {
        const playlist = this.xtreamStore.currentPlaylist();
        const data = {
            vodStreamsCount: this.xtreamStore.vodStreams().length,
            liveStreamsCount: this.xtreamStore.liveStreams().length,
            seriesCount: this.xtreamStore.serialStreams().length,
            playlist: playlist
                ? {
                      id: playlist.id,
                      name: playlist.name,
                      title: playlist.title,
                      serverUrl: playlist.serverUrl,
                      username: playlist.username,
                      password: playlist.password,
                  }
                : undefined,
        };

        void import('@arm-nator/providers/xtream/feature').then(
            ({ AccountInfoComponent }) => {
                this.dialog.open(AccountInfoComponent, {
                    width: '760px',
                    maxWidth: '92vw',
                    maxHeight: '90vh',
                    data,
                });
            }
        );
    }

    openPlaylistInfo(playlist: Playlist | null | undefined): void {
        this.dialog.open(PlaylistInfoComponent, {
            data: playlist ?? null,
        });
    }

    openSettings(): void {
        void import('@arm-nator/settings/ui').then(({ SettingsComponent }) => {
            this.dialog.open(SettingsComponent, {
                width: '1200px',
                maxWidth: '96vw',
                maxHeight: '92vh',
                data: {
                    isDialog: true,
                },
            });
        });
    }
}

export function providePortalNavigationActions(): Provider[] {
    return [
        AppPortalNavigationActionsService,
        {
            provide: PORTAL_NAVIGATION_ACTIONS,
            useExisting: AppPortalNavigationActionsService,
        },
    ];
}
