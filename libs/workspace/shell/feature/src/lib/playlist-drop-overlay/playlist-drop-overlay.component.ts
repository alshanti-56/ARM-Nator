import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';

export type PlaylistDropOverlayState =
    | { kind: 'idle' }
    | { kind: 'dragging' }
    | { kind: 'rejected'; reason: 'unsupported' | 'empty' | 'read-error' };

@Component({
    selector: 'app-playlist-drop-overlay',
    templateUrl: './playlist-drop-overlay.component.html',
    styleUrl: './playlist-drop-overlay.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [MatIcon, TranslatePipe],
    host: {
        '[class.is-visible]': 'isVisible()',
        '[attr.aria-hidden]': '!isVisible()',
    },
})
export class PlaylistDropOverlayComponent {
    readonly state = input<PlaylistDropOverlayState>({ kind: 'idle' });

    readonly isVisible = (): boolean => this.state().kind !== 'idle';

    readonly isRejected = (): boolean => this.state().kind === 'rejected';

    readonly rejectionKey = (): string => {
        const current = this.state();
        if (current.kind !== 'rejected') return '';
        switch (current.reason) {
            case 'unsupported':
                return 'WORKSPACE.SHELL.DROP_OVERLAY_REJECTED_UNSUPPORTED';
            case 'empty':
                return 'WORKSPACE.SHELL.DROP_OVERLAY_REJECTED_EMPTY';
            case 'read-error':
                return 'WORKSPACE.SHELL.DROP_OVERLAY_REJECTED_READ_ERROR';
        }
    };
}
