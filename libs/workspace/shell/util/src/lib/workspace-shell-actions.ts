import { InjectionToken } from '@angular/core';
import type {
    StalkerAccountInfoDialogData,
    XtreamAccountInfoDialogData,
} from '@arm-nator/shared/interfaces';

export type WorkspacePlaylistType =
    | 'xtream'
    | 'stalker';

export type WorkspaceAccountInfoData =
    | XtreamAccountInfoDialogData
    | StalkerAccountInfoDialogData;

export interface WorkspaceShellActions {
    openAddPlaylistDialog(type?: WorkspacePlaylistType): void;
    openGlobalSearch(initialQuery?: string): void;
    openGlobalRecent(): void;
    openAccountInfo(data: WorkspaceAccountInfoData): void;
}

export const WORKSPACE_SHELL_ACTIONS =
    new InjectionToken<WorkspaceShellActions>('WORKSPACE_SHELL_ACTIONS');
