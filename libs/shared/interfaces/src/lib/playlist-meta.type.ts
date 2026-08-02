import { Playlist } from './playlist.interface';

export type PlaylistMeta = Pick<
    Playlist,
    | 'count'
    | 'title'
    | 'filename'
    | '_id'
    | 'url'
    | 'importDate'
    | 'userAgent'
    | 'referrer'
    | 'origin'
    | 'filePath'
    | 'updateDate'
    | 'updateState'
    | 'position'
    | 'autoRefresh'
    | 'favorites'
    | 'serverUrl'
    | 'username'
    | 'password'
    | 'macAddress'
    | 'hiddenGroupTitles'
    | 'portalUrl'
    | 'recentlyViewed'
>;
