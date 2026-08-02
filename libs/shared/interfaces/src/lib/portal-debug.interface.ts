export type PortalDebugProvider = 'xtream';

export type PortalDebugTransport =
    | 'electron-main'
    | 'electron-renderer';

export type PortalDebugStatus = 'success' | 'error';

export interface PortalDebugEvent {
    requestId: string;
    provider: PortalDebugProvider;
    operation: string;
    transport: PortalDebugTransport;
    startedAt: string;
    durationMs: number;
    status: PortalDebugStatus;
    request: unknown;
    response?: unknown;
    error?: unknown;
}
