import { on } from '@ngrx/store';
import { ChannelActions } from '../actions';
import { PlaylistState } from '../state';

export const channelReducers = [
    on(ChannelActions.setChannelsLoading, (state, action): PlaylistState => {
        return {
            ...state,
            channelsLoading: action.loading,
        };
    }),
    on(
        ChannelActions.setActiveChannelSuccess,
        (state, action): PlaylistState => {
            return {
                ...state,
                active: action.channel,
            };
        }
    ),
    on(ChannelActions.resetActiveChannel, (state): PlaylistState => {
        return {
            ...state,
            active: undefined,
        };
    }),
    on(ChannelActions.setChannels, (state, action): PlaylistState => {
        return {
            ...state,
            channelsLoading: false,
            channels: action.channels,
        };
    }),
];
