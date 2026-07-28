export type LiveEpgPanelState = 'expanded' | 'collapsed';

export const LIVE_EPG_PANEL_STATE_STORAGE_KEY = 'live-epg-panel-state';
export const DEFAULT_LIVE_EPG_PANEL_STATE: LiveEpgPanelState = 'expanded';

export function isLiveEpgPanelState(
    value: unknown
): value is LiveEpgPanelState {
    return value === 'expanded' || value === 'collapsed';
}

export function restoreLiveEpgPanelState(
    storageKey: string = LIVE_EPG_PANEL_STATE_STORAGE_KEY,
    fallback: LiveEpgPanelState = DEFAULT_LIVE_EPG_PANEL_STATE
): LiveEpgPanelState {
    const storedValue = localStorage.getItem(storageKey);
    return isLiveEpgPanelState(storedValue) ? storedValue : fallback;
}

export function persistLiveEpgPanelState(
    state: LiveEpgPanelState,
    storageKey: string = LIVE_EPG_PANEL_STATE_STORAGE_KEY
): void {
    localStorage.setItem(storageKey, state);
}
