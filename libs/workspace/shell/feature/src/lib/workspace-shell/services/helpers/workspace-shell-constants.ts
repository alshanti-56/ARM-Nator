import { PortalRailSection } from '@arm-nator/providers/shared/util';

export const SEARCH_INPUT_DEBOUNCE_MS = 350;

export const SEARCH_PLAYLIST_PLACEHOLDER =
    'WORKSPACE.SHELL.SEARCH_PLAYLIST_PLACEHOLDER';
export const SEARCH_SECTION_PLACEHOLDER =
    'WORKSPACE.SHELL.SEARCH_SECTION_PLACEHOLDER';
export const FILTER_SECTION_PLACEHOLDER =
    'WORKSPACE.SHELL.FILTER_SECTION_PLACEHOLDER';
export const SEARCH_SOURCES_PLACEHOLDER =
    'WORKSPACE.SHELL.SEARCH_SOURCES_PLACEHOLDER';
export const SEARCH_LOADED_ONLY_STATUS =
    'WORKSPACE.SHELL.SEARCH_STATUS_LOADED_ONLY';

export const CLEAR_RECENTLY_VIEWED_TOOLTIP =
    'WORKSPACE.SHELL.CLEAR_RECENTLY_VIEWED_SECTION';
export const CLEAR_RECENTLY_VIEWED_ARIA =
    'WORKSPACE.SHELL.CLEAR_RECENTLY_VIEWED_SECTION_ARIA';

export const RAIL_TOOLTIP_KEYS: Readonly<
    Partial<Record<PortalRailSection, string>>
> = {
    vod: 'WORKSPACE.SHELL.RAIL_MOVIES',
    live: 'WORKSPACE.SHELL.RAIL_LIVE',
    itv: 'WORKSPACE.SHELL.RAIL_LIVE',
    radio: 'WORKSPACE.SHELL.RAIL_RADIO',
    series: 'WORKSPACE.SHELL.RAIL_SERIES',
    'recently-added': 'WORKSPACE.SHELL.RAIL_RECENTLY_ADDED',
    search: 'WORKSPACE.SHELL.RAIL_SEARCH',
    recent: 'WORKSPACE.SHELL.RAIL_RECENT',
    favorites: 'WORKSPACE.SHELL.RAIL_FAVORITES',
    all: 'WORKSPACE.SHELL.RAIL_ALL_CHANNELS',
    groups: 'WORKSPACE.SHELL.RAIL_GROUPS',
};

export type XtreamImportPhaseTone = 'remote' | 'local' | null;

export interface WorkspaceHeaderBulkAction {
    icon: string;
    tooltip: string;
    ariaLabel: string;
    disabled: boolean;
}
