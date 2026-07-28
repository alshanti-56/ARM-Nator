import { BrowserWindow } from 'electron';
import {
    PORTAL_DEBUG_EVENT,
    PortalDebugEvent,
} from '@arm-nator/shared/interfaces';
import { redactSensitiveData } from '@arm-nator/shared/logging';
import { environment } from '../../environments/environment';

export function sanitizePortalDebugEvent(
    event: PortalDebugEvent
): PortalDebugEvent {
    return {
        ...event,
        request: redactSensitiveData(event.request),
        response: redactSensitiveData(event.response),
        error: redactSensitiveData(event.error),
    };
}

export function emitPortalDebugEvent(event: PortalDebugEvent): void {
    if (environment.production) {
        return;
    }

    const serializedEvent = sanitizePortalDebugEvent(event);
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
        window.webContents.send(PORTAL_DEBUG_EVENT, serializedEvent);
    }
}
