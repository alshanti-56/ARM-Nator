import {
    AfterViewInit,
    ChangeDetectionStrategy,
    Component,
    ElementRef,
    OnDestroy,
    computed,
    inject,
    signal,
    viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import type {
    BrowserViewCommand,
    BrowserViewBounds,
    BrowserViewMode,
    BrowserViewState,
} from '@arm-nator/shared/interfaces';

@Component({
    selector: 'app-browser-page',
    imports: [
        FormsModule,
        MatButtonModule,
        MatIconModule,
        MatTooltipModule,
        TranslatePipe,
    ],
    templateUrl: './browser-page.component.html',
    styleUrl: './browser-page.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowserPageComponent implements AfterViewInit, OnDestroy {
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly viewport = viewChild<ElementRef<HTMLElement>>('browserViewport');
    private resizeObserver: ResizeObserver | null = null;
    private unsubscribe: (() => void) | null = null;
    private lastBounds = '';
    private openAttempt = 0;
    private openTimeout: ReturnType<typeof setTimeout> | null = null;

    readonly mode = (this.route.snapshot.data['browserMode'] ?? 'browser') as BrowserViewMode;
    readonly state = signal<BrowserViewState | null>(null);
    readonly browserViewAvailable = signal(true);
    readonly address = signal('');
    readonly requestError = signal('');
    readonly isYouTube = computed(() => this.mode === 'youtube');
    readonly titleKey = computed(() =>
        this.isYouTube() ? 'BROWSER.YOUTUBE_TITLE' : 'BROWSER.TITLE'
    );
    readonly subtitleKey = computed(() =>
        this.isYouTube() ? 'BROWSER.YOUTUBE_SUBTITLE' : 'BROWSER.SUBTITLE'
    );

    ngAfterViewInit(): void {
        const viewport = this.viewport()?.nativeElement;
        if (!viewport) {
            return;
        }

        if (!this.supportsBrowserView()) {
            this.browserViewAvailable.set(false);
            this.requestError.set(
                'The in-app browser is available in the Electron desktop app.'
            );
            return;
        }

        this.unsubscribe = window.electron.onBrowserViewUpdate((state) => {
            const wasMini = this.state()?.displayMode === 'mini';
            this.state.set(state);
            this.address.set(state.url);
            this.requestError.set(state.error ?? '');
            if (this.isYouTube() && state.status === 'closed') {
                void this.router.navigateByUrl('/workspace/dashboard');
                return;
            }
            if (state.displayMode === 'mini') {
                this.lastBounds = '';
            } else if (wasMini) {
                this.syncBounds(viewport);
            }
        });
        this.resizeObserver = new ResizeObserver(() => this.syncBounds(viewport));
        this.resizeObserver.observe(viewport);
        window.addEventListener('resize', this.handleWindowResize);
        this.syncBounds(viewport);
        void this.open();
    }

    ngOnDestroy(): void {
        this.openAttempt += 1;
        if (this.openTimeout) {
            clearTimeout(this.openTimeout);
            this.openTimeout = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        window.removeEventListener('resize', this.handleWindowResize);
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.supportsBrowserView()) {
            void window.electron.closeBrowserView(this.mode);
        }
    }

    navigate(): void {
        const value = this.address().trim();
        if (!value) {
            return;
        }
        this.requestError.set('');
        void this.execute({ type: 'navigate', url: value });
    }

    goBack(): void {
        void this.execute({ type: 'back' });
    }

    goForward(): void {
        void this.execute({ type: 'forward' });
    }

    reload(): void {
        void this.execute({ type: 'reload' });
    }

    retryOpen(): void {
        void this.open();
    }

    stop(): void {
        void this.execute({ type: 'stop' });
    }

    private readonly handleWindowResize = (): void => {
        const viewport = this.viewport()?.nativeElement;
        if (viewport) {
            this.syncBounds(viewport);
        }
    };

    private async open(): Promise<void> {
        if (!this.supportsBrowserView()) {
            this.browserViewAvailable.set(false);
            this.requestError.set(
                'The in-app browser is available in the Electron desktop app.'
            );
            return;
        }

        const attempt = ++this.openAttempt;
        this.requestError.set('');
        this.state.set(null);

        const timeout = new Promise<never>((_, reject) => {
            this.openTimeout = setTimeout(() => {
                reject(new Error('The browser did not respond. Try again.'));
            }, 8000);
        });

        try {
            const state = await Promise.race([
                window.electron.openBrowserView(this.mode),
                timeout,
            ]);
            if (attempt !== this.openAttempt) {
                return;
            }
            this.state.set(state);
            this.address.set(state.url);
            this.requestError.set(state.error ?? '');
            const viewport = this.viewport()?.nativeElement;
            if (viewport) {
                this.syncBounds(viewport);
            }
        } catch (error) {
            if (attempt !== this.openAttempt) {
                return;
            }
            this.requestError.set(
                error instanceof Error
                    ? error.message
                    : 'The browser could not be opened. Try again.'
            );
        } finally {
            if (attempt === this.openAttempt && this.openTimeout) {
                clearTimeout(this.openTimeout);
                this.openTimeout = null;
            }
        }
    }

    private async execute(command: BrowserViewCommand): Promise<void> {
        try {
            const state = await window.electron.executeBrowserCommand(command);
            if (state) {
                this.state.set(state);
                if (state.url) {
                    this.address.set(state.url);
                }
                this.requestError.set(state.error ?? '');
            }
        } catch (error) {
            this.requestError.set(
                error instanceof Error ? error.message : 'Browser action failed.'
            );
        }
    }

    private syncBounds(viewport: HTMLElement): void {
        if (typeof window.electron?.setBrowserViewBounds !== 'function') {
            return;
        }
        if (this.state()?.displayMode === 'mini' || this.state()?.isFullscreen) {
            return;
        }
        const rect = viewport.getBoundingClientRect();
        const bounds: BrowserViewBounds = {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        };
        const key = Object.values(bounds).join(',');
        if (key === this.lastBounds) {
            return;
        }
        this.lastBounds = key;
        void window.electron.setBrowserViewBounds(bounds);
    }

    private supportsBrowserView(): boolean {
        return (
            window.electron?.platform !== 'web' &&
            typeof window.electron?.openBrowserView === 'function' &&
            typeof window.electron?.setBrowserViewBounds === 'function'
        );
    }
}
