import { Injectable, inject } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';

/** Inactive unless the packaged app is launched with ARM_NATOR_PERF_CAPTURE. */
@Injectable({ providedIn: 'root' })
export class UiPerformanceService {
    private readonly router = inject(Router);
    private startedAt = performance.timeOrigin;
    private generation = 0;
    constructor() {
        if (!window.electron?.performanceCaptureEnabled) return;
        this.router.events.subscribe(event => {
            if (event instanceof NavigationStart) {
                this.startedAt = performance.timeOrigin + performance.now();
                this.generation++;
            }
        });
    }
    painted(name: 'dashboard' | 'category' | 'search', startedAt = this.startedAt): void {
        if (!window.electron?.performanceCaptureEnabled) return;
        const generation = ++this.generation;
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (generation !== this.generation) return;
            window.electron.reportUiPerformance?.({ name, startedAt, paintedAt: performance.timeOrigin + performance.now() });
        }));
    }
}
