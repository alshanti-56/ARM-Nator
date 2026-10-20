import { Component, DestroyRef, inject, signal, ChangeDetectionStrategy } from '@angular/core';
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
import { MatSelectModule } from '@angular/material/select';
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
import { USER_AGENT_PROFILES, type UserAgentProfile } from './user-agent-profiles';
import type { UserAgentTestResult } from './user-agent-test-runner';
import { PlaylistUserAgentTestService } from './playlist-user-agent-test.service';

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

            .user-agent-test { border: 1px solid var(--mat-sys-outline-variant); border-radius: 12px; padding: 12px; }
            .user-agent-test__heading, .user-agent-test__result { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
            .user-agent-test__result { padding: 8px 0; border-top: 1px solid var(--mat-sys-outline-variant); }
            .user-agent-test__result small { display: block; color: var(--mat-sys-on-surface-variant); margin-top: 3px; }
            .user-agent-test__status { margin: 8px 0 !important; }
            .user-agent-test__error { color: var(--mat-sys-error) !important; }

        `,
    ],
    changeDetection: ChangeDetectionStrategy.Eager,
    providers: [PlaylistUserAgentTestService],
    imports: [
        MatButton,
        MatDialogModule,
        MatInputModule,
        MatSelectModule,
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
    private readonly userAgentTester = inject(PlaylistUserAgentTestService);
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
    readonly userAgentPresets = USER_AGENT_PROFILES;
    readonly selectedUserAgentPreset = signal('automatic');
    private customUserAgent = '';
    readonly isTestingUserAgents = signal(false);
    readonly userAgentTestResults = signal<UserAgentTestResult[]>([]);
    readonly userAgentTestSamples = signal<string[]>([]);
    readonly userAgentTestError = signal('');
    private userAgentTestController: AbortController | null = null;

    get hasUserAgentMediaResults(): boolean {
        return this.userAgentTestResults().some((result) => result.state === 'working');
    }

    get userAgentTestProgress(): string {
        const results = this.userAgentTestResults();
        const completed = results.filter((result) => result.state === 'working' || result.state === 'failed').length;
        const current = results.find((result) => result.state === 'testing');
        if (this.isTestingUserAgents() && this.userAgentTestController?.signal.aborted) return 'Stopping test…';
        return this.isTestingUserAgents()
            ? current ? `${completed}/${results.length} checked · Testing ${current.profile.label}…` : 'Loading sample channels…'
            : `${completed}/${results.length} checked${results.some((result) => result.state === 'cancelled') ? ' · Stopped' : ''}`;
    }

    constructor() {
        inject(DestroyRef).onDestroy(() => this.cancelUserAgentTests());
        this.playlist = this.playlistData;
        this.createForm();
        const userAgent = this.playlistDetails.get('userAgent')?.value ?? '';
        const preset = this.userAgentPresets.find((entry) => entry.value === userAgent);
        this.selectedUserAgentPreset.set(preset?.id ?? 'custom');
        this.customUserAgent = preset ? '' : userAgent;
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

    selectUserAgentPreset(id: string): void {
        const control = this.playlistDetails.get('userAgent');
        if (!control) return;
        const preset = this.userAgentPresets.find((entry) => entry.id === id);
        if (id !== 'custom' && !preset) return;
        if (this.selectedUserAgentPreset() === 'custom') {
            this.customUserAgent = String(control.value ?? '');
        }
        this.selectedUserAgentPreset.set(id);
        const value = id === 'custom' ? this.customUserAgent : preset!.value;
        if (control.value !== value) {
            control.setValue(value);
            control.markAsDirty();
        }
    }

    async testAllUserAgents(): Promise<void> {
        if (this.isTestingUserAgents()) return;
        const controller = new AbortController();
        this.userAgentTestController = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(240_000)]);
        const custom = this.selectedUserAgentPreset() === 'custom'
            ? String(this.playlistDetails.get('userAgent')?.value ?? '') : this.customUserAgent;
        const profiles: UserAgentProfile[] = [...this.userAgentPresets];
        if (custom.trim() && !profiles.some((profile) => profile.value === custom)) {
            profiles.push({ id: 'custom', label: 'Your custom user agent', value: custom });
        }
        this.userAgentTestResults.set(profiles.map((profile) => ({ profile, state: 'queued', detail: 'Waiting' })));
        this.userAgentTestSamples.set([]);
        this.userAgentTestError.set('');
        this.isTestingUserAgents.set(true);
        try {
            await this.userAgentTester.run(this.playlist, profiles, signal,
                (result) => this.userAgentTestResults.update((rows) => rows.map((row) => row.profile.id === result.profile.id ? result : row)),
                (names) => this.userAgentTestSamples.set(names),
            );
        } catch {
            if (!signal.aborted) this.userAgentTestError.set('Could not authenticate or load sample streams. Check this source’s portal access and try again.');
        } finally {
            if (signal.aborted && !controller.signal.aborted) this.userAgentTestError.set('The test time limit was reached. Some profiles were not tested.');
            this.userAgentTestResults.update((rows) => rows.map((row) => row.state === 'queued' || row.state === 'testing'
                ? { ...row, state: 'cancelled', detail: 'Not tested' } : row));
            this.isTestingUserAgents.set(false);
            this.userAgentTestController = null;
        }
    }

    cancelUserAgentTests(): void {
        this.userAgentTestController?.abort();
    }

    applyTestedUserAgent(result: UserAgentTestResult): void {
        if (result.state !== 'working' || this.isTestingUserAgents()) return;
        this.selectUserAgentPreset(result.profile.id);
        if (result.profile.id === 'custom') {
            this.customUserAgent = result.profile.value;
            const control = this.playlistDetails.get('userAgent');
            control?.setValue(result.profile.value);
            control?.markAsDirty();
        }
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
