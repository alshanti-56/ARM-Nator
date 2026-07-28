import { ChannelActions } from '@arm-nator/providers/m3u/state';
import { Channel } from '@arm-nator/shared/interfaces';

export function createM3uChannelPlaybackRequest(channel: Channel) {
    return ChannelActions.setActiveChannel({
        channel,
        startPlayback: true,
    });
}
