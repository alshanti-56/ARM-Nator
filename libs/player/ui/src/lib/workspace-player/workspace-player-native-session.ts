import type { PlayerEngineTelemetry } from '../player-controls/player-controls.model';

/**
 * A native component emits one neutral snapshot before its requested backend
 * is configured. Do not mistake that backend-less startup snapshot for a real
 * embedded-player session.
 */
export function hasStartedNativeSession(
    engine: PlayerEngineTelemetry | undefined,
    backend: string
): boolean {
    return (
        engine?.engine === backend &&
        (Boolean(engine.sessionId) || engine.sessionStatus !== undefined)
    );
}
