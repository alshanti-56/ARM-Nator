import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import {
    getKeyboardShortcutGroups,
    isKeyboardShortcutHelpTrigger,
    isTypingInInput,
} from '@arm-nator/providers/shared/util';
import { RuntimeCapabilitiesService } from '@arm-nator/services';
import {
    WorkspaceKeyboardShortcutsDialogComponent,
    WorkspaceKeyboardShortcutsDialogData,
} from './workspace-keyboard-shortcuts-dialog.component';

@Injectable()
export class WorkspaceKeyboardShortcutsService {
    private readonly dialog = inject(MatDialog);
    private readonly destroyRef = inject(DestroyRef);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly onDocumentKeydown = (event: KeyboardEvent): void =>
        this.handleKeydown(event);

    private dialogRef: MatDialogRef<
        WorkspaceKeyboardShortcutsDialogComponent,
        unknown
    > | null = null;

    constructor() {
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.onDocumentKeydown);
            this.destroyRef.onDestroy(() => {
                document.removeEventListener('keydown', this.onDocumentKeydown);
            });
        }
    }

    openShortcutsDialog(): void {
        if (this.dialogRef) {
            return;
        }

        const dialogRef = this.dialog.open<
            WorkspaceKeyboardShortcutsDialogComponent,
            WorkspaceKeyboardShortcutsDialogData
        >(WorkspaceKeyboardShortcutsDialogComponent, {
            width: 'min(960px, 94vw)',
            maxWidth: '94vw',
            panelClass: 'workspace-shortcuts-overlay',
            autoFocus: false,
            data: {
                groups: getKeyboardShortcutGroups({
                    isMac: true,
                    isElectron: this.runtime.isElectron,
                }),
                platformIcon: 'laptop_mac',
                platformLabelKey: 'WORKSPACE.SHORTCUTS.PLATFORM.MAC',
            },
        });

        this.dialogRef = dialogRef;
        dialogRef
            .afterClosed()
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => {
                this.dialogRef = null;
            });
    }

    private handleKeydown(event: KeyboardEvent): void {
        if (isTypingInInput(event) || !isKeyboardShortcutHelpTrigger(event)) {
            return;
        }

        event.preventDefault();
        this.openShortcutsDialog();
    }

}
