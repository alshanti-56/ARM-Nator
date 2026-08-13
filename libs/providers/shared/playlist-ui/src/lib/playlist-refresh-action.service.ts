/* eslint-disable max-lines */
import { inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DialogService } from '@arm-nator/ui/components';
import {
    DatabaseService,
    type DbOperationEvent,
    isDbAbortError,
    PlaybackPositionService,
    RuntimeCapabilitiesService,
    XtreamPendingRestoreService,
} from '@arm-nator/services';
import { PlaylistActions } from '@arm-nator/providers/shared/playlist-state';
import { PlaylistMeta } from '@arm-nator/shared/interfaces';

export interface XtreamRefreshPreparationState {
    playlistId: string;
    operationId: string;
    phase: string;
    current?: number;
    total?: number;
}

@Injectable({ providedIn: 'root' })
export class PlaylistRefreshActionService {
    private readonly router = inject(Router);
    private readonly store = inject(Store);
    private readonly translate = inject(TranslateService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly dialogService = inject(DialogService);
    private readonly databaseService = inject(DatabaseService);
    private readonly playbackPositionService = inject(PlaybackPositionService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly pendingRestoreService = inject(
        XtreamPendingRestoreService
    );

    private readonly refreshPreparationState =
        signal<XtreamRefreshPreparationState | null>(null);

    readonly isRefreshing = signal(false);
    readonly refreshPreparation = this.refreshPreparationState.asReadonly();

    canRefresh(playlist: PlaylistMeta | null): boolean {
        if (!playlist) {
            return false;
        }

        return Boolean(
            playlist.serverUrl && this.runtime.supportsXtreamSqliteDataSource
        );
    }

    refresh(playlist: PlaylistMeta): void {
        if (this.isRefreshing()) {
            return;
        }

        if (playlist.serverUrl && this.runtime.supportsXtreamSqliteDataSource) {
            this.refreshXtream(playlist);
        }
    }

    private refreshXtream(item: PlaylistMeta): void {
        this.dialogService.openConfirmDialog({
            title: this.translate.instant(
                'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.TITLE'
            ),
            message: this.translate.instant(
                'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.MESSAGE'
            ),
            width: '400px',
            onConfirm: async () => {
                if (this.isRefreshing()) {
                    return;
                }

                this.isRefreshing.set(true);
                const operationId =
                    this.databaseService.createOperationId('xtream-refresh');
                this.refreshPreparationState.set({
                    playlistId: item._id,
                    operationId,
                    phase: 'collecting-user-data',
                });

                try {
                    this.snackBar.open(
                        this.translate.instant(
                            'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.STARTED'
                        ),
                        undefined,
                        { duration: 2000 }
                    );
                    await this.waitForRefreshPreparationPaint();

                    const updateDate = Date.now();
                    const [restoreState, playbackPositions] = await Promise.all(
                        [
                            this.databaseService.deleteXtreamPlaylistContent(
                                item._id,
                                {
                                    operationId,
                                    onEvent: (event) =>
                                        this.updateRefreshPreparationFromEvent(
                                            item._id,
                                            operationId,
                                            event
                                        ),
                                }
                            ),
                            this.playbackPositionService.getAllPlaybackPositions(
                                item._id
                            ),
                            this.databaseService.updateXtreamPlaylistDetails({
                                id: item._id,
                                updateDate,
                            }),
                        ]
                    );

                    this.pendingRestoreService.set(item._id, {
                        ...restoreState,
                        playbackPositions,
                    });

                    this.store.dispatch(
                        PlaylistActions.updatePlaylistMeta({
                            playlist: { ...item, updateDate },
                        })
                    );

                    await this.router.navigate([
                        '/workspace',
                        'xtreams',
                        item._id,
                    ]);
                } catch (error) {
                    if (!isDbAbortError(error)) {
                        console.error(
                            'Error refreshing Xtream playlist:',
                            error
                        );
                        this.snackBar.open(
                            this.translate.instant(
                                'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.ERROR'
                            ),
                            undefined,
                            { duration: 3000 }
                        );
                    }
                } finally {
                    this.clearRefreshPreparation(operationId);
                    this.isRefreshing.set(false);
                }
            },
        });
    }

    private updateRefreshPreparationFromEvent(
        playlistId: string,
        operationId: string,
        event: DbOperationEvent
    ): void {
        if (event.operationId && event.operationId !== operationId) {
            return;
        }

        this.refreshPreparationState.update((current) => {
            if (!current || current.operationId !== operationId) {
                return current;
            }

            return {
                playlistId,
                operationId,
                phase: event.phase ?? current.phase,
                current: event.current ?? current.current,
                total: event.total ?? current.total,
            };
        });
    }

    private clearRefreshPreparation(operationId: string): void {
        this.refreshPreparationState.update((current) =>
            current?.operationId === operationId ? null : current
        );
    }

    private async waitForRefreshPreparationPaint(): Promise<void> {
        const minimumVisibleDelayMs = 120;

        // Give Angular a paint opportunity before small cached playlists can
        // finish cleanup and clear the preparation state.
        const resolveAfterDelay = (resolve: () => void): void => {
            setTimeout(resolve, minimumVisibleDelayMs);
        };

        if (typeof requestAnimationFrame !== 'function') {
            await new Promise<void>(resolveAfterDelay);
            return;
        }

        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolveAfterDelay(resolve));
        });
    }
}
