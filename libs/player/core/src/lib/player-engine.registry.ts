import { VideoPlayer } from "@arm-nator/shared/interfaces";

export type PlayerEngineKind =
  "web" | "embedded-native" | "ksplayer-metal" | "managed-external";

export interface PlayerRuntimeCapabilities {
  readonly supportsEmbeddedMpv: boolean;
  readonly supportsKsPlayerMetal: boolean;
  readonly supportsManagedExternalPlayers: boolean;
}

export interface PlayerEngineDescriptor {
  readonly id: VideoPlayer;
  readonly kind: PlayerEngineKind;
  readonly labelKey: string;
  readonly priority: number;
}

export const PLAYER_ENGINES: readonly PlayerEngineDescriptor[] = [
  {
    id: VideoPlayer.ArtPlayer,
    kind: "web",
    labelKey: "SETTINGS.PLAYER_ARTPLAYER",
    priority: 10,
  },
  {
    id: VideoPlayer.ArtPlayer2,
    kind: "web",
    labelKey: "SETTINGS.PLAYER_ARTPLAYER2",
    priority: 15,
  },
  {
    id: VideoPlayer.Html5Player,
    kind: "web",
    labelKey: "SETTINGS.PLAYER_HTML5",
    priority: 20,
  },
  {
    id: VideoPlayer.EmbeddedMpv,
    kind: "embedded-native",
    labelKey: "SETTINGS.PLAYER_EMBEDDED_MPV",
    priority: 30,
  },
  {
    id: VideoPlayer.KsPlayer,
    kind: "ksplayer-metal",
    labelKey: "SETTINGS.PLAYER_KSPLAYER",
    priority: 35,
  },
  {
    id: VideoPlayer.MPV,
    kind: "managed-external",
    labelKey: "SETTINGS.PLAYER_MPV",
    priority: 40,
  },
  {
    id: VideoPlayer.VLC,
    kind: "managed-external",
    labelKey: "SETTINGS.PLAYER_VLC",
    priority: 50,
  },
] as const;

const ENGINE_BY_ID = new Map(
  PLAYER_ENGINES.map((engine) => [engine.id, engine] as const),
);

export function getPlayerEngine(player: VideoPlayer): PlayerEngineDescriptor {
  return ENGINE_BY_ID.get(player) ?? PLAYER_ENGINES[0];
}

export function getAvailablePlayerEngines(
  capabilities: PlayerRuntimeCapabilities,
): readonly PlayerEngineDescriptor[] {
  return PLAYER_ENGINES.filter((engine) => {
    switch (engine.kind) {
      case "embedded-native":
        return capabilities.supportsEmbeddedMpv;
      case "ksplayer-metal":
        return capabilities.supportsKsPlayerMetal;
      case "managed-external":
        return capabilities.supportsManagedExternalPlayers;
      case "web":
        return true;
    }
  });
}

export function isWebPlayer(player: VideoPlayer): boolean {
  return getPlayerEngine(player).kind === "web";
}

export function isInlinePlayer(player: VideoPlayer): boolean {
  return getPlayerEngine(player).kind !== "managed-external";
}

export function isManagedExternalPlayer(player: VideoPlayer): boolean {
  return getPlayerEngine(player).kind === "managed-external";
}
