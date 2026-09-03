export type PortalProvider = 'xtreams' | 'stalker';
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
                icon: 'arm_open_slate_reel',
                tooltip: 'Movies (this playlist)',
                path: [...root, 'vod'],
                section: 'vod',
            },
            {
                icon: 'satellite_alt',
                tooltip: 'Live TV (this playlist)',
                path: [...root, 'live'],
                section: 'live',
            },
            {
                icon: 'subscriptions',
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

    if (provider === 'stalker') {
        return {
            primary: [
                {
                    icon: 'arm_open_slate_reel',
                    tooltip: 'Movies (this portal)',
                    path: [...root, 'vod'],
                    section: 'vod',
                },
                {
                    icon: 'satellite_alt',
                    tooltip: 'Live TV (this portal)',
                    path: [...root, 'itv'],
                    exact: true,
                    section: 'itv',
                },
                {
                    icon: 'subscriptions',
                    tooltip: 'Series (this portal)',
                    path: [...root, 'series'],
                    section: 'series',
                },
            ],
            secondary: [
                {
                    icon: 'new_releases',
                    tooltip: 'Recently added (this portal)',
                    path: [...root, 'recently-added'],
                    section: 'recently-added',
                },
                {
                    icon: 'search',
                    tooltip: 'Search (this portal)',
                    path: [...root, 'search'],
                    section: 'search',
                },
            ],
        };
    }

    return { primary: [], secondary: [] };
}
