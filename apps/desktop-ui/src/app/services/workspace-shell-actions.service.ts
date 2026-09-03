import { inject, Injectable, Provider } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { PORTAL_SHELL_ACTIONS } from '@arm-nator/providers/shared/util';
import {
    WORKSPACE_SHELL_ACTIONS,
    WorkspaceAccountInfoData,
    WorkspacePlaylistType,
    WorkspaceShellActions,
} from '@arm-nator/workspace/shell/util';

@Injectable({ providedIn: 'root' })
export class AppWorkspaceShellActionsService implements WorkspaceShellActions {
    private readonly dialog = inject(MatDialog);
    private readonly router = inject(Router);

    openAddPlaylistDialog(type?: WorkspacePlaylistType): void {
        void import('@arm-nator/providers/import/feature').then(
            ({ AddPlaylistDialogComponent }) => {
                this.dialog.open(AddPlaylistDialogComponent, {
                    // Width sized for the 5-card method picker plus the
                    // selected method's form below. Matches the v0.22
                    // mockup; falls back to viewport-clamped width on
                    // narrow screens so the grid can collapse via the
                    // SCSS responsive breakpoints.
                    width: '780px',
                    maxWidth: '92vw',
                    data: type ? { type } : {},
                });
            }
        );
    }

    openGlobalSearch(initialQuery = ''): void {
        const query = initialQuery.trim();
        void this.router.navigate(['/workspace/search'], {
            queryParams: query ? { q: query } : {},
        });
    }

    openGlobalRecent(): void {
        void this.router.navigate(['/workspace/global-recent']);
    }

    openAccountInfo(data: WorkspaceAccountInfoData): void {
        const playlist = data.playlist;
        if (
            playlist &&
            'macAddress' in playlist &&
            'portalUrl' in playlist &&
            Boolean(playlist.macAddress && playlist.portalUrl)
        ) {
            void import('@arm-nator/providers/stalker/feature').then(
                ({ StalkerAccountInfoComponent }) => {
                    this.dialog.open(StalkerAccountInfoComponent, {
                        width: '760px',
                        maxWidth: '92vw',
                        maxHeight: '90vh',
                        data,
                    });
                }
            );
            return;
        }

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
}

export function provideWorkspaceShellActions(): Provider[] {
    return [
        AppWorkspaceShellActionsService,
        {
            provide: WORKSPACE_SHELL_ACTIONS,
            useExisting: AppWorkspaceShellActionsService,
        },
        {
            provide: PORTAL_SHELL_ACTIONS,
            useExisting: AppWorkspaceShellActionsService,
        },
    ];
}
