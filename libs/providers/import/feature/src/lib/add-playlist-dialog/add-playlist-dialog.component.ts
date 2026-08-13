import {
    Component,
    computed,
    inject,
    signal,
    ViewEncapsulation,
    viewChild,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
    MAT_DIALOG_DATA,
    MatDialogModule,
    MatDialogRef,
} from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { XtreamCodeImportComponent } from '../xtream-code-import/xtream-code-import.component';
import { StalkerPortalImportComponent } from '../stalker-portal-import/stalker-portal-import.component';

/**
 * The source dialog only exposes the supported portal types.
 */
export interface PlaylistMethodOption {
    value: 'xtream' | 'stalker';
    icon: string;
    labelKey: string;
    subKey: string;
}

type AddPlaylistMethod = 'xtream' | 'stalker';

@Component({
    imports: [
        MatButtonModule,
        MatDialogModule,
        MatIcon,
        TranslateModule,
        XtreamCodeImportComponent,
        StalkerPortalImportComponent,
    ],
    selector: 'app-add-playlist',
    templateUrl: './add-playlist-dialog.component.html',
    styleUrl: './add-playlist-dialog.component.scss',
    encapsulation: ViewEncapsulation.None,
})
export class AddPlaylistDialogComponent {
    private dialogRef = inject(MatDialogRef<AddPlaylistDialogComponent>);
    private data = inject<{ type?: AddPlaylistMethod } | null>(MAT_DIALOG_DATA, {
        optional: true,
    });

    readonly xtreamImport = viewChild(XtreamCodeImportComponent);
    readonly stalkerImport = viewChild(StalkerPortalImportComponent);

    readonly method = signal<AddPlaylistMethod>('xtream');

    readonly methodOptions: PlaylistMethodOption[] = [
        {
            value: 'xtream',
            icon: 'vpn_key',
            labelKey: 'HOME.ADD_PLAYLIST.METHOD_XTREAM_LABEL',
            subKey: 'HOME.ADD_PLAYLIST.METHOD_XTREAM_SUB',
        },
        {
            value: 'stalker',
            icon: 'router',
            labelKey: 'HOME.STALKER_PORTAL.TITLE',
            subKey: 'HOME.STALKER_PORTAL.URL_HINT',
        },
    ];

    /**
     * Backwards-compatible alias. The template's @switch and the action
     * buttons key off this; keeping the name avoids churn in 5 case branches.
     */
    readonly playlistType = computed<AddPlaylistMethod>(() => this.method());

    constructor() {
        if (this.data?.type) {
            this.method.set(this.data.type);
        }
    }

    clearCurrentForm(): void {
        switch (this.playlistType()) {
            case 'xtream':
                this.xtreamImport()?.clearForm();
                break;
            case 'stalker':
                this.stalkerImport()?.form.reset();
                break;
        }
    }

    isClearDisabled(): boolean {
        switch (this.playlistType()) {
            case 'xtream':
                return !!this.xtreamImport()?.isTestingConnection;
            case 'stalker':
                return !!this.stalkerImport()?.isLoading();
            default:
                return false;
        }
    }

    closeDialog(): void {
        this.dialogRef.close();
    }

}
