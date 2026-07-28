import type {
    ElectronBridgeApi,
    ElectronBridgeDbOperationEvent,
    ElectronDownloadItem,
} from './libs/shared/interfaces/src/lib/electron-api.interface';

declare module 'iptv-playlist-parser' {
    export type ParsedPlaylist = any;
    export function parse(input: string): ParsedPlaylist;
    const _default: { parse: (input: string) => ParsedPlaylist };
    export default _default;
}

declare global {
    type ElectronDbOperationEvent = ElectronBridgeDbOperationEvent;

    interface Window {
        electron: ElectronBridgeApi;
        process: NodeJS.Process;
        require: NodeRequire;
    }

    /** Download item from the database */
    type DownloadItem = ElectronDownloadItem;
}

// SystemJS module definition
declare const nodeModule: NodeModule;
interface NodeModule {
    id: string;
}
