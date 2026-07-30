import { DestroyRef, Injectable, inject } from '@angular/core';
import { WorkspaceKeyboardHighlight } from './workspace-keyboard-highlight';
const GROUP_SELECTOR = [
    '.nav-list',
    '.scroll-viewport-portals',
    '.grid-list__grid',
    '.grid-container',
    '.results-grid',
    '.rail__track',
    '.items-grid',
    '.episodes-grid',
    '.actor-view__grid',
    '.details__similar-strip',
].join(',');
const ITEM_SELECTOR = [
    '.nav-item',
    '.channel-list-item',
    'mat-card',
    'app-content-card .content-card',
    'a.rail__card-link',
    'a.rail__channel-link',
    '.episode-card',
    '.episode-list-item',
    '.playlist-item',
    '.actor-view__card',
    '.details__similar-card',
].join(',');
const ACTIVE_SELECTOR =
    '.keyboard-browse-selected,.selected,.active,[aria-current="true"],[aria-selected="true"]';
const EDITING_SELECTOR =
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),' +
    '[role="textbox"],[role="combobox"],[role="dialog"],.cdk-overlay-container';
const BACK_SELECTOR =
    '.hero__back-button,.actor-view__back,.header-back,.settings-back-button';
type ArrowKey = 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp';
@Injectable()
export class WorkspaceKeyboardNavigationService {
    private readonly destroyRef = inject(DestroyRef);
    private readonly highlight: WorkspaceKeyboardHighlight | null;
    private selectedItem: HTMLElement | null = null;
    private activeGroup: HTMLElement | null = null;
    private readonly onClick = (event: MouseEvent): void => {
        this.clearSelection();
        const item = this.findItem(event.target);
        this.activeGroup = item?.closest<HTMLElement>(GROUP_SELECTOR) ?? null;
    };
    private readonly onFocusin = (event: FocusEvent): void => {
        const item = this.findItem(event.target);
        if (item) {
            this.selectedItem = item;
            this.activeGroup = item.closest<HTMLElement>(GROUP_SELECTOR);
        }
    };
    private readonly onKeydown = (event: KeyboardEvent): void => this.handleKeydown(event);

    constructor() {
        if (typeof document === 'undefined') {
            this.highlight = null;
            return;
        }
        this.highlight = new WorkspaceKeyboardHighlight();
        document.addEventListener('click', this.onClick, true);
        document.addEventListener('focusin', this.onFocusin);
        document.addEventListener('keydown', this.onKeydown, true);
        this.destroyRef.onDestroy(() => {
            document.removeEventListener('click', this.onClick, true);
            document.removeEventListener('focusin', this.onFocusin);
            document.removeEventListener('keydown', this.onKeydown, true);
            this.highlight?.destroy();
        });
    }

    private handleKeydown(event: KeyboardEvent): void {
        if (
            event.defaultPrevented ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            this.expandedPlayerOwnsKeyboard() ||
            this.isEditingContext(event.target)
        ) {
            return;
        }
        if (event.key === 'Tab') {
            this.handleTab(event);
            return;
        }
        if (event.key === 'Backspace') {
            const back = Array.from(
                document.querySelectorAll<HTMLElement>(BACK_SELECTOR)
            ).find((button) => this.isVisible(button));
            if (back) {
                event.preventDefault();
                this.clearSelection();
                back.click();
            }
            return;
        }

        if (event.key === ' ' || event.key === 'Enter') {
            const selected = this.resolveSelectedItem(event.target);
            if (!selected) {
                return;
            }
            event.preventDefault();
            selected.click();
            this.clearSelection();
            return;
        }

        if (!this.isArrowKey(event.key)) {
            return;
        }

        const group = this.resolveGroup(event.target);
        if (!group) {
            return;
        }
        const items = this.visibleItems(group);
        if (items.length === 0) {
            return;
        }

        event.preventDefault();
        const current = this.resolveCurrentItem(group, event.target, items);
        if (!current) {
            this.select(this.initialItem(items), true);
            return;
        }

        const next = this.findDirectionalItem(current, items, event.key);
        if (next) {
            this.select(next, true);
        }
    }

