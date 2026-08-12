import { Component, inject, output } from '@angular/core';
import { FormControl, FormGroup, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { PlaylistActions } from '@arm-nator/providers/m3u/state';
import { createRandomId, Playlist } from '@arm-nator/shared/interfaces';

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
        macAddress: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i)] }),
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
    derivesDeviceIds = () => false;
    hasManualDeviceIds = false;
    showsForeignOuiHint = false;
    onMacAddressBlur(): void {}
    toggleDeriveDeviceIds(_value: boolean): void {}
    isLoading(): boolean { return false; }

    addPlaylist(): void {
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
