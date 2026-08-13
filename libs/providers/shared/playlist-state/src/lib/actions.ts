import { createActionGroup, emptyProps, props } from '@ngrx/store';
import { Channel, Playlist, PlaylistMeta } from '@arm-nator/shared/interfaces';

export const PlaylistActions = createActionGroup({
    source: 'Playlists',
    events: {
        'Load Playlists': emptyProps(),
        'Load Playlists Success': props<{ playlists: PlaylistMeta[] }>(),
        'Add Playlist': props<{ playlist: Playlist }>(),
        'Add Many Playlists': props<{ playlists: Playlist[] }>(),
        'Remove Playlist': props<{ playlistId: string }>(),
        'Update Playlist Meta': props<{ playlist: Partial<PlaylistMeta> }>(),
        'Update Playlist': props<{
            /**
             * Instrumentation-only; stripped before the DB invoke.
             * Never enters the DB worker payload or persisted playlist data.
             */
            operationId?: string;
            playlist: Playlist;
            playlistId: string;
        }>(),
        'Update Many Playlists': props<{ playlists: Playlist[] }>(),
        'Set Active Playlist': props<{ playlistId: string }>(),
        'Update Playlist Positions': props<{
            positionUpdates: { id: string; changes: { position: number } }[];
        }>(),
        'Remove All Playlists': emptyProps(),
    },
});

export const ChannelActions = createActionGroup({
    source: 'Channels',
    events: {
        'Set Channels Loading': props<{ loading: boolean }>(),
        'Set Channels': props<{ channels: Channel[] }>(),
        'Set Active Channel': props<{
            channel: Channel;
            startPlayback?: boolean;
        }>(),
        'Set Active Channel Success': props<{ channel: Channel }>(),
        'Reset Active Channel': emptyProps(),
        'Set Adjacent Channel As Active': props<{
            direction: 'next' | 'previous';
        }>(),
    },
});

export const FavoritesActions = createActionGroup({
    source: 'Favorites',
    events: {
        'Update Favorites': props<{ channel: Channel }>(),
        'Set Favorites': props<{ channelIds: string[] }>(),
        'Hydrate Favorites': props<{ channelIds: string[] }>(),
    },
});

export const FilterActions = createActionGroup({
    source: 'Filters',
    events: {
        'Set Selected Filters': props<{ selectedFilters: string[] }>(),
    },
});
