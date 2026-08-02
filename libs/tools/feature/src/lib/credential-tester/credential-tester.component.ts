/* eslint-disable max-lines */
import {
    ChangeDetectionStrategy,
    Component,
    OnDestroy,
    computed,
    inject,
    signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import {
    BULK_TEST_FAILURE_STATUSES,
    createCredentialTestResultsCsv,
    type BulkResultFilter,
    type BulkTestCandidate,
    type BulkTestResult,
    type BulkTestStatus,
    type CredentialTestInput,
    type CredentialTestProgress,
    parseIptvCredentials,
} from '@arm-nator/tools/core';
import {
    PlaylistActions,
    selectAllPlaylistsMeta,
} from '@arm-nator/providers/m3u/state';
import { PlaylistsService } from '@arm-nator/services';
import {
    createRandomId,
    type Playlist,
} from '@arm-nator/shared/interfaces';
import { ElectronCredentialTesterAdapter } from './electron-credential-tester.adapter';
import {
    resolveCredentialProviderList,
    saveCredentialSources,
} from './credential-save';

const MAX_CONCURRENT_TESTS = 6;
const TEST_TIMEOUT_MS = 12_000;

function isTerminal(progress: CredentialTestProgress): boolean {
    return (
        progress.lifecycleStatus === 'completed' ||
        progress.lifecycleStatus === 'cancelled' ||
        progress.lifecycleStatus === 'error'
    );
}

@Component({
    selector: 'app-credential-tester',
    imports: [
        FormsModule,
        MatButtonModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressBarModule,
    ],
    templateUrl: './credential-tester.component.html',
    styleUrl: './credential-tester.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CredentialTesterComponent implements OnDestroy {
    private readonly store = inject(Store);
    private readonly snackBar = inject(MatSnackBar);
    private readonly playlistsService = inject(PlaylistsService);
    private readonly credentialTester = inject(ElectronCredentialTesterAdapter);
    private readonly existingPlaylists = this.store.selectSignal(
        selectAllPlaylistsMeta
    );
    private activeBatchId: string | undefined;
    private activeResultIds = new Set<string>();
    private progressUnsubscribe: (() => void) | undefined;

    inputText = '';
    searchText = '';
    readonly filter = signal<BulkResultFilter>('all');
    readonly results = signal<BulkTestResult[]>([]);
    readonly duplicates = signal(0);
    readonly invalidEntries = signal<
        readonly { id: string; text: string; reason: string }[]
    >([]);
    readonly isTesting = signal(false);
    readonly isSaving = signal(false);
    readonly isExporting = signal(false);
    readonly progressText = signal('Idle');

    readonly completedCount = computed(
        () =>
            this.results().filter(
                (result) => result.status !== 'pending' && result.status !== 'testing'
            ).length
    );
    readonly progressValue = computed(() => {
        const total = this.results().length;
        return total === 0 ? 0 : (this.completedCount() / total) * 100;
    });
    readonly workingCount = computed(
        () => this.results().filter((result) => result.status === 'working').length
    );
    readonly failedCount = computed(
        () =>
            this.results().filter((result) =>
                BULK_TEST_FAILURE_STATUSES.has(result.status)
            ).length
    );
    readonly expiredCount = computed(
        () => this.results().filter((result) => result.status === 'expired').length
    );
    readonly selectedWorkingCount = computed(
        () =>
            this.results().filter(
                (result) => result.status === 'working' && result.selected
            ).length
    );
    readonly successRate = computed(() => {
        const completed = this.completedCount();
        return completed === 0
            ? 0
            : Math.round((this.workingCount() / completed) * 100);
    });
    readonly filteredResults = computed(() => {
        const query = this.searchText.trim().toLowerCase();
        const filter = this.filter();
        return this.results().filter((result) => {
            const matchesFilter =
                filter === 'all' ||
                (filter === 'working' && result.status === 'working') ||
                (filter === 'failed' && BULK_TEST_FAILURE_STATUSES.has(result.status)) ||
                (filter === 'expired' && result.status === 'expired') ||
                (filter === 'invalid' &&
                    (result.status === 'invalid-credentials' ||
                        result.status === 'invalid-url'));
            const fields = [
                result.status,
                result.candidate.type,
                this.sourceUrl(result.candidate),
                result.candidate.username,
                result.accountStatus ?? '',
                result.message,
            ];
            return (
                matchesFilter &&
                (!query || fields.some((field) => field.toLowerCase().includes(query)))
            );
        });
    });

    ngOnDestroy(): void {
        const batchId = this.activeBatchId;
        this.detachBatch();
        if (batchId) {
            void this.credentialTester.cancel(batchId).catch(() => undefined);
        }
    }

    parse(): void {
        const parsed = parseIptvCredentials(this.inputText, 100);
        this.results.set(
            parsed.candidates.map((candidate) => ({
                id: candidate.id,
                candidate,
                status: 'pending',
                message: 'Ready to test.',
                selected: false,
            }))
        );
        this.duplicates.set(parsed.duplicates.length);
        this.invalidEntries.set(parsed.invalidEntries);
        this.progressText.set(
            `Parsed ${parsed.candidates.length}; ${parsed.duplicates.length} duplicates and ${parsed.invalidEntries.length} invalid.`
        );
    }

    clear(): void {
        const batchId = this.activeBatchId;
        this.detachBatch();
        if (batchId) {
            void this.credentialTester.cancel(batchId).catch(() => undefined);
        }
        this.inputText = '';
        this.searchText = '';
        this.results.set([]);
        this.duplicates.set(0);
        this.invalidEntries.set([]);
        this.progressText.set('Idle');
    }

    async testAll(): Promise<void> {
        await this.runTests(this.results().map((result) => result.id));
    }

    async retryFailed(): Promise<void> {
        await this.runTests(
            this.results()
                .filter((result) => BULK_TEST_FAILURE_STATUSES.has(result.status))
                .map((result) => result.id)
        );
    }

    async stop(): Promise<void> {
        if (!this.activeBatchId) {
            return;
        }
        this.progressText.set('Cancelling active tests…');
        try {
            await this.credentialTester.cancel(this.activeBatchId);
        } catch {
            this.snackBar.open('Could not cancel the credential test batch.', undefined, {
                duration: 5000,
            });
        }
    }

    setFilter(value: string): void {
        this.filter.set(value as BulkResultFilter);
    }

    toggleSelection(id: string, selected: boolean): void {
        this.patchResult(id, { selected });
    }

    selectAllFiltered(): void {
        const ids = new Set(this.filteredResults().map((result) => result.id));
        this.results.update((results) =>
            results.map((result) =>
                ids.has(result.id) ? { ...result, selected: true } : result
            )
        );
    }

    clearSelection(): void {
        this.results.update((results) =>
            results.map((result) =>
                result.selected ? { ...result, selected: false } : result
            )
        );
    }

    async saveWorking(selectedOnly: boolean): Promise<void> {
        if (this.isSaving()) {
            return;
        }
        const candidates = this.results()
            .filter(
                (result) =>
                    result.status === 'working' &&
                    (!selectedOnly || result.selected)
            )
            .map((result) => result.candidate);
        if (candidates.length === 0) {
            return;
        }

        this.isSaving.set(true);
        try {
            const saved = await saveCredentialSources(
                candidates,
                this.savedSourceKeys(),
                {
                    sourceKey: (candidate) => this.sourceKey(candidate),
                    createM3uPlaylist: (candidate) => this.createM3uPlaylist(candidate),
                    createXtreamPlaylist: (candidate) =>
                        this.createXtreamPlaylist(candidate),
                    persist: (playlists) =>
                        firstValueFrom(this.playlistsService.addManyPlaylists(playlists)),
                }
            );
            if (saved.persistenceFailed) {
                this.snackBar.open(
                    `Could not save ${candidates.length} source${candidates.length === 1 ? '' : 's'}; no rows were added.${saved.importFailures ? ` ${saved.importFailures} failed to import.` : ''}`,
                    undefined,
                    { duration: 6000 }
                );
                return;
            }
            if (saved.imported.length > 0) {
                const providerPlaylists = await resolveCredentialProviderList(
                    saved.imported,
                    () => firstValueFrom(this.playlistsService.getAllPlaylists())
                );
                this.store.dispatch(
                    PlaylistActions.loadPlaylistsSuccess({
                        playlists: providerPlaylists,
                    })
                );
            }
            this.snackBar.open(
                `Saved ${saved.imported.length} source${saved.imported.length === 1 ? '' : 's'}${saved.skippedExisting ? `; ${saved.skippedExisting} already existed` : ''}${saved.importFailures ? `; ${saved.importFailures} failed to import` : ''}.`,
                undefined,
                { duration: 5000 }
            );
        } finally {
            this.isSaving.set(false);
        }
    }

    async exportResults(): Promise<void> {
        if (this.isExporting()) {
            return;
        }
        const bridge = typeof window === 'undefined' ? undefined : window.electron;
        if (
            !bridge ||
            typeof bridge.saveFileDialog !== 'function' ||
            typeof bridge.writeFile !== 'function'
        ) {
            this.snackBar.open('Export requires the Arm-Nator desktop runtime.', undefined, {
                duration: 5000,
            });
            return;
        }

        this.isExporting.set(true);
        try {
            const filePath = await bridge.saveFileDialog('iptv-bulk-test-results.csv', [
                { name: 'CSV files', extensions: ['csv'] },
            ]);
            if (!filePath) {
                return;
            }
            const result = await bridge.writeFile(
                filePath,
                createCredentialTestResultsCsv(this.results())
            );
            if (!result.success) {
                throw new Error('File write failed.');
            }
            this.snackBar.open('Bulk test results exported.', undefined, {
                duration: 5000,
            });
        } catch {
            this.snackBar.open('Could not export bulk test results.', undefined, {
                duration: 5000,
            });
        } finally {
            this.isExporting.set(false);
        }
    }

    sourceUrl(candidate: BulkTestCandidate): string {
        return candidate.type === 'm3u'
            ? candidate.playlistUrl
            : candidate.serverUrl;
    }

    connectionText(result: BulkTestResult): string {
        if (!result.activeConnections && !result.maxConnections) {
            return '—';
        }
        return `${result.activeConnections ?? '0'}/${result.maxConnections ?? '—'}`;
    }

    expiryText(value?: string): string {
        if (!value) {
            return '—';
        }
        const seconds = Number(value);
        return Number.isFinite(seconds) && seconds > 0
            ? new Date(seconds * 1000).toLocaleDateString()
            : value;
    }

    statusLabel(status: BulkTestStatus): string {
        return status.replace(/-/g, ' ');
    }

    private async runTests(ids: readonly string[]): Promise<void> {
        if (this.isTesting() || ids.length === 0) {
            return;
        }

        const idSet = new Set(ids);
        const candidates = this.results()
            .filter((result) => idSet.has(result.id))
            .map((result) => result.candidate);
        this.results.update((results) =>
            results.map((result) =>
                idSet.has(result.id)
                    ? {
                          ...result,
                          status: 'pending',
                          message: 'Queued.',
                      }
                    : result
            )
        );
        this.activeResultIds = idSet;
        this.isTesting.set(true);
        this.progressText.set(`Queued ${candidates.length} entries.`);

        try {
            const batchId = await this.credentialTester.start(
                candidates.map((candidate) => this.toCredentialInput(candidate)),
                {
                    concurrency: MAX_CONCURRENT_TESTS,
                    timeoutMs: TEST_TIMEOUT_MS,
                }
            );
            this.activeBatchId = batchId;
            this.progressUnsubscribe = this.credentialTester.subscribe(
                batchId,
                (progress) => this.applyProgress(progress)
            );
        } catch {
            this.activeResultIds.clear();
            this.isTesting.set(false);
            this.progressText.set('Could not start testing.');
            this.snackBar.open(
                'Bulk testing requires the Arm-Nator desktop runtime.',
                undefined,
                { duration: 5000 }
            );
        }
    }

    private applyProgress(progress: CredentialTestProgress): void {
        if (progress.batchId !== this.activeBatchId) {
            return;
        }
        const snapshots = new Map(progress.current.map((result) => [result.id, result]));
        this.results.update((results) =>
            results.map((result) => {
                if (!this.activeResultIds.has(result.id)) {
                    return result;
                }
                const snapshot = snapshots.get(result.id);
                if (!snapshot) {
                    return result;
                }
                const account = snapshot.account;
                return {
                    ...result,
                    status: snapshot.outcome ??
                        (snapshot.status === 'testing' ? 'testing' : 'pending'),
                    message: snapshot.message ?? result.message,
                    responseTimeMs: snapshot.latencyMs,
                    httpStatus: snapshot.httpStatus,
                    accountStatus: account?.status,
                    expiresAt: account?.expiresAt,
                    activeConnections: account?.activeConnections,
                    maxConnections: account?.maxConnections,
                    liveCategoriesCount: account?.liveCategoriesCount,
                    moviesCount: account?.moviesCount,
                    seriesCount: account?.seriesCount,
                    playlistChannelCount: account?.playlistChannelCount,
                    lastCheckedAt: snapshot.finishedAt,
                };
            })
        );
        this.progressText.set(
            isTerminal(progress)
                ? this.terminalProgressText(progress)
                : `Tested ${progress.completed} of ${progress.total}.`
        );
        if (isTerminal(progress)) {
            this.isTesting.set(false);
            this.detachBatch();
        }
    }

    private terminalProgressText(progress: CredentialTestProgress): string {
        if (progress.lifecycleStatus === 'cancelled') {
            return `Cancelled after ${progress.completed} of ${progress.total}.`;
        }
        if (progress.lifecycleStatus === 'error') {
            return `Testing ended with an error after ${progress.completed} of ${progress.total}.`;
        }
        return `Finished testing ${progress.completed} entries.`;
    }

    private detachBatch(): void {
        this.progressUnsubscribe?.();
        this.progressUnsubscribe = undefined;
        this.activeBatchId = undefined;
        this.activeResultIds.clear();
        this.isTesting.set(false);
    }

    private toCredentialInput(candidate: BulkTestCandidate): CredentialTestInput {
        return candidate.type === 'm3u'
            ? {
                  id: candidate.id,
                  provider: 'm3u',
                  playlistUrl: candidate.playlistUrl,
              }
            : {
                  id: candidate.id,
                  provider: 'xtream',
                  serverUrl: candidate.serverUrl,
                  username: candidate.username,
                  password: candidate.password,
              };
    }

    private patchResult(id: string, patch: Partial<BulkTestResult>): void {
        this.results.update((results) =>
            results.map((result) =>
                result.id === id ? { ...result, ...patch } : result
            )
        );
    }

    private savedSourceKeys(): Set<string> {
        return new Set(
            this.existingPlaylists().map((playlist) =>
                playlist.serverUrl
                    ? `xtream|${this.normalizeServerKey(playlist.serverUrl)}|${playlist.username ?? ''}|${playlist.password ?? ''}`
                    : this.normalizeM3uKey(playlist.url ?? '')
            )
        );
    }

    private sourceKey(candidate: BulkTestCandidate): string {
        return candidate.normalizedKey;
    }

    private normalizeServerKey(serverUrl: string): string {
        try {
            const parsed = new URL(serverUrl);
            return `${parsed.protocol}//${parsed.host}`.toLowerCase();
        } catch {
            return serverUrl.replace(/\/+$/, '').toLowerCase();
        }
    }

    private normalizeM3uKey(playlistUrl: string): string {
        try {
            const parsed = new URL(playlistUrl);
            parsed.protocol = parsed.protocol.toLowerCase();
            parsed.hostname = parsed.hostname.toLowerCase();
            parsed.hash = '';
            return `m3u|${parsed.toString()}`;
        } catch {
            return `m3u|${playlistUrl}`;
        }
    }

    private async createM3uPlaylist(
        candidate: BulkTestCandidate
    ): Promise<Playlist> {
        return window.electron.fetchPlaylistByUrl(candidate.playlistUrl);
    }

    private createXtreamPlaylist(candidate: BulkTestCandidate): Playlist {
        let host = candidate.serverUrl;
        try {
            host = new URL(candidate.serverUrl).host;
        } catch {
            // The parser validates these candidates; retain the input as a fallback.
        }
        const now = new Date().toISOString();
        return {
            _id: createRandomId(),
            title: `${host} — ${candidate.username}`,
            count: 0,
            importDate: now,
            lastUsage: now,
            favorites: [],
            autoRefresh: false,
            serverUrl: candidate.serverUrl,
            username: candidate.username,
            password: candidate.password,
        };
    }
}
