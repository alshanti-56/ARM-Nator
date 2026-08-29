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
    parseStalkerCredentials,
    createStalkerCredentialKey,
    type StalkerCredentialCandidate,
    STALKER_TEST_FAILURE_STATUSES,
    type StalkerTestResult,
    type StalkerTestStatus,
} from '@arm-nator/tools/core';
import {
    PlaylistActions,
    selectAllPlaylistsMeta,
} from '@arm-nator/providers/shared/playlist-state';
import { PlaylistsService } from '@arm-nator/services';
import {
    createRandomId,
    type Playlist,
} from '@arm-nator/shared/interfaces';
import { ElectronCredentialTesterAdapter } from './electron-credential-tester.adapter';
import { StalkerPortalDiscoveryService } from '@arm-nator/providers/stalker/data-access';
import {
    resolveCredentialProviderList,
    saveCredentialSources,
} from './credential-save';

const MAX_CONCURRENT_TESTS = 6;
const TEST_TIMEOUT_MS = 12_000;
type EditableCandidateField = 'source' | 'username' | 'password';
type StalkerResultFilter = 'all' | 'working' | 'failed' | 'expired' | 'invalid';

function isTerminal(progress: CredentialTestProgress): boolean {
    return (
        progress.lifecycleStatus === 'completed' ||
        progress.lifecycleStatus === 'cancelled' ||
        progress.lifecycleStatus === 'error'
    );
}

