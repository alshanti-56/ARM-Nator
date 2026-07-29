import { XtreamItem } from './xtream-item.interface';

export interface XtreamLiveStream extends XtreamItem {
    stream_type: 'live';
    tv_archive: number;
    tv_archive_duration: number;
}