    private handleTab(event: KeyboardEvent): void {
        const groups = this.visibleGroups();
        if (groups.length === 0) {
            return;
        }

        const currentGroup = this.resolveGroup(event.target);
        const currentIndex = currentGroup ? groups.indexOf(currentGroup) : -1;
        const nextIndex = event.shiftKey
            ? currentIndex <= 0
                ? groups.length - 1
                : currentIndex - 1
            : currentIndex < 0 || currentIndex === groups.length - 1
              ? 0
              : currentIndex + 1;
        const items = this.visibleItems(groups[nextIndex]);
        if (items.length === 0) {
            return;
        }

        event.preventDefault();
        this.select(this.initialItem(items), true);
    }

    private resolveGroup(target: EventTarget | null): HTMLElement | null {
        const targetElement = target instanceof Element ? target : null;
        const targetGroup =
            targetElement?.closest<HTMLElement>(GROUP_SELECTOR) ?? null;
        if (targetGroup && this.isVisible(targetGroup)) {
            return targetGroup;
        }
        if (this.activeGroup?.isConnected && this.isVisible(this.activeGroup)) {
            return this.activeGroup;
        }

        const activeItem = Array.from(
            document.querySelectorAll<HTMLElement>(ACTIVE_SELECTOR)
        ).find(
            (item) =>
                item.matches(ITEM_SELECTOR) &&
                this.isFullyVisible(item) &&
                item.closest(GROUP_SELECTOR)
        );
        return (
            activeItem?.closest<HTMLElement>(GROUP_SELECTOR) ??
            this.visibleGroups()[0] ??
            null
        );
    }

    private resolveSelectedItem(
        target: EventTarget | null
    ): HTMLElement | null {
        const group = this.resolveGroup(target);
        if (!group) {
            return null;
        }
        return this.resolveCurrentItem(
            group,
            target,
            this.visibleItems(group)
        );
    }

    private resolveCurrentItem(
        group: HTMLElement,
        target: EventTarget | null,
        items: HTMLElement[]
    ): HTMLElement | null {
        if (
            this.selectedItem?.isConnected &&
            this.selectedItem.closest(GROUP_SELECTOR) === group &&
            items.includes(this.selectedItem)
        ) {
            return this.selectedItem;
        }
        const targetItem = this.findItem(target);
        if (targetItem && items.includes(targetItem)) {
            return targetItem;
        }
        return (
            items.find(
                (item) =>
                    item.matches(ACTIVE_SELECTOR) &&
                    this.isFullyVisible(item)
            ) ?? null
        );
    }

    private initialItem(items: HTMLElement[]): HTMLElement {
        return (
            items.find(
                (item) =>
                    item.matches(ACTIVE_SELECTOR) &&
                    this.isFullyVisible(item)
            ) ??
            items.find((item) => this.isFullyVisible(item)) ??
            items[0]
        );
    }

    private findDirectionalItem(
        current: HTMLElement,
        items: HTMLElement[],
        key: ArrowKey
    ): HTMLElement | null {
        const currentRect = current.getBoundingClientRect();
        const currentX = currentRect.left + currentRect.width / 2;
        const currentY = currentRect.top + currentRect.height / 2;
        let best: { item: HTMLElement; score: number } | null = null;

        for (const item of items) {
            if (item === current) {
                continue;
            }
            const rect = item.getBoundingClientRect();
            const deltaX = rect.left + rect.width / 2 - currentX;
            const deltaY = rect.top + rect.height / 2 - currentY;
            const primary =
                key === 'ArrowLeft'
                    ? -deltaX
                    : key === 'ArrowRight'
                      ? deltaX
                      : key === 'ArrowUp'
                        ? -deltaY
                        : deltaY;
            if (primary <= 1) {
                continue;
            }
            const secondary =
                key === 'ArrowLeft' || key === 'ArrowRight'
                    ? Math.abs(deltaY)
                    : Math.abs(deltaX);
            const score = primary * 1000 + secondary;
            if (!best || score < best.score) {
                best = { item, score };
            }
        }
        return best?.item ?? null;
    }

