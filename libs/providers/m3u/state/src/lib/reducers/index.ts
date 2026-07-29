import { createReducer } from '@ngrx/store';
import { initialState, PlaylistState } from '../state';
import { channelReducers } from './channel.reducers';
import { favoritesReducers } from './favorites.reducers';
import { filterReducers } from './filter.reducers';
import { playlistReducers } from './playlist.reducers';

export const playlistReducer = createReducer(
    initialState,
    ...channelReducers,
    ...playlistReducers,
    ...favoritesReducers,
    ...filterReducers
);

// Selectors
export const selectPlaylists = (state: PlaylistState) => state.playlists;
export const selectPlaylistId = (state: PlaylistState) =>
    state.playlists?.selectedId;

export const selectActiveReducer = (state: PlaylistState) => state.active;
export const selectChannelsLoadingReducer = (state: PlaylistState) =>
    state.channelsLoading;
export const selectChannelsReducer = (state: PlaylistState) => state.channels;
export const selectPlaylistsLoadingFlagReducer = (state: PlaylistState) =>
    state.playlists?.allPlaylistsLoaded;
