import { Component, inject, output, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { PlaylistActions } from '@arm-nator/providers/shared/playlist-state';
import {
    asStalkerPortalError,
    StalkerPortalDiscoveryService,
    stalkerSessionFingerprint,
} from '@arm-nator/providers/stalker/data-access';
import {
    createRandomId,
    deriveStalkerDeviceIdsFromMac,
    hasInfomirMacOui,
    isFullStalkerPortalUrl,
    normalizeStalkerMacAddress,
    normalizeStalkerPortalIdentity,
    Playlist,
    validateStalkerMacAddressControl,
} from '@arm-nator/shared/interfaces';
import {
    legacyTransformStalkerPortalUrl,
    normalizeStalkerPortalInputUrl,
} from '@arm-nator/providers/stalker/data-access';
import {
    STALKER_IMPORT_ERROR_KEY_BY_KIND,
    toStalkerPlaylistIdentityFields,
} from './stalker-import-identity';

type StalkerImportFormValue = {
    _id: string;
    title: string;
    portalUrl: string;
    macAddress: string;
    serialNumber: string;
    deviceId1: string;
    deviceId2: string;
    signature1: string;
    signature2: string;
    username: string;
    password: string;
    importDate: string;
    userAgent: string;
};

@Component({
    selector: 'app-stalker-portal-import',
    standalone: true,
    imports: [
        FormsModule,
        ReactiveFormsModule,
        MatButtonModule,
        MatCheckboxModule,
        MatFormFieldModule,
        MatInputModule,
        TranslatePipe,
    ],
    changeDetection: ChangeDetectionStrategy.Eager,
    templateUrl: './stalker-portal-import.component.html',
})
export class StalkerPortalImportComponent {
    readonly addClicked = output<void>();
    readonly form = new FormGroup({
        _id: new FormControl(createRandomId(), { nonNullable: true }),
        title: new FormControl('Stalker Portal', { nonNullable: true, validators: Validators.required }),
        portalUrl: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^https?:\/\/[^\s]+$/i)] }),
        macAddress: new FormControl('', {
            nonNullable: true,
            validators: [Validators.required, validateStalkerMacAddressControl],
        }),
        serialNumber: new FormControl('', { nonNullable: true }),
        deviceId1: new FormControl('', { nonNullable: true }),
        deviceId2: new FormControl('', { nonNullable: true }),
        signature1: new FormControl('', { nonNullable: true }),
        signature2: new FormControl('', { nonNullable: true }),
        username: new FormControl('', { nonNullable: true }),
        password: new FormControl('', { nonNullable: true }),
        importDate: new FormControl(new Date().toISOString(), { nonNullable: true }),
        userAgent: new FormControl('', { nonNullable: true }),
    });
    private readonly store = inject(Store);
    private readonly portalDiscovery = inject(StalkerPortalDiscoveryService);
    private readonly snackBar = inject(MatSnackBar);
    private readonly translate = inject(TranslateService);
    private readonly loading = signal(false);
    derivesDeviceIds = signal(false);
    advancedOpen = signal(false);
    showsForeignOuiHint = false;
    private derivationRequest = 0;

    constructor() {
        // Keep the hint in sync for keyboard/paste users who submit or
        // inspect validity without blurring the MAC field first.
        this.form.controls.macAddress.valueChanges.subscribe((value) => {
            const normalized = normalizeStalkerMacAddress(value);
            this.showsForeignOuiHint = Boolean(
                normalized && !hasInfomirMacOui(normalized),
            );
        });
    }

    get hasManualDeviceIds(): boolean {
        return Boolean(
            this.form.controls.deviceId1.value.trim() ||
                this.form.controls.deviceId2.value.trim()
        );
    }

    async onMacAddressBlur(): Promise<void> {
        const normalized = normalizeStalkerMacAddress(
            this.form.controls.macAddress.value
        );
        if (!normalized) {
            this.showsForeignOuiHint = false;
            return;
        }

        this.form.controls.macAddress.setValue(normalized);
        this.showsForeignOuiHint = !hasInfomirMacOui(normalized);

        if (this.derivesDeviceIds()) {
            await this.updateDerivedDeviceIds(normalized);
        }
    }

    async toggleDeriveDeviceIds(value: boolean): Promise<void> {
        if (this.loading()) {
            return;
        }

        this.derivesDeviceIds.set(value);
        this.derivationRequest += 1;

        if (!value) {
            this.form.controls.deviceId1.enable();
            this.form.controls.deviceId2.enable();
            this.form.patchValue({ deviceId1: '', deviceId2: '' });
            return;
        }

        await this.updateDerivedDeviceIds(
            normalizeStalkerMacAddress(this.form.controls.macAddress.value)
        );
    }

    private async updateDerivedDeviceIds(
        macAddress: string | null
    ): Promise<void> {
        const request = ++this.derivationRequest;
        const derived = await deriveStalkerDeviceIdsFromMac(macAddress);
        if (!this.derivesDeviceIds() || request !== this.derivationRequest) {
            return;
        }

        if (!derived) {
            this.form.controls.deviceId1.enable();
            this.form.controls.deviceId2.enable();
            this.form.patchValue({ deviceId1: '', deviceId2: '' });
            return;
        }

        this.form.patchValue(derived);
        this.form.controls.deviceId1.disable();
        this.form.controls.deviceId2.disable();
    }
    isLoading(): boolean {
        return this.loading();
    }

    /** Reset the form and release any derivation locks. */
    clearForm(): void {
        if (this.loading()) {
            return;
        }

        this.derivationRequest += 1;
        this.derivesDeviceIds.set(false);
        this.advancedOpen.set(false);
        this.form.enable({ emitEvent: false });
        this.form.reset({
            _id: createRandomId(),
            title: 'Stalker Portal',
            portalUrl: '',
            macAddress: '',
            serialNumber: '',
            deviceId1: '',
            deviceId2: '',
            signature1: '',
            signature2: '',
            username: '',
            password: '',
            importDate: new Date().toISOString(),
            userAgent: '',
        });
        this.showsForeignOuiHint = false;
    }

    addPlaylist(): Promise<void> {
        if (this.loading()) {
            return Promise.resolve();
        }

        const normalizedMac = normalizeStalkerMacAddress(
            this.form.controls.macAddress.value
        );
        if (normalizedMac) {
            this.form.controls.macAddress.setValue(normalizedMac);
            this.showsForeignOuiHint = !hasInfomirMacOui(normalizedMac);
        }

        if (!normalizedMac || this.form.invalid) {
            this.form.markAllAsTouched();
            return Promise.resolve();
        }

        // Snapshot synchronously before any async digest or portal request.
        // A MAC edit during submit must never be paired with the previous
        // MAC's device IDs — Stalker binds that pair permanently.
        const value = this.form.getRawValue();
        const submittedMac = normalizedMac;
        const submittedUrl = value.portalUrl.trim();
        const submittedIdentity = normalizeStalkerPortalIdentity({
            serialNumber: value.serialNumber,
            deviceId1: value.deviceId1,
            deviceId2: value.deviceId2,
            signature1: value.signature1,
            signature2: value.signature2,
        });
        const submittedCredentials = {
            username: value.username.trim(),
            password: value.password,
        };

        this.loading.set(true);
        this.form.disable({ emitEvent: false });

        return this.importPlaylist({
            value,
            submittedMac,
            submittedUrl,
            submittedIdentity,
            submittedCredentials,
        }).finally(() => {
            this.loading.set(false);
            this.form.enable({ emitEvent: false });
            if (this.derivesDeviceIds()) {
                this.form.controls.deviceId1.disable({ emitEvent: false });
                this.form.controls.deviceId2.disable({ emitEvent: false });
            }
        });
    }

    private async importPlaylist(input: {
        value: StalkerImportFormValue;
        submittedMac: string;
        submittedUrl: string;
        submittedIdentity: ReturnType<typeof normalizeStalkerPortalIdentity>;
        submittedCredentials: { username: string; password: string };
    }): Promise<void> {
        let identity = input.submittedIdentity;

        // Derive from the submitted MAC, not whatever the user may type while
        // the digest is pending. The snapshot above is the identity we send.
        if (this.derivesDeviceIds()) {
            const derived = await deriveStalkerDeviceIdsFromMac(
                input.submittedMac
            );
            if (derived) {
                identity = normalizeStalkerPortalIdentity({
                    ...identity,
                    ...derived,
                });
            }
        }

        let outcome;
        try {
            outcome = await this.portalDiscovery.discover(
                input.submittedUrl,
                input.submittedMac,
                identity,
                { credentials: input.submittedCredentials }
            );
        } catch (error) {
            this.showImportError(error);
            return;
        }

        if (
            outcome.status === 'auth-rejected' &&
            outcome.abandonedAuthenticationSettled
        ) {
            await outcome.abandonedAuthenticationSettled.catch(() => undefined);
        }

        if (outcome.status === 'auth-rejected') {
            this.showImportError(outcome.error);
            return;
        }

        const fallbackUrl = this.fallbackPortalUrl(input.submittedUrl);
        const portalUrl =
            outcome.status === 'resolved' ? outcome.portalUrl : fallbackUrl;
        const isFullPortal =
            outcome.status === 'resolved'
                ? outcome.isFullStalkerPortal
                : isFullStalkerPortalUrl(portalUrl);
        const identityFields = toStalkerPlaylistIdentityFields(identity);
        const playlist: Playlist = {
            _id: input.value._id,
            title: input.value.title.trim(),
            count: 0,
            importDate: new Date().toISOString(),
            lastUsage: new Date().toISOString(),
            autoRefresh: false,
            portalUrl,
            macAddress: input.submittedMac,
            username: input.submittedCredentials.username || undefined,
            password: input.submittedCredentials.password || undefined,
            isFullStalkerPortal: isFullPortal,
            ...identityFields,
        };

        if (outcome.status === 'resolved' && outcome.isFullStalkerPortal) {
            playlist.stalkerToken = outcome.token;
            playlist.stalkerWatchdogTimeout =
                outcome.watchdogTimeoutSeconds ?? 120;
            playlist.stalkerTimeslot = outcome.timeslotSeconds ?? 0;
            if (outcome.accountInfo) {
                playlist.stalkerAccountInfo = {
                    login: outcome.accountInfo.login,
                    expireDate: outcome.accountInfo.expire_date,
                    tariffPlanName: outcome.accountInfo.tariff_plan_name,
                    status: outcome.accountInfo.status,
                };
            }
            playlist.stalkerSessionIdentity = stalkerSessionFingerprint(
                playlist
            );
        }

        this.store.dispatch(PlaylistActions.addPlaylist({ playlist }));
        this.addClicked.emit();
    }

    private fallbackPortalUrl(rawUrl: string): string {
        const normalized = normalizeStalkerPortalInputUrl(rawUrl);
        return legacyTransformStalkerPortalUrl(normalized ?? rawUrl.trim());
    }

    private showImportError(error: unknown): void {
        const portalError = asStalkerPortalError(error);
        const kind = portalError?.kind ?? 'auth-failed';
        const headline = this.translate.instant(
            STALKER_IMPORT_ERROR_KEY_BY_KIND[kind]
        );
        const message = portalError?.portalText
            ? ` ${this.translate.instant('HOME.STALKER_PORTAL.PORTAL_MESSAGE')}`
            : '';
        this.snackBar.open(`${headline}${message}`, undefined, {
            duration: 6000,
        });
    }
}