    private select(item: HTMLElement, focus: boolean): void {
        if (this.selectedItem !== item) {
            this.selectedItem?.classList.remove('keyboard-browse-selected');
            this.selectedItem = item;
            item.classList.add('keyboard-browse-selected');
        }
        this.activeGroup = item.closest<HTMLElement>(GROUP_SELECTOR);

        if (focus) {
            item.setAttribute('tabindex', '-1');
            item.focus({ preventScroll: true });
            this.scrollWithinGroup(item);
            this.highlight?.show(item);
        }
    }

    private clearSelection(): void {
        this.selectedItem?.classList.remove('keyboard-browse-selected');
        this.selectedItem = null;
        this.activeGroup = null;
        this.highlight?.hide();
    }
    private scrollWithinGroup(item: HTMLElement): void {
        const group = item.closest<HTMLElement>(GROUP_SELECTOR);
        if (!group) {
            return;
        }

        const container = this.findScrollContainer(group);
        const groupRect = container.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        if (itemRect.top < groupRect.top) {
            container.scrollTop += itemRect.top - groupRect.top;
        } else if (itemRect.bottom > groupRect.bottom) {
            container.scrollTop += itemRect.bottom - groupRect.bottom;
        }
        if (itemRect.left < groupRect.left) {
            container.scrollLeft += itemRect.left - groupRect.left;
        } else if (itemRect.right > groupRect.right) {
            container.scrollLeft += itemRect.right - groupRect.right;
        }
    }

    private findScrollContainer(group: HTMLElement): HTMLElement {
        let candidate: HTMLElement | null = group;
        while (candidate && candidate !== document.body) {
            const style = getComputedStyle(candidate);
            const canScrollY =
                /(auto|scroll)/.test(style.overflowY) &&
                candidate.scrollHeight > candidate.clientHeight;
            const canScrollX =
                /(auto|scroll)/.test(style.overflowX) &&
                candidate.scrollWidth > candidate.clientWidth;
            if (canScrollY || canScrollX) {
                return candidate;
            }
            candidate = candidate.parentElement;
        }
        return group;
    }

    private visibleGroups(): HTMLElement[] {
        return Array.from(
            document.querySelectorAll<HTMLElement>(GROUP_SELECTOR)
        ).filter(
            (group) =>
                !group.closest('.workspace-player--mini') &&
                this.isVisible(group) &&
                this.visibleItems(group).length > 0
        );
    }

    private visibleItems(group: HTMLElement): HTMLElement[] {
        return Array.from(
            group.querySelectorAll<HTMLElement>(ITEM_SELECTOR)
        ).filter(
            (item) =>
                this.isVisible(item) &&
                !item.matches('[disabled], [aria-disabled="true"]')
        );
    }

    private findItem(target: EventTarget | null): HTMLElement | null {
        if (!(target instanceof Element)) {
            return null;
        }
        const item = target.closest<HTMLElement>(ITEM_SELECTOR);
        return item && item.closest(GROUP_SELECTOR) ? item : null;
    }

    private isVisible(element: HTMLElement): boolean {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    }

    private isFullyVisible(element: HTMLElement): boolean {
        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= window.innerHeight &&
            rect.right <= window.innerWidth
        );
    }

    private expandedPlayerOwnsKeyboard(): boolean {
        return Boolean(document.querySelector('.workspace-player--expanded'));
    }

    private isEditingContext(target: EventTarget | null): boolean {
        return target instanceof Element && Boolean(target.closest(EDITING_SELECTOR));
    }

    private isArrowKey(key: string): key is ArrowKey {
        return ['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp'].includes(key);
    }
}
