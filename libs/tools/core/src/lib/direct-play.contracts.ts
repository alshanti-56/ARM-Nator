import type { PlaybackRequest } from "@arm-nator/player/core";

export interface DirectPlayInput extends PlaybackRequest {
  readonly rememberInHistory?: boolean;
}

export interface PlaybackUrlClipboardPayload {
  readonly originalUrl: string;
  readonly resolvedUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DirectPlayService {
  play(input: DirectPlayInput): Promise<void>;
  copyUrl(payload: PlaybackUrlClipboardPayload): Promise<void>;
}
