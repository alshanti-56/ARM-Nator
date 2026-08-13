import type { PlaylistMeta } from './playlist-meta.type';

export type PlaylistSourceType = 'xtream' | 'stalker';

type PlaylistSourceShape = Pick<
    PlaylistMeta,
    'serverUrl' | 'username' | 'password' | 'macAddress' | 'portalUrl'
>;

export function isStalkerPlaylist(
    playlist: PlaylistSourceShape | null | undefined
): boolean {
    return Boolean(playlist?.macAddress || playlist?.portalUrl);
}

export function getPlaylistSourceType(
    playlist: PlaylistSourceShape | null | undefined
): PlaylistSourceType {
    if (isStalkerPlaylist(playlist)) {
        return 'stalker';
    }

    if (
        playlist?.serverUrl ||
        (playlist?.username && playlist?.password)
    ) {
        return 'xtream';
    }

    return 'xtream';
}
