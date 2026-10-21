import {SourcePlaybackStoreService,SOURCE_PLAYBACK_FACADE} from '@arm-nator/services';
import type {SourceEvidenceKey} from '@arm-nator/shared/interfaces';
/* eslint-disable max-lines */
import {
    CdkDragDrop,
    DragDropModule,
    moveItemInArray,
} from '@angular/cdk/drag-drop';
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlaylistContextFacade } from '@arm-nator/providers/shared/playlist-util';
import {
    PlaylistActions,
    selectActiveTypeFilters,
    selectAllPlaylistsMeta,
    selectPlaylistsLoadingFlag,
} from '@arm-nator/providers/shared/playlist-state';
import { BehaviorSubject, combineLatest, map } from 'rxjs';
import { DialogService } from '@arm-nator/ui/components';
import {
    DatabaseService,
    DbOperationEvent,
    isDbAbortError,
    PlaylistDeleteActionService,
    RuntimeCapabilitiesService,
    SortBy,
    SortService,
} from '@arm-nator/services';
import {
    getPlaylistSourceType,
    PlaylistMeta,
} from '@arm-nator/shared/interfaces';

import { XtreamCatalogueRefreshService } from '../xtream-catalogue-refresh.service';
import { EmptyStateComponent } from './empty-state/empty-state.component';
import type { PlaylistType } from '../add-playlist-menu/playlist-type';
import { PlaylistInfoComponent } from './playlist-info/playlist-info.component';
import { PlaylistItemComponent } from './playlist-item/playlist-item.component';

type PlaylistBusyOperation = {
    current?: number;
    operation: string;
    operationId?: string;
    phase?: string;
    status: DbOperationEvent['status'];
    total?: number;
};

@Component({
    selector: 'app-recent-playlists',
    templateUrl: './recent-playlists.component.html',
    styleUrls: ['./recent-playlists.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DragDropModule,
        EmptyStateComponent,
        MatInputModule,
        PlaylistItemComponent,
        TranslatePipe,
    ],
})
export class RecentPlaylistsComponent {
    readonly sourcePlayback=inject(SourcePlaybackStoreService);
    readonly sourceChecks=inject(SOURCE_PLAYBACK_FACADE,{optional:true});
    private readonly sourceMetas=inject(Store).selectSignal(selectAllPlaylistsMeta);
    async checkSource(key:SourceEvidenceKey):Promise<void>{try{await this.sourceChecks?.requestCheck(key);}catch(error){this.sourcePlayback.persistenceFailure.set(error instanceof Error?error.message:'Source check could not be saved');}}
    private readonly databaseService = inject(DatabaseService);
    private readonly dialog = inject(MatDialog);
    private readonly dialogService = inject(DialogService);
    private readonly router = inject(Router);
    private readonly snackBar = inject(MatSnackBar);
    private readonly sortService = inject(SortService);
    private readonly store = inject(Store);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly translate = inject(TranslateService);
    private readonly playlistContext = inject(PlaylistContextFacade);
    private readonly playlistDeleteAction = inject(PlaylistDeleteActionService);
    private readonly catalogueRefresh = inject(XtreamCatalogueRefreshService);

    readonly sidebarMode = input(false);
    readonly searchQueryInput = input<string>('');
    readonly playlistClicked = output<string>();
    readonly addPlaylistClicked = output<PlaylistType | undefined>();

    get isElectron(): boolean {
        return this.runtime.isElectron;
    }

    get supportsXtreamSqliteDataSource(): boolean {
        return this.runtime.supportsXtreamSqliteDataSource;
    }

    readonly allPlaylistsLoaded = this.store.selectSignal(
        selectPlaylistsLoadingFlag
    );
    readonly activePlaylistId = this.playlistContext.resolvedPlaylistId;

    private readonly currentSortOptions = toSignal(
        this.sortService.getSortOptions(),
        { requireSync: true }
    );

    readonly isCustomSortActive = () =>
        this.currentSortOptions().by === SortBy.CUSTOM;

    readonly searchQuery = new BehaviorSubject<string>('');
    readonly pendingDeletionIds = signal<Set<string>>(new Set());
    readonly pendingRefreshIds = signal<Set<string>>(new Set());
    readonly busyOperations = signal<Map<string, PlaylistBusyOperation>>(
        new Map()
    );

    constructor() {
        effect(()=>{const ids=this.sourceMetas().map(source=>source._id);void this.sourcePlayback.load(ids);});
        // Update searchQuery when input changes
        effect(() => {
            this.searchQuery.next(this.searchQueryInput());
        });
    }

