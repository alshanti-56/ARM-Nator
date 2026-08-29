import {
    Directive,
    ElementRef,
    NgZone,
    OnDestroy,
    afterNextRender,
    inject,
    input,
    output,
} from '@angular/core';

const LOAD_THRESHOLD_PX = 320;

/** Emits when the host or document is scrolled close to its loaded content end. */
@Directive({
    selector: '[appInfiniteScroll]',
    standalone: true,
})
export class InfiniteScrollDirective implements OnDestroy {
    readonly infiniteHasMore = input(false);
    readonly infiniteItemCount = input(0);
    readonly infiniteResetKey = input<unknown>('');
    readonly infiniteLoadMore = output<void>();

    private readonly elementRef = inject(ElementRef<HTMLElement>);
    private readonly zone = inject(NgZone);
    private removeScrollListener: (() => void) | undefined;
    private lastRequestedItemCount = -1;
    private lastResetKey: unknown;

    constructor() {
        afterNextRender(() => {
            if (typeof window === 'undefined') return;
            const onScroll = () => this.checkThreshold();
            this.zone.runOutsideAngular(() => {
                window.addEventListener('scroll', onScroll, { passive: true });
                this.elementRef.nativeElement.addEventListener('scroll', onScroll, {
                    passive: true,
                });
            });
            this.removeScrollListener = () => {
                window.removeEventListener('scroll', onScroll);
                this.elementRef.nativeElement.removeEventListener('scroll', onScroll);
            };
        });
    }

    ngOnDestroy(): void {
        this.removeScrollListener?.();
    }

    private checkThreshold(): void {
        const resetKey = this.infiniteResetKey();
        if (resetKey !== this.lastResetKey) {
            this.lastResetKey = resetKey;
            this.lastRequestedItemCount = -1;
        }
        if (!this.infiniteHasMore()) return;
        const element = this.elementRef.nativeElement;
        const nearHostEnd =
            element.scrollHeight > element.clientHeight &&
            element.scrollTop + element.clientHeight >=
                element.scrollHeight - LOAD_THRESHOLD_PX;
        const nearDocumentEnd =
            window.scrollY + window.innerHeight >=
            document.documentElement.scrollHeight - LOAD_THRESHOLD_PX;
        if (!nearHostEnd && !nearDocumentEnd) return;

        const itemCount = this.infiniteItemCount();
        if (itemCount === this.lastRequestedItemCount) return;
        this.lastRequestedItemCount = itemCount;
        this.zone.run(() => this.infiniteLoadMore.emit());
    }
}
