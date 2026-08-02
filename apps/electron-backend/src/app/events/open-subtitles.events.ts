import { ipcMain } from 'electron';
import {
    OPEN_SUBTITLES_DOWNLOAD,
    OPEN_SUBTITLES_SEARCH,
    OPEN_SUBTITLES_CLEAR_CACHE,
    type OpenSubtitlesDownloadRequest,
    type OpenSubtitlesSearchRequest,
} from '@arm-nator/shared/interfaces';
import { openSubtitlesService } from '../services/open-subtitles.service';

export default class OpenSubtitlesEvents {
    static bootstrapOpenSubtitlesEvents(): Electron.IpcMain {
        return ipcMain;
    }
}

ipcMain.handle(
    OPEN_SUBTITLES_SEARCH,
    (_event, request: OpenSubtitlesSearchRequest) =>
        openSubtitlesService.search(request)
);

ipcMain.handle(
    OPEN_SUBTITLES_DOWNLOAD,
    (_event, request: OpenSubtitlesDownloadRequest) =>
        openSubtitlesService.download(request)
);

ipcMain.handle(OPEN_SUBTITLES_CLEAR_CACHE, () =>
    openSubtitlesService.clearCache()
);