function createStalkerTestResultsCsv(
    results: readonly StalkerTestResult[]
): string {
    const escape = (value: string | number | undefined): string =>
        `"${String(value ?? '').replace(/"/g, '""')}"`;
    const rows = results.map((result) => [
        result.status,
        result.candidate.portalUrl,
        result.candidate.macAddress,
        result.tokenMode,
        result.expiresAt ?? result.accountInfo?.expireDate,
        result.responseTimeMs,
        result.accountInfo?.login,
        result.accountInfo?.tariffPlanName,
        result.accountInfo?.status,
        result.message,
    ].map(escape).join(','));
    return [
        'status,portal_url,mac_address,session_mode,expiry,response_time_ms,account_login,tariff_plan,account_status,details',
        ...rows,
    ].join('\n');
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
    private readonly stalkerDiscovery = inject(StalkerPortalDiscoveryService);
    private readonly existingPlaylists = this.store.selectSignal(
        selectAllPlaylistsMeta
    );
    private activeBatchId: string | undefined;
    private activeResultIds = new Set<string>();
    private progressUnsubscribe: (() => void) | undefined;
    private stalkerRunId = 0;
    private stalkerAbortController: AbortController | undefined;

    inputText = '';
    stalkerInputText = '';
    readonly sourceMode = signal<'xtream' | 'stalker'>('xtream');
    readonly stalkerCandidates = signal<readonly StalkerCredentialCandidate[]>([]);
    readonly stalkerInvalidEntries = signal<readonly { id: string; text: string; reason: string }[]>([]);
    readonly stalkerResults = signal<readonly StalkerTestResult[]>([]);
    readonly stalkerTesting = signal(false);
    readonly stalkerFilter = signal<StalkerResultFilter>('all');
    readonly stalkerSearchText = signal('');
    readonly stalkerWorkingCount = computed(() => this.stalkerResults().filter((result) => result.status === 'working').length);
    readonly stalkerTestedCount = computed(() => this.stalkerResults().filter((result) => !['pending', 'testing'].includes(result.status)).length);
    readonly stalkerFailedCount = computed(() => this.stalkerResults().filter((result) => STALKER_TEST_FAILURE_STATUSES.has(result.status)).length);
    readonly stalkerExpiredCount = computed(() => this.stalkerResults().filter((result) => result.status === 'expired').length);
    readonly stalkerSelectedWorkingCount = computed(() => this.stalkerResults().filter((result) => result.status === 'working' && result.selected).length);
    readonly savedStalkerIds = signal<ReadonlySet<string>>(new Set());
    readonly stalkerAddedCount = computed(() => this.savedStalkerIds().size);
    readonly stalkerSuccessRate = computed(() => {
        const completed = this.stalkerTestedCount();
        return completed === 0 ? 0 : Math.round((this.stalkerWorkingCount() / completed) * 100);
    });
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
    readonly filteredStalkerResults = computed(() => {
        const query = this.stalkerSearchText().trim().toLowerCase();
        const filter = this.stalkerFilter();
        return this.stalkerResults().filter((result) => {
            const matchesFilter =
                filter === 'all' ||
                (filter === 'working' && result.status === 'working') ||
                (filter === 'failed' && STALKER_TEST_FAILURE_STATUSES.has(result.status)) ||
                (filter === 'expired' && result.status === 'expired') ||
                (filter === 'invalid' &&
                    (result.status === 'invalid-mac' ||
                        result.status === 'invalid-url' ||
                        result.status === 'auth-rejected'));
            const fields = [
                result.status,
                result.candidate.portalUrl,
                result.candidate.macAddress,
                result.tokenMode ?? '',
                result.accountInfo?.login ?? '',
                result.accountInfo?.tariffPlanName ?? '',
                result.message,
            ];
            return matchesFilter && (!query || fields.some((field) => field.toLowerCase().includes(query)));
        });
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
        this.stalkerAbortController?.abort();
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

    selectSourceMode(mode: 'xtream' | 'stalker'): void {
        this.stalkerRunId += 1;
        this.stalkerAbortController?.abort();
        this.stalkerAbortController = undefined;
        this.stalkerTesting.set(false);
        this.sourceMode.set(mode);
        this.results.set([]);
        this.invalidEntries.set([]);
        this.stalkerCandidates.set([]);
        this.stalkerInvalidEntries.set([]);
        this.stalkerResults.set([]);
        this.stalkerFilter.set('all');
        this.stalkerSearchText.set('');
        this.savedStalkerIds.set(new Set());
        this.progressText.set('Idle');
    }

    parseStalker(): void {
        const parsed = parseStalkerCredentials(this.stalkerInputText, 100);
        this.stalkerCandidates.set(parsed.candidates);
        this.stalkerInvalidEntries.set(parsed.invalidEntries);
        this.stalkerResults.set(parsed.candidates.map((candidate) => ({
            id: candidate.id,
            candidate,
            status: 'pending',
            message: 'Ready to validate.',
            selected: false,
        })));
        this.stalkerFilter.set('all');
        this.stalkerSearchText.set('');
        this.progressText.set(`Parsed ${parsed.candidates.length}; ${parsed.duplicates.length} duplicates and ${parsed.invalidEntries.length} invalid.`);
    }

    async testStalker(): Promise<void> {
        await this.runStalkerTests(this.stalkerResults().map((result) => result.id));
    }

    async retryFailedStalker(): Promise<void> {
        await this.runStalkerTests(this.stalkerResults().filter((result) => STALKER_TEST_FAILURE_STATUSES.has(result.status)).map((result) => result.id));
    }

    async stopStalker(): Promise<void> {
        if (!this.stalkerTesting()) return;
        this.stalkerAbortController?.abort();
        this.progressText.set(`Cancelling after ${this.stalkerTestedCount()} of ${this.stalkerResults().length}.`);
    }

    toggleStalkerSelection(id: string, selected: boolean): void {
        this.stalkerResults.update((results) => results.map((result) => result.id === id ? { ...result, selected } : result));
    }

    setStalkerFilter(value: string): void {
        this.stalkerFilter.set(value as StalkerResultFilter);
    }

    selectAllFilteredStalker(): void {
        const ids = new Set(this.filteredStalkerResults().map((result) => result.id));
        this.stalkerResults.update((results) => results.map((result) =>
            ids.has(result.id) && result.status === 'working'
                ? { ...result, selected: true }
                : result
        ));
    }

    clearStalkerSelection(): void {
        this.stalkerResults.update((results) => results.map((result) => result.selected ? { ...result, selected: false } : result));
    }

    stalkerStatusLabel(status: StalkerTestStatus): string {
        return status.replace(/-/g, ' ');
    }

    stalkerExpiryText(result: StalkerTestResult): string {
        if (result.status === 'pending' || result.status === 'testing') {
            return 'Checking…';
        }
        const expiry = result.expiresAt ?? result.accountInfo?.expireDate;
        if (expiry && expiry > 0) return new Date(expiry * 1000).toLocaleDateString();
        if (result.status === 'working') return 'Not reported';
        return 'Not checked';
    }

    private async runStalkerTests(ids: readonly string[]): Promise<void> {
        if (this.stalkerTesting() || ids.length === 0) return;
        const bridgeAvailable = typeof window !== 'undefined' && typeof window.electron?.stalkerRequest === 'function';
        if (!bridgeAvailable) {
            this.patchStalkerResults(ids, { status: 'unknown-error', message: 'Desktop app required for validation.' });
            this.progressText.set('Open ARM-Nator desktop to validate portals.');
            return;
        }
        const idSet = new Set(ids);
        const candidates = this.stalkerResults().filter((result) => idSet.has(result.id));
        this.stalkerAbortController?.abort();
        const controller = new AbortController();
        this.stalkerAbortController = controller;
        const runId = ++this.stalkerRunId;
        this.stalkerTesting.set(true);
        this.patchStalkerResults(ids, { status: 'pending', message: 'Queued.' });
        this.progressText.set(`Queued ${candidates.length} Stalker entries.`);
        let completed = 0;
        try {
            for (const result of candidates) {
                if (controller.signal.aborted || runId !== this.stalkerRunId) break;
                const startedAt = Date.now();
                this.patchStalkerResults([result.id], { status: 'testing', message: 'Testing…' });
                try {
                    const outcome = await this.stalkerDiscovery.discover(result.candidate.portalUrl, result.candidate.macAddress);
                    if (controller.signal.aborted || runId !== this.stalkerRunId) break;
                    const elapsed = Date.now() - startedAt;
                    if (outcome.status === 'resolved') {
                        const accountInfo = outcome.accountInfo;
                        const expiresAt = accountInfo?.expire_date;
                        const expired = expiresAt !== undefined && expiresAt > 0 && expiresAt * 1000 < Date.now();
                        this.patchStalkerResults([result.id], {
                            status: expired ? 'expired' : 'working',
                            message: outcome.isFullStalkerPortal ? 'Portal authenticated successfully.' : 'Portal responded without a session token.',
                            responseTimeMs: elapsed,
                            tokenMode: outcome.isFullStalkerPortal ? 'authenticated' : 'token-free',
                            isFullStalkerPortal: outcome.isFullStalkerPortal,
                            stalkerToken: outcome.token,
                            expiresAt,
                            accountInfo: accountInfo ? { login: accountInfo.login, expireDate: accountInfo.expire_date, tariffPlanName: accountInfo.tariff_plan_name, status: accountInfo.status } : undefined,
                            watchdogTimeoutSeconds: outcome.watchdogTimeoutSeconds,
                            timeslotSeconds: outcome.timeslotSeconds,
                            lastCheckedAt: Date.now(),
                        });
                    } else if (outcome.status === 'auth-rejected') {
                        this.patchStalkerResults([result.id], { status: 'auth-rejected', message: 'Portal rejected the MAC or account.', responseTimeMs: elapsed, lastCheckedAt: Date.now() });
                    } else {
                        this.patchStalkerResults([result.id], { status: 'offline', message: 'Portal could not be reached or was not a Stalker endpoint.', responseTimeMs: elapsed, lastCheckedAt: Date.now() });
                    }
                } catch {
                    this.patchStalkerResults([result.id], { status: 'unknown-error', message: 'Portal validation failed unexpectedly.', responseTimeMs: Date.now() - startedAt, lastCheckedAt: Date.now() });
                }
                completed += 1;
                this.progressText.set(`Tested ${completed} of ${candidates.length} Stalker entries.`);
            }
            if (controller.signal.aborted) {
                this.patchStalkerResults(candidates.slice(completed).map((result) => result.id), { status: 'cancelled', message: 'Testing was cancelled.' });
                this.progressText.set(`Cancelled after ${completed} of ${candidates.length} Stalker entries.`);
            } else {
                this.progressText.set(`Finished testing ${completed} Stalker entries.`);
            }
        } finally {
            if (this.stalkerRunId === runId) {
                this.stalkerTesting.set(false);
                this.stalkerAbortController = undefined;
            }
        }
    }

    private patchStalkerResults(ids: readonly string[], patch: Partial<StalkerTestResult>): void {
        const idSet = new Set(ids);
        this.stalkerResults.update((results) => results.map((result) => idSet.has(result.id) ? { ...result, ...patch } : result));
    }

    async saveWorkingStalker(selectedOnly = false): Promise<void> {
        const working = this.stalkerResults().filter((result) => result.status === 'working' && (!selectedOnly || result.selected));
        if (!working.length) return;
        const existing = this.existingStalkerSourceKeys();
        const unique = working.filter((result) => {
            const key = this.stalkerSourceKey(result.candidate);
            if (existing.has(key)) return false;
            existing.add(key);
            return true;
        });
        if (!unique.length) {
            this.savedStalkerIds.update((ids) => new Set([
                ...ids,
                ...working.map((result) => result.id),
            ]));
            this.snackBar.open('All working Stalker sources already exist.', undefined, { duration: 4000 });
            return;
        }
        const playlists = unique.map((result) => this.createStalkerPlaylist(result));
        try {
            await firstValueFrom(this.playlistsService.addManyPlaylists(playlists));
            this.store.dispatch(PlaylistActions.addManyPlaylists({ playlists }));
            this.savedStalkerIds.update((ids) => new Set([
                ...ids,
                ...working.map((result) => result.id),
            ]));
            this.snackBar.open(`Saved ${playlists.length} working Stalker source${playlists.length === 1 ? '' : 's'}${working.length !== unique.length ? `; ${working.length - unique.length} already existed` : ''}.`, undefined, { duration: 5000 });
        } catch {
            this.snackBar.open('Could not save working Stalker sources.', undefined, { duration: 5000 });
        }
    }

    async exportStalkerResults(): Promise<void> {
        if (this.isExporting()) return;
        const bridge = typeof window === 'undefined' ? undefined : window.electron;
        if (!bridge || typeof bridge.saveFileDialog !== 'function' || typeof bridge.writeFile !== 'function') {
            this.snackBar.open('Export requires the ARM-Nator desktop runtime.', undefined, {
                duration: 5000,
            });
            return;
        }
        this.isExporting.set(true);
        try {
            const filePath = await bridge.saveFileDialog('stalker-validation-results.csv', [
                { name: 'CSV files', extensions: ['csv'] },
            ]);
            if (!filePath) return;
            const result = await bridge.writeFile(
                filePath,
                createStalkerTestResultsCsv(this.stalkerResults())
            );
            if (!result.success) throw new Error('File write failed.');
            this.snackBar.open('Stalker validation results exported.', undefined, {
                duration: 5000,
            });
        } catch {
            this.snackBar.open('Could not export Stalker validation results.', undefined, {
                duration: 5000,
            });
        } finally {
            this.isExporting.set(false);
        }
    }

    async saveStalkerCandidate(candidate: StalkerCredentialCandidate): Promise<void> {
        if (this.savedStalkerIds().has(candidate.id)) return;
        const result = this.stalkerResults().find((item) => item.id === candidate.id);
        if (!result || result.status !== 'working') {
            this.snackBar.open('Validate this portal successfully before adding it.', undefined, { duration: 4000 });
            return;
        }
        if (this.existingStalkerSourceKeys().has(this.stalkerSourceKey(candidate))) {
            this.savedStalkerIds.update((ids) => new Set([...ids, candidate.id]));
            this.snackBar.open('This Stalker source already exists.', undefined, { duration: 4000 });
            return;
        }
        const playlist = this.createStalkerPlaylist(result);
        try {
            await firstValueFrom(this.playlistsService.addManyPlaylists([playlist]));
            this.store.dispatch(PlaylistActions.addPlaylist({ playlist }));
            this.savedStalkerIds.update((ids) => new Set([...ids, candidate.id]));
            this.snackBar.open('Stalker source added.', undefined, { duration: 3500 });
        } catch {
            this.snackBar.open('Could not add this Stalker source.', undefined, { duration: 5000 });
        }
    }

    private createStalkerPlaylist(result: StalkerTestResult): Playlist {
        const now = new Date().toISOString();
        return {
            _id: createRandomId(), title: result.candidate.portalUrl, count: 0,
            importDate: now, lastUsage: now, autoRefresh: false,
            portalUrl: result.candidate.portalUrl, macAddress: result.candidate.macAddress,
            isFullStalkerPortal: result.isFullStalkerPortal,
            stalkerToken: result.stalkerToken,
            stalkerWatchdogTimeout: result.watchdogTimeoutSeconds,
            stalkerTimeslot: result.timeslotSeconds,
            stalkerAccountInfo: result.accountInfo,
        };
    }

    private stalkerSourceKey(candidate: StalkerCredentialCandidate): string {
        return createStalkerCredentialKey(candidate.portalUrl, candidate.macAddress);
    }

    private existingStalkerSourceKeys(): Set<string> {
        return new Set(this.existingPlaylists().reduce<string[]>((keys, playlist) => {
            const portalUrl = playlist.portalUrl;
            const macAddress = playlist.macAddress;
            if (portalUrl && macAddress) {
                keys.push(createStalkerCredentialKey(portalUrl, macAddress));
            }
            return keys;
        }, []));
    }

    clear(): void {
        const batchId = this.activeBatchId;
        this.detachBatch();
        if (batchId) {
            void this.credentialTester.cancel(batchId).catch(() => undefined);
        }
        this.inputText = '';
        this.stalkerInputText = '';
        this.searchText = '';
        this.results.set([]);
        this.duplicates.set(0);
        this.invalidEntries.set([]);
        this.stalkerCandidates.set([]);
        this.stalkerInvalidEntries.set([]);
        this.stalkerResults.set([]);
        this.stalkerFilter.set('all');
        this.stalkerSearchText.set('');
        this.stalkerAbortController?.abort();
        this.stalkerAbortController = undefined;
        this.stalkerTesting.set(false);
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
        return candidate.serverUrl;
    }

    updateCandidateField(
        id: string,
        field: EditableCandidateField,
        value: string
    ): void {
        if (this.isTesting()) {
            return;
        }

        const trimmedValue = value.trim();
        this.results.update((results) =>
            results.map((result) => {
                if (result.id !== id) {
                    return result;
                }

                const candidate = result.candidate;
                const editedCandidate: BulkTestCandidate = {
                    ...candidate,
                    serverUrl:
                        field === 'source'
                            ? trimmedValue
                            : candidate.serverUrl,
                    username:
                        field === 'username'
                            ? trimmedValue
                            : candidate.username,
                    password:
                        field === 'password'
                            ? trimmedValue
                            : candidate.password,
                };

                return {
                    ...result,
                    candidate: {
                        ...editedCandidate,
                        normalizedKey: this.editedCandidateKey(editedCandidate),
                    },
                    status: 'pending',
                    message: 'Edited. Ready to test.',
                    selected: false,
                    responseTimeMs: undefined,
                    httpStatus: undefined,
                    accountStatus: undefined,
                    expiresAt: undefined,
                    activeConnections: undefined,
                    maxConnections: undefined,
                    liveCategoriesCount: undefined,
                    moviesCount: undefined,
                    seriesCount: undefined,
                    playlistChannelCount: undefined,
                    lastCheckedAt: undefined,
                };
            })
        );
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
        return {
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
                `xtream|${this.normalizeServerKey(playlist.serverUrl ?? '')}|${playlist.username ?? ''}|${playlist.password ?? ''}`
            )
        );
    }

    private sourceKey(candidate: BulkTestCandidate): string {
        return candidate.normalizedKey;
    }

    private editedCandidateKey(candidate: BulkTestCandidate): string {
        return `xtream|${this.normalizeServerKey(candidate.serverUrl)}|${candidate.username}|${candidate.password}`;
    }

    private normalizeServerKey(serverUrl: string): string {
        try {
            const parsed = new URL(serverUrl);
            return `${parsed.protocol}//${parsed.host}`.toLowerCase();
        } catch {
            return serverUrl.replace(/\/+$/, '').toLowerCase();
        }
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
