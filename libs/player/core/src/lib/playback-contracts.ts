import type { VideoPlayer } from "@arm-nator/shared/interfaces";

export type PlaybackStreamHint =
  | "auto"
  | "dash"
  | "file"
  | "hls"
  | "mpegts"
  | "unknown";

export type PlaybackLifecycle =
  | "idle"
  | "opening"
  | "buffering"
  | "playing"
  | "paused"
  | "stopped"
  | "ended"
  | "failed";

export interface PlaybackRequest {
  readonly url: string;
  readonly title?: string;
  readonly thumbnail?: string | null;
  readonly engine?: VideoPlayer;
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  readonly referer?: string;
  readonly origin?: string;
  readonly startTime?: number;
  readonly isLive?: boolean;
  readonly streamHint?: PlaybackStreamHint;
  readonly contentInfo?: unknown;
}

export interface PlaybackCapabilities {
  readonly pause: boolean;
  readonly seek: boolean;
  readonly speed: boolean;
  readonly subtitles: boolean;
  readonly audioTracks: boolean;
}

export interface PlaybackTrack {
  readonly id: string | number;
  readonly kind: "audio" | "subtitle" | "video";
  readonly label?: string;
  readonly language?: string;
  readonly codec?: string;
  readonly selected: boolean;
}

export interface PlaybackInformation {
  readonly engine: VideoPlayer;
  readonly lifecycle: PlaybackLifecycle;
  readonly sourceUrl: string;
  readonly resolvedUrl?: string;
  readonly title?: string;
  readonly isLive: boolean;
  readonly positionSeconds?: number;
  readonly durationSeconds?: number;
  readonly bufferedSeconds?: number;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
  readonly container?: string;
  readonly bitrate?: number;
  readonly droppedFrames?: number;
  readonly tracks?: readonly PlaybackTrack[];
  readonly capabilities: PlaybackCapabilities;
}

export type PlaybackDiagnosticLevel = "debug" | "info" | "warning" | "error";

export interface PlaybackDiagnosticEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly level: PlaybackDiagnosticLevel;
  readonly source:
    | "resolver"
    | "network"
    | "player"
    | "electron"
    | "native"
    | "ui";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface PlaybackSnapshot {
  readonly request: PlaybackRequest | null;
  readonly information: PlaybackInformation | null;
  readonly diagnostics: readonly PlaybackDiagnosticEvent[];
}

export type PlaybackCommand =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "stop" }
  | { readonly type: "seek"; readonly seconds: number }
  | { readonly type: "set-volume"; readonly volume: number }
  | { readonly type: "set-muted"; readonly muted: boolean }
  | { readonly type: "set-speed"; readonly speed: number }
  | { readonly type: "select-track"; readonly trackId: string | number };

export interface PlaybackObservability {
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  exportDiagnostics(): Promise<string>;
}

export interface PlaybackController {
  open(request: PlaybackRequest): Promise<void>;
  execute(command: PlaybackCommand): Promise<void>;
}
