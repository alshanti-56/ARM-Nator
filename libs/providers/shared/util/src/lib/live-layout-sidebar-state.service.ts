import { computed, Injectable, signal } from '@angular/core';
import {
    LiveSidebarState,
    persistLiveSidebarState,
    restoreLiveSidebarState,
} from './live-sidebar-state';

/**
 * Shared collapse state for the live-TV sidebar across the workspace shell
 * categories rail (Xtream/Stalker), the inline channels rail, and the
 * unified-collection live tab. A single signal keeps all surfaces in sync
 * within a session; localStorage persistence is delegated to the existing
 * `live-sidebar-state` helpers so the storage key stays unchanged.
 */
@Injectable({ providedIn: 'root' })
export class LiveLayoutSidebarStateService {
    private readonly _state = signal<LiveSidebarState>(
        restoreLiveSidebarState()
    );
    readonly state = this._state.asReadonly();
    readonly isCollapsed = computed(() => this._state() === 'collapsed');

    toggle(): void {
        this.setState(this.isCollapsed() ? 'expanded' : 'collapsed');
    }

    setState(state: LiveSidebarState): void {
        this._state.set(state);
        persistLiveSidebarState(state);
    }
}
