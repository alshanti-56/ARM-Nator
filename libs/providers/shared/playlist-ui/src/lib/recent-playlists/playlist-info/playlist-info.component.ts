import { Component, inject, signal } from '@angular/core';
import {
    FormControl,
    ReactiveFormsModule,
    UntypedFormBuilder,
    UntypedFormGroup,
    Validators,
} from '@angular/forms';
import { MatButton } from '@angular/material/button';
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
import { XtreamApiService } from '@arm-nator/providers/xtream/data-access';
import { DatabaseService, RuntimeCapabilitiesService } from '@arm-nator/services';
import {
    buildXtreamServerUrl,
    normalizeXtreamServerUrl,
    Playlist,
    PlaylistMeta,
} from '@arm-nator/shared/interfaces';

interface PlaylistServerPort {
    labelKey: string;
    value: string;
}

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
    imports: [
        MatButton,
        MatDialogModule,
        MatInputModule,
        ReactiveFormsModule,
        TranslatePipe,
    ],
})
export class PlaylistInfoComponent {
    private formBuilder = inject(UntypedFormBuilder);
    private store = inject(Store);
    private databaseService = inject(DatabaseService);
    private snackBar = inject(MatSnackBar);
    private translate = inject(TranslateService);
    private runtime = inject(RuntimeCapabilitiesService);
    private xtreamApiService = inject(XtreamApiService);
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

    readonly availableServerPorts = signal<PlaylistServerPort[]>([]);
    readonly isLoadingServerPorts = signal(false);

    constructor() {
        this.playlist = this.playlistData;
        this.createForm();
        void this.loadServerDetails();
    }

    get hasXtreamCredentials(): boolean {
        return Boolean(
            this.playlist.serverUrl &&
                this.playlist.username &&
                this.playlist.password
        );
    }

    get availablePortsDisplay(): string {
        if (this.isLoadingServerPorts()) {
            return this.translate.instant(
                'HOME.PLAYLISTS.INFO_DIALOG.AVAILABLE_PORTS_LOADING'
            );
        }

        const ports = this.availableServerPorts();
        if (ports.length === 0) {
            return '-';
        }

        return ports
            .map(
                (port) =>
                    `${this.translate.instant(port.labelKey)} ${port.value}`
            )
            .join(' · ');
    }

    /**
     * Create the form and set initial data on component init
     */
    createForm(): void {
        this.playlistDetails = this.formBuilder.group({
            _id: this.playlist._id,
            title: new FormControl(this.playlist.title, Validators.required),
            userAgent: this.playlist.userAgent || '',
            count: new FormControl({
                value: this.playlist.count,
                disabled: true,
            }),
            serverUrl: new FormControl(this.playlist.serverUrl),
            portalUrl: new FormControl(this.playlist.portalUrl),
            username: new FormControl(this.playlist.username),
            password: new FormControl(this.playlist.password),
        });
    }

    private async loadServerDetails(): Promise<void> {
        if (!this.hasXtreamCredentials) {
            return;
        }

        this.isLoadingServerPorts.set(true);
        try {
            const accountInfo = await this.xtreamApiService.getAccountInfo({
                serverUrl: this.playlist.serverUrl as string,
                username: this.playlist.username as string,
                password: this.playlist.password as string,
            });
            const serverInfo = accountInfo.server_info;
            const serverUrlControl = this.playlistDetails.get('serverUrl');
            const currentServerUrl = String(serverUrlControl?.value ?? '');
            const currentProtocol = /^https?:/i
                .exec(currentServerUrl)?.[0]
                ?.slice(0, -1)
                .toLowerCase();
            const isHttps =
                (currentProtocol || serverInfo.server_protocol)
                    ?.trim()
                    .toLowerCase() === 'https';
            const activePort = isHttps
                ? serverInfo.https_port || serverInfo.port
                : serverInfo.port || serverInfo.https_port;
            const serverUrl = buildXtreamServerUrl(
                currentServerUrl || serverInfo.url,
                serverInfo.server_protocol,
                activePort
            );

            if (serverUrlControl && serverUrl !== currentServerUrl) {
                serverUrlControl.setValue(serverUrl, { emitEvent: false });
                serverUrlControl.markAsDirty();
            }

            this.availableServerPorts.set(
                [
                    {
                        labelKey: 'XTREAM.ACCOUNT_INFO.HTTP_PORT',
                        value: serverInfo.port,
                    },
                    {
                        labelKey: 'XTREAM.ACCOUNT_INFO.HTTPS_PORT',
                        value: serverInfo.https_port,
                    },
                    {
                        labelKey: 'XTREAM.ACCOUNT_INFO.RTMP_PORT',
                        value: serverInfo.rtmp_port,
                    },
                ].filter((port) => Boolean(port.value?.trim()))
            );
        } catch (error) {
            console.warn('Failed to load Xtream server ports:', error);
        } finally {
            this.isLoadingServerPorts.set(false);
        }
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
