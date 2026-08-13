import { Component, inject, output, signal } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { PlaylistActions } from '@arm-nator/providers/shared/playlist-state';
import {
    createRandomId,
    deriveStalkerDeviceIdsFromMac,
    hasInfomirMacOui,
    normalizeStalkerMacAddress,
    Playlist,
    validateStalkerMacAddressControl,
} from '@arm-nator/shared/interfaces';

@Component({
    selector: 'app-stalker-portal-import',
    standalone: true,
    imports: [FormsModule, ReactiveFormsModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, TranslatePipe],
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
    derivesDeviceIds = signal(false);
    showsForeignOuiHint = false;
    private derivationRequest = 0;

    get hasManualDeviceIds(): boolean {
        if (this.derivesDeviceIds()) {
            return false;
        }

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
    isLoading(): boolean { return false; }

    addPlaylist(): void {
        const normalizedMac = normalizeStalkerMacAddress(
            this.form.controls.macAddress.value
        );
        if (normalizedMac) {
            this.form.controls.macAddress.setValue(normalizedMac);
            this.showsForeignOuiHint = !hasInfomirMacOui(normalizedMac);
        }

        if (this.form.invalid) {
            this.form.markAllAsTouched();
            return;
        }
        const value = this.form.getRawValue();
        const playlist: Playlist = {
            _id: value._id,
            title: value.title,
            count: 0,
            importDate: new Date().toISOString(),
            lastUsage: new Date().toISOString(),
            autoRefresh: false,
            portalUrl: value.portalUrl,
            macAddress: value.macAddress,
            serialNumber: value.serialNumber,
            stalkerDeviceId1: value.deviceId1,
            stalkerDeviceId2: value.deviceId2,
            stalkerSignature1: value.signature1,
            stalkerSignature2: value.signature2,
        } as Playlist;
        this.store.dispatch(PlaylistActions.addPlaylist({ playlist }));
        this.addClicked.emit();
    }
}
