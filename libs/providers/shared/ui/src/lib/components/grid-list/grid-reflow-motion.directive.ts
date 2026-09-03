import {
  AfterViewInit,
  Directive,
  ElementRef,
  OnDestroy,
  inject,
} from "@angular/core";

const GRID_REFLOW_DURATION_MS = 520;
const GRID_REFLOW_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const GRID_REFLOW_STAGGER_MS = 10;
const GRID_REFLOW_MAX_STAGGER_MS = 70;

interface CardLayoutPosition {
  readonly left: number;
  readonly top: number;
}

/** Animates cards into their new positions when a responsive grid reflows. */
@Directive({
  selector: "[gridReflowMotion]",
  standalone: true,
})
export class GridReflowMotionDirective implements AfterViewInit, OnDestroy {
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private gridResizeObserver?: ResizeObserver;
  private readonly previousCardPositions = new Map<
    string,
    CardLayoutPosition
  >();
  private readonly activeCardAnimations = new Map<string, Animation>();
  private previousColumnCount = 0;

  ngAfterViewInit(): void {
    const grid = this.elementRef.nativeElement;
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    this.gridResizeObserver = new ResizeObserver(() =>
      this.animateCardReflow(grid),
    );
    this.gridResizeObserver.observe(grid);
  }

  ngOnDestroy(): void {
    this.gridResizeObserver?.disconnect();
    for (const animation of this.activeCardAnimations.values()) {
      animation.cancel();
    }
    this.activeCardAnimations.clear();
    this.previousCardPositions.clear();
  }

  private animateCardReflow(grid: HTMLElement): void {
    const cards = Array.from(
      grid.querySelectorAll<HTMLElement>("[data-grid-card]"),
    );
    if (grid.offsetWidth <= 0 || cards.length === 0) {
      return;
    }

    const nextPositions = new Map<string, CardLayoutPosition>();

    for (const card of cards) {
      const key = card.dataset["gridKey"];
      if (key && card.offsetWidth > 0 && card.offsetHeight > 0) {
        nextPositions.set(key, {
          left: card.offsetLeft,
          top: card.offsetTop,
        });
      }
    }

    if (nextPositions.size === 0) {
      return;
    }

    const nextColumnCount = this.resolveColumnCount(nextPositions);
    const didColumnsChange =
      this.previousColumnCount > 0 &&
      nextColumnCount > 0 &&
      nextColumnCount !== this.previousColumnCount;

    if (
      didColumnsChange &&
      this.previousCardPositions.size > 0 &&
      !this.prefersReducedMotion()
    ) {
      let animatedCardIndex = 0;
      for (const card of cards) {
        const key = card.dataset["gridKey"];
        const previousPosition = key
          ? this.previousCardPositions.get(key)
          : undefined;
        const nextPosition = key ? nextPositions.get(key) : undefined;
        if (
          !key ||
          !previousPosition ||
          !nextPosition ||
          !this.isNearViewport(card, grid) ||
          typeof card.animate !== "function"
        ) {
          continue;
        }

        const deltaX = previousPosition.left - nextPosition.left;
        const deltaY = previousPosition.top - nextPosition.top;
        if (Math.hypot(deltaX, deltaY) < 1) {
          continue;
        }

        this.activeCardAnimations.get(key)?.cancel();
        const animation = card.animate(
          [
            {
              transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(0.99)`,
            },
            {
              transform: "translate3d(0, 0, 0) scale(1)",
            },
          ],
          {
            delay: Math.min(
              animatedCardIndex * GRID_REFLOW_STAGGER_MS,
              GRID_REFLOW_MAX_STAGGER_MS,
            ),
            duration: GRID_REFLOW_DURATION_MS,
            easing: GRID_REFLOW_EASING,
          },
        );
        animatedCardIndex += 1;
        animation.addEventListener("finish", () => {
          if (this.activeCardAnimations.get(key) === animation) {
            this.activeCardAnimations.delete(key);
          }
        });
        this.activeCardAnimations.set(key, animation);
      }
    }

    this.previousColumnCount = nextColumnCount;
    this.previousCardPositions.clear();
    for (const [key, position] of nextPositions) {
      this.previousCardPositions.set(key, position);
    }
  }

  private resolveColumnCount(
    positions: ReadonlyMap<string, CardLayoutPosition>,
  ): number {
    const firstPosition = positions.values().next().value;
    if (!firstPosition) {
      return 0;
    }

    let columnCount = 0;
    for (const position of positions.values()) {
      if (Math.abs(position.top - firstPosition.top) < 1) {
        columnCount += 1;
      }
    }
    return columnCount;
  }

  private isNearViewport(card: HTMLElement, grid: HTMLElement): boolean {
    const viewport = grid.parentElement?.getBoundingClientRect();
    if (!viewport) {
      return true;
    }

    const rect = card.getBoundingClientRect();
    return (
      rect.bottom >= viewport.top - rect.height && rect.top <= viewport.bottom
    );
  }

  private prefersReducedMotion(): boolean {
    return (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
    );
  }
}
