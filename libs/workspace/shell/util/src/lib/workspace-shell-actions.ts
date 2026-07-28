import { InjectionToken } from '@angular/core';
import type { XtreamAccountInfoDialogData } from '@arm-nator/shared/interfaces';

export type WorkspacePlaylistType =
    | 'xtream'
    | 'url'
    | 'text'
    | 'file';
export type PlaylistCategory = 'm3u' | 'xtream';
export type M3uSubType = 'url' | 'file' | 'text';

export type WorkspaceAccountInfoData = XtreamAccountInfoDialogData;

export interface WorkspaceShellActions {
    openAddPlaylistDialog(type?: WorkspacePlaylistType): void;
    openGlobalSearch(initialQuery?: string): void;
    openGlobalRecent(): void;
    openAccountInfo(data: WorkspaceAccountInfoData): void;
}

export const WORKSPACE_SHELL_ACTIONS =
    new InjectionToken<WorkspaceShellActions>('WORKSPACE_SHELL_ACTIONS');
