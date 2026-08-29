import type {
    ElectronBridgeApi,
    ElectronBridgeDbOperationEvent,
} from './libs/shared/interfaces/src/lib/electron-api.interface';


declare global {
    type ElectronDbOperationEvent = ElectronBridgeDbOperationEvent;

    interface Window {
        electron: ElectronBridgeApi;
        process: NodeJS.Process;
        require: NodeRequire;
    }

}

// SystemJS module definition
declare const nodeModule: NodeModule;
interface NodeModule {
    id: string;
}
