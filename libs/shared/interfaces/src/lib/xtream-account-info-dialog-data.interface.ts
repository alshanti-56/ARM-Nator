export interface XtreamAccountInfoDialogPlaylist {
    id: string;
    name?: string;
    title?: string;
    serverUrl: string;
    username: string;
    password: string;
}

export interface XtreamAccountInfoDialogData {
    vodStreamsCount?: number;
    liveStreamsCount?: number;
    seriesCount?: number;
    playlist?: XtreamAccountInfoDialogPlaylist;
}
