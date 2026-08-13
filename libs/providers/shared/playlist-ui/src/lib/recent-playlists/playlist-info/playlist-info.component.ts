import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import {
    FormControl,
    ReactiveFormsModule,
    UntypedFormBuilder,
    UntypedFormGroup,
    Validators,
} from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
    MAT_DIALOG_DATA,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlaylistActions } from '@arm-nator/providers/shared/playlist-state';
import { DatabaseService, RuntimeCapabilitiesService } from '@arm-nator/services';
import {
    normalizeXtreamServerUrl,
    Playlist,
    PlaylistMeta,
} from '@arm-nator/shared/interfaces';

@Component({
    selector: 'app-playlist-info',
    templateUrl: './playlist-info.component.html',
    styles: [
        `
            .spacer {
                flex: 1 1 auto;
            }

            mat-dialog-content {
                display: flex;
                flex-direction: column;
                gap: 14px;
            }

            // Material's '.mat-mdc-dialog-title + .mat-mdc-dialog-content' rule
            // zeroes padding-top with higher specificity than a scoped override,
            // which clips the first field's floating label. Pushing the first
            // field down with margin-top side-steps that entirely.
            mat-dialog-content > mat-form-field:first-child {
                margin-top: 10px;
            }

            mat-dialog-content mat-checkbox {
                margin-top: 4px;
            }

            mat-dialog-content p {
                margin: 0;
                color: var(--mat-sys-on-surface-variant);
                font-size: 12.5px;
                line-height: 1.45;
            }

        `,
    ],
    providers: [DatePipe],
    imports: [
        MatButton,
        MatCheckboxModule,
        MatDialogModule,
        MatInputModule,
        ReactiveFormsModule,
        TranslatePipe,
    ],
})
export class PlaylistInfoComponent {
    private datePipe = inject(DatePipe);
    private formBuilder = inject(UntypedFormBuilder);
    private store = inject(Store);
    private databaseService = inject(DatabaseService);
    private snackBar = inject(MatSnackBar);
    private translate = inject(TranslateService);
    private runtime = inject(RuntimeCapabilitiesService);
    private dialogRef = inject(MatDialogRef<PlaylistInfoComponent>, {
        optional: true,
    });
    public playlistData = inject<Playlist & { id: string }>(MAT_DIALOG_DATA);

    get isDesktop(): boolean {
        return this.runtime.supportsDesktopFileSave;
    }

    /** Playlist object */
    playlist: Playlist & { id: string };

    /** Form group with playlist details */
    playlistDetails!: UntypedFormGroup;

    constructor() {
        this.playlist = this.playlistData;
        this.createForm();
    }

    /**
     * Create the form and set initial data on component init
     */
    createForm(): void {
        this.playlistDetails = this.formBuilder.group({
            _id: this.playlist._id,
            title: new FormControl(this.playlist.title, Validators.required),
            userAgent: this.playlist.userAgent || '',
            filename: new FormControl({
                value: this.playlist.filename || '',
                disabled: true,
            }),
            count: new FormControl({
                value: this.playlist.count,
                disabled: true,
            }),
            importDate: new FormControl({
                value: this.datePipe.transform(this.playlist.importDate),
                disabled: true,
            }),
            url: new FormControl({
                value: this.playlist.url,
                disabled: true,
            }),
            filePath: new FormControl({
                value: this.playlist.filePath,
                disabled: true,
            }),
            autoRefresh: new FormControl(this.playlist.autoRefresh),
            serverUrl: new FormControl(this.playlist.serverUrl),
            username: new FormControl(this.playlist.username),
            password: new FormControl(this.playlist.password),
        });
    }

    async saveChanges(playlist: PlaylistMeta): Promise<void> {
        try {
            const normalizedPlaylist =
                this.normalizeXtreamPlaylistMeta(playlist);
            const isXtream =
                this.playlist &&
                this.playlist.username &&
                this.playlist.password &&
                this.playlist.serverUrl;

            if (isXtream && this.runtime.supportsXtreamSqliteDataSource) {
                await this.updateXtreamPlaylist(normalizedPlaylist);
            }

            // Dispatch store action to update UI
            this.store.dispatch(
                PlaylistActions.updatePlaylistMeta({
                    playlist: normalizedPlaylist,
                })
            );

            this.snackBar.open(
                this.translate.instant(
                    'HOME.PLAYLISTS.PLAYLIST_UPDATE_SUCCESS'
                ),
                this.translate.instant('CLOSE'),
                { duration: 3000 }
            );
            this.dialogRef?.close();
        } catch (error) {
            console.error('Error updating playlist:', error);
            this.snackBar.open(
                this.translate.instant('HOME.PLAYLISTS.PLAYLIST_UPDATE_FAILED'),
                this.translate.instant('CLOSE'),
                {
                    duration: 3000,
                }
            );
        }
    }

    private normalizeXtreamPlaylistMeta(playlist: PlaylistMeta): PlaylistMeta {
        if (!playlist.serverUrl || !playlist.username || !playlist.password) {
            return playlist;
        }

        return {
            ...playlist,
            password: playlist.password.trim(),
            serverUrl: normalizeXtreamServerUrl(playlist.serverUrl),
            username: playlist.username.trim(),
        };
    }

    async updateXtreamPlaylist(playlist: PlaylistMeta) {
        const success = await this.databaseService.updateXtreamPlaylistDetails({
            id: this.playlist._id,
            title: playlist.title,
            username: playlist.username,
            password: playlist.password,
            serverUrl: playlist.serverUrl,
        });

        if (!success) {
            throw new Error('Failed to update playlist in database');
        }

        // TODO: circular dependency
        /* this.xtreamStore.updatePlaylist({
            name: playlist.title,
            username: playlist.username,
            password: playlist.password,
            serverUrl: playlist.serverUrl,
        }); */
    }

}
