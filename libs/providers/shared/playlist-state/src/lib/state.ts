import { Channel } from '@arm-nator/shared/interfaces';
import { initialPlaylistMetaState, PlaylistMetaState } from './playlists.state';

export interface PlaylistState {
    active: Channel | undefined;
    channelsLoading: boolean;
    channels: Channel[]; // TODO: use entity store
    playlists: PlaylistMetaState;
}

export const initialState: PlaylistState = {
    active: undefined,
    channelsLoading: false,
    channels: [],
    playlists: initialPlaylistMetaState,
};
