import { Injectable, inject, signal } from '@angular/core';
import { OverlayContainer } from '@angular/cdk/overlay';
import { MatDialog } from '@angular/material/dialog';

@Injectable({ providedIn: 'root' })
export class EmbeddedMpvOverlayVisibilityService {
    readonly overlayActive = signal(false);

    private readonly overlayContainer = inject(OverlayContainer);
    private readonly dialog = inject(MatDialog);
    private observer: MutationObserver | null = null;

    constructor() {
        this.dialog.afterOpened.subscribe(() => this.recompute());
        this.dialog.afterAllClosed.subscribe(() => this.recompute());

        if (typeof MutationObserver !== 'undefined') {
            const container = this.overlayContainer.getContainerElement();
            this.observer = new MutationObserver(() => this.recompute());
            this.observer.observe(container, {
                childList: true,
                subtree: true,
            });
        }

        this.recompute();
    }

    private recompute(): void {
        const dialogOpen = this.dialog.openDialogs.length > 0;
        const backdropPresent =
            this.overlayContainer
                .getContainerElement()
                .querySelector('.cdk-overlay-backdrop') !== null;
        const next = dialogOpen || backdropPresent;
        if (this.overlayActive() !== next) {
            this.overlayActive.set(next);
        }
    }
}
