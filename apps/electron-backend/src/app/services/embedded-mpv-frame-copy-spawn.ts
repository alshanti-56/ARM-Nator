import { EmbeddedMpvBounds } from '@arm-nator/shared/interfaces';

export interface FrameCopyHelperSpawnRequest {
    bounds: EmbeddedMpvBounds;
    helperPath: string;
    initialVolume?: number;
    scale: number;
    sessionId: string;
}

export interface FrameCopyHelperSpawnPlan {
    args: string[];
    command: string;
    height: number;
    width: number;
}

export function resolveFrameCopyHelperSpawn(
    request: FrameCopyHelperSpawnRequest
): FrameCopyHelperSpawnPlan {
    const width = Math.max(
        16,
        Math.round(request.bounds.width * request.scale)
    );
    const height = Math.max(
        16,
        Math.round(request.bounds.height * request.scale)
    );
    return {
        command: request.helperPath,
        width,
        height,
        args: [
            '--shm-base',
            `/${request.sessionId}`,
            '--width',
            String(width),
            '--height',
            String(height),
            '--volume',
            String(
                Math.min(Math.max(request.initialVolume ?? 1, 0), 1)
            ),
            ...(process.env.ARM_NATOR_EMBEDDED_MPV_AUDIO_DELAY
                ? [
                      '--audio-delay',
                      process.env.ARM_NATOR_EMBEDDED_MPV_AUDIO_DELAY,
                  ]
                : []),
        ],
    };
}
