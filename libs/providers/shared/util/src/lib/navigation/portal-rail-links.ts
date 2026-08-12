export type PortalProvider = 'xtreams' | 'playlists' | 'stalker';
export type PortalRailSection =
    | 'all'
    | 'favorites'
    | 'groups'
    | 'itv'
    | 'library'
    | 'live'
    | 'recent'
    | 'recently-added'
    | 'radio'
    | 'search'
    | 'series'
    | 'vod';

export interface PortalRailLink {
    icon: string;
    tooltip: string;
    path: (string | number)[];
    exact?: boolean;
    section?: PortalRailSection;
}

interface BuildPortalRailLinksOptions {
    provider: PortalProvider;
    playlistId: string;
    workspace: boolean;
}

interface PortalRailLinkGroups {
    primary: PortalRailLink[];
    secondary: PortalRailLink[];
}

export function buildPortalRailLinks(
    options: BuildPortalRailLinksOptions
): PortalRailLinkGroups {
    const { provider, playlistId, workspace } = options;
    const root = workspace
        ? ['/workspace', provider, playlistId]
        : [`/${provider}`, playlistId];

    if (provider === 'xtreams') {
        const primary: PortalRailLink[] = [];
        const secondary: PortalRailLink[] = [];

        primary.push(
            {
                icon: 'movie',
                tooltip: 'Movies (this playlist)',
                path: [...root, 'vod'],
                section: 'vod',
            },
            {
                icon: 'live_tv',
                tooltip: 'Live TV (this playlist)',
                path: [...root, 'live'],
                section: 'live',
            },
            {
                icon: 'tv',
                tooltip: 'Series (this playlist)',
                path: [...root, 'series'],
                section: 'series',
            }
        );

        secondary.push(
            {
                icon: 'new_releases',
                tooltip: 'Recently added (this playlist)',
                path: [...root, 'recently-added'],
                section: 'recently-added',
            },
            {
                icon: 'search',
                tooltip: 'Search (this playlist)',
                path: [...root, 'search'],
                section: 'search',
            }
        );

        return { primary, secondary };
    }

    if (provider === 'playlists') {
        const primary: PortalRailLink[] = [
            {
                icon: 'tv',
                tooltip: 'All channels (this playlist)',
                path: [...root, 'all'],
                exact: true,
                section: 'all',
            },
            {
                icon: 'folder',
                tooltip: 'Groups (this playlist)',
                path: [...root, 'groups'],
                exact: true,
                section: 'groups',
            },
        ];

        return {
            primary,
            secondary: [],
        };
    }

    if (provider === 'stalker') {
        return {
            primary: [
                {
                    icon: 'movie',
                    tooltip: 'Movies (this portal)',
                    path: [...root, 'vod'],
                    section: 'vod',
                },
                {
                    icon: 'live_tv',
                    tooltip: 'Live TV (this portal)',
                    path: [...root, 'itv'],
                    exact: true,
                    section: 'itv',
                },
                {
                    icon: 'tv',
                    tooltip: 'Series (this portal)',
                    path: [...root, 'series'],
                    section: 'series',
                },
            ],
            secondary: [],
        };
    }

    return { primary: [], secondary: [] };
}