    readonly playlistsData$ = combineLatest([
        this.store.select(selectAllPlaylistsMeta),
        this.searchQuery,
        this.store.select(selectActiveTypeFilters),
        this.sortService.getSortOptions(),
    ]).pipe(
            map(([playlists, searchQuery, filters, sortOptions]) => {
                const filteredPlaylists = playlists
                .filter((item) => filters.includes(getPlaylistSourceType(item)))
                .filter((item) =>
                    (item.title || '')
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase())
                );

            // Apply sorting using the SortService
            const sortedPlaylists = this.sortService.sortPlaylists(
                filteredPlaylists,
                sortOptions
            );

            return {
                playlists: sortedPlaylists,
                totalCount: playlists.length,
            };
        })
    );

    private readonly basePlaylistsData = toSignal(this.playlistsData$, {
        initialValue: {
            playlists: [] as PlaylistMeta[],
            totalCount: 0,
        },
    });

    readonly playlistsData=computed(()=>{const data=this.basePlaylistsData();return {...data,playlists:data.playlists.filter(item=>this.sidebarMode()||this.sourcePlayback.matches(item._id))};});

    /**
     * Opens the details dialog with the information about the provided playlist
     * @param data selected playlist
     */
    openInfoDialog(data: PlaylistMeta): void {
        this.dialog.open(PlaylistInfoComponent, {
            data,
        });
    }

    /**
     * Drop event handler - applies the new sort order to the playlists array
     * @param event drop event
     */
    drop(event: CdkDragDrop<PlaylistMeta[]>, playlists: PlaylistMeta[]): void {
        moveItemInArray(playlists, event.previousIndex, event.currentIndex);
        this.store.dispatch(
            PlaylistActions.updatePlaylistPositions({
                positionUpdates: playlists.map((item, index) => ({
                    id: item._id,
                    changes: { position: index },
                })),
            })
        );
    }

    onAddPlaylist(type?: PlaylistType) {
        this.addPlaylistClicked.emit(type);
    }

    getPlaylist(playlistMeta: PlaylistMeta): void {
        const sourceType = getPlaylistSourceType(playlistMeta);
        if (sourceType === 'xtream') {
            this.router.navigate(['/workspace', 'xtreams', playlistMeta._id]);
        } else if (sourceType === 'stalker') {
            this.router.navigate([
                '/workspace',
                'stalker',
                playlistMeta._id,
                'itv',
            ]);
        }
    }

    /**
     * Triggers on remove click
     * @param playlistId playlist id to remove
     */
    removeClicked(item: PlaylistMeta): void {
        if (this.isDeletePending(item._id) || this.isRefreshPending(item._id)) {
            return;
        }

        this.dialogService.openConfirmDialog({
            title: this.translate.instant('HOME.PLAYLISTS.REMOVE_DIALOG.TITLE'),
            message: this.translate.instant(
                'HOME.PLAYLISTS.REMOVE_DIALOG.MESSAGE'
            ),
            onConfirm: () => {
                this.removePlaylist(item);
            },
        });
    }

    /**
     * Removes the provided playlist from the database
     * @param playlistId playlist id to remove
     */
    async removePlaylist(item: PlaylistMeta) {
        if (this.isDeletePending(item._id) || this.isRefreshPending(item._id)) {
            return;
        }

        this.setPendingDeletion(item._id, true);
        try {
            const deleted = await this.playlistDeleteAction.deletePlaylist(
                item,
                {
                    onEvent: (event) =>
                        this.updateBusyOperation(item._id, event),
                }
            );
            if (deleted) {
                this.store.dispatch(
                    PlaylistActions.removePlaylist({ playlistId: item._id })
                );
                this.snackBar.open(
                    this.translate.instant(
                        'HOME.PLAYLISTS.REMOVE_DIALOG.SUCCESS'
                    ),
                    undefined,
                    {
                        duration: 2000,
                    }
                );
            }
        } finally {
            this.clearBusyOperation(item._id);
            this.setPendingDeletion(item._id, false);
        }
    }

    /**
     * Sends an IPC event with the playlist details to the main process to trigger the refresh operation
     * @param item playlist to update
     */
    refreshPlaylist(item: PlaylistMeta) {
        if (this.isDeletePending(item._id) || this.isRefreshPending(item._id)) {
            return;
        }

        if (item.serverUrl && this.supportsXtreamSqliteDataSource) {
            // For Xtream playlists, replace the validated catalogue atomically
            this.refreshXtreamPlaylist(item);
        }
    }

    /**
     * Refresh Xtream playlist while retaining its cached catalogue until commit
     * @param item Xtream playlist to refresh
     */
    async refreshXtreamPlaylist(item: PlaylistMeta) {
        if (this.isDeletePending(item._id) || this.isRefreshPending(item._id)) {
            return;
        }

        this.dialogService.openConfirmDialog({
            title: this.translate.instant(
                'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.TITLE'
            ),
            message: this.translate.instant(
                'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.MESSAGE'
            ),
            width: '400px',
            onConfirm: async () => {
                if (
                    this.isDeletePending(item._id) ||
                    this.isRefreshPending(item._id)
                ) {
                    return;
                }

                this.setPendingRefresh(item._id, true);
                const operationId =
                    this.databaseService.createOperationId('xtream-refresh');

                try {
                    // Show immediate feedback — deletion can take several seconds
                    // for large playlists.
                    this.snackBar.open(
                        this.translate.instant(
                            'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.STARTED'
                        ),
                        undefined,
                        { duration: 2000 }
                    );

                    // Fetch and validate every catalogue kind before committing.
                    const updateDate = Date.now();
                    const result = await this.catalogueRefresh.refresh(item, {
                        operationId,
                        onEvent: event => this.updateBusyOperation(item._id, event),
                    });

                    // Update the timestamp in NgRx / IndexedDB
                    this.store.dispatch(
                        PlaylistActions.updatePlaylistMeta({
                            playlist: { ...item, updateDate, count: result.count },
                        })
                    );

                    // Catalogue commit notification refreshes cached views in place.
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
                    this.clearBusyOperation(item._id);
                    this.setPendingRefresh(item._id, false);
                }
            },
        });
    }

    isDeletePending(playlistId: string): boolean {
        return this.pendingDeletionIds().has(playlistId);
    }

    isRefreshPending(playlistId: string): boolean {
        return this.pendingRefreshIds().has(playlistId);
    }

    getBusyMessage(item: PlaylistMeta): string {
        const operation = this.busyOperations().get(item._id);
        if (!operation) {
            return '';
        }

        switch (operation.operation) {
            case 'delete-playlist':
                return this.translateDeletePhase(operation.phase);
            case 'delete-xtream-content':
                return this.translateRefreshPhase(operation.phase);
            default:
                return '';
        }
    }

    getBusyProgress(playlistId: string): number | null {
        const operation = this.busyOperations().get(playlistId);
        if (
            !operation ||
            operation.current == null ||
            operation.total == null ||
            operation.total <= 0
        ) {
            return null;
        }

        return Math.min(
            100,
            Math.round((operation.current / operation.total) * 100)
        );
    }

    canCancelBusyOperation(item: PlaylistMeta): boolean {
        const operation = this.busyOperations().get(item._id);
        if (!operation?.operationId) {
            return false;
        }

        return Boolean(item.serverUrl);
    }

    async cancelBusyOperation(item: PlaylistMeta): Promise<void> {
        const operation = this.busyOperations().get(item._id);
        if (!operation?.operationId) {
            return;
        }

        await this.databaseService.cancelOperation(operation.operationId);
    }

    private setPendingDeletion(playlistId: string, isPending: boolean): void {
        this.pendingDeletionIds.update((current) => {
            const next = new Set(current);
            if (isPending) {
                next.add(playlistId);
            } else {
                next.delete(playlistId);
            }
            return next;
        });
    }

    private setPendingRefresh(playlistId: string, isPending: boolean): void {
        this.pendingRefreshIds.update((current) => {
            const next = new Set(current);
            if (isPending) {
                next.add(playlistId);
            } else {
                next.delete(playlistId);
            }
            return next;
        });
    }

    private updateBusyOperation(
        playlistId: string,
        event: DbOperationEvent
    ): void {
        this.busyOperations.update((current) => {
            const next = new Map(current);

            if (
                event.status === 'completed' ||
                event.status === 'cancelled' ||
                event.status === 'error'
            ) {
                next.delete(playlistId);
                return next;
            }

            next.set(playlistId, {
                operation: event.operation,
                operationId: event.operationId,
                phase: event.phase,
                current: event.current,
                total: event.total,
                status: event.status,
            });
            return next;
        });
    }

    private clearBusyOperation(playlistId: string): void {
        this.busyOperations.update((current) => {
            const next = new Map(current);
            next.delete(playlistId);
            return next;
        });
    }

    private translateDeletePhase(phase?: string): string {
        switch (phase) {
            case 'deleting-favorites':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_FAVORITES'
                );
            case 'deleting-recently-viewed':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_RECENT'
                );
            case 'deleting-playback-positions':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_PROGRESS'
                );
            case 'deleting-content':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_CONTENT'
                );
            case 'deleting-categories':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_CATEGORIES'
                );
            case 'deleting-playlist':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.DELETING_PLAYLIST'
                );
            default:
                return this.translate.instant(
                    'HOME.PLAYLISTS.REMOVE_DIALOG.IN_PROGRESS'
                );
        }
    }

    private translateRefreshPhase(phase?: string): string {
        switch (phase) {
            case 'collecting-user-data':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.COLLECTING_DATA'
                );
            case 'deleting-content':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.DELETING_CONTENT'
                );
            case 'deleting-categories':
                return this.translate.instant(
                    'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.DELETING_CATEGORIES'
                );
            default:
                return this.translate.instant(
                    'HOME.PLAYLISTS.REFRESH_XTREAM_DIALOG.IN_PROGRESS'
                );
        }
    }

}
